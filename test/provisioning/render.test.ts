import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ValidationError, buildManifest, checkAgainst, renderAll, validateManifest } from "../../src/provisioning/render.js";
import { ROOT } from "../helpers.js";

const GROUPS: string[] = JSON.parse(readFileSync(`${ROOT}/data/directory/groups.json`, "utf8")).groups.map((g: any) => g.group_id);
const ROLES = new Set(["member", "team_lead", "platform_admin"]);
const CAPS = ["usage-connector", "web-search", "code-execution"];
const spec = (env: string) => parse(readFileSync(`${ROOT}/environments/${env}.yaml`, "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "render-"));
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function build(env: string, mutate: (s: any) => void = () => {}) {
  const s = structuredClone(spec(env));
  mutate(s);
  const m = buildManifest(env, s, GROUPS);
  validateManifest(env, m, ROLES, GROUPS, CAPS);
  return m;
}

describe("manifest", () => {
  it("prod defaults are normalised per group", () => {
    const m = build("prod");
    const on = Object.entries(m.capability_defaults["usage-connector"]!).filter(([, v]) => v).map(([g]) => g).sort();
    expect(on).toEqual(["clinical-operations", "it-platform"]);
    expect(Object.values(m.capability_defaults["code-execution"]!).some(Boolean)).toBe(false);
    expect(m.scopes["capabilities:write"]!.roles).toEqual(["platform_admin"]);
  });

  it("dev and staging differences are preserved", () => {
    expect(build("dev").scopes["usage:read"]!.group_visibility).toBe("all");
    expect(build("dev").scopes["usage:read"]!.roles).toContain("member");
    expect(build("staging").scopes["usage:read"]!.group_visibility).toBe("own_group");
    expect(Object.values(build("dev").capability_defaults["code-execution"]!).every(Boolean)).toBe(true);
    expect(Object.values(build("staging").capability_defaults["code-execution"]!).some(Boolean)).toBe(false);
  });

  it("writes are never wider than own group for non-admins", () => {
    for (const env of ["dev", "staging", "prod"]) expect(build(env).scopes["capabilities:write"]!.group_visibility).toBe("own_group");
  });
});

describe("environment file shape", () => {
  it("names the field when an environment file is malformed", () => {
    expect(() => build("prod", (s) => delete s.host)).toThrow(/prod.*host/);
    expect(() => build("prod", (s) => (s.scopes["usage:read"].group_visibility = "everyone"))).toThrow(/group_visibility/);
    expect(() => build("staging", (s) => delete s.scopes["capabilities:write"])).toThrow(/capabilities:write/);
  });
});

describe("validation", () => {
  it("prod rejects visibility 'all'", () => {
    expect(() => build("prod", (s) => (s.scopes["usage:read"].group_visibility = "all"))).toThrow(/only allowed in dev/);
  });
  it("prod rejects team-lead writes and member reads", () => {
    expect(() => build("prod", (s) => (s.scopes["capabilities:write"].roles = ["team_lead", "platform_admin"]))).toThrow(/only platform admins/);
    expect(() => build("prod", (s) => (s.scopes["usage:read"].roles = ["member", "team_lead", "platform_admin"]))).toThrow(/members may not/);
  });
  it("rejects an unknown role, an unknown default and groups outside the directory", () => {
    expect(() => build("staging", (s) => (s.scopes["usage:read"].roles = ["team_lead", "ceo"]))).toThrow(/unknown role/);
    expect(() => build("prod", (s) => (s.capability_defaults["web-search"] = "maybe"))).toThrow(ValidationError);
    expect(() => build("prod", (s) => (s.capability_defaults["web-search"] = { enabled_for: ["atlantis"] }))).toThrow(/do not cover/);
  });
  it("a role that can write must be able to read", () => {
    expect(() => build("staging", (s) => (s.scopes["capabilities:write"].roles = ["member", "platform_admin"]))).toThrow(/cannot read/);
  });
  it("capability names come from the contract, not the schema file", () => {
    const schemaText = readFileSync(`${ROOT}/provisioning/permissions.schema.json`, "utf8");
    for (const cap of CAPS) expect(schemaText).not.toContain(cap);
  });
  it("a capability not in the contract is rejected", () => {
    const m = build("prod");
    m.capability_defaults["crypto-mining"] = Object.fromEntries(GROUPS.map((g) => [g, true]));
    expect(() => validateManifest("prod", m, ROLES, GROUPS, CAPS)).toThrow(/crypto-mining/);
  });
});

describe("rendering", () => {
  it("renders every host config for every environment", () => {
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    for (const [env, name] of [["dev", "meridian-usage-dev"], ["staging", "meridian-usage-staging"], ["prod", "meridian-usage"]] as const) {
      const d = `${out}/${env}`;
      expect(json(`${d}/permissions.json`).server_name).toBe(name);
      expect(json(`${d}/claude-desktop.json`).mcpServers).toHaveProperty(name);
      expect(json(`${d}/gemini-settings.json`).mcpServers).toHaveProperty(name);
      expect(json(`${d}/claude-plugin/.mcp.json`).mcpServers).toHaveProperty(name);
      expect(existsSync(`${d}/claude-plugin/skills/meridian-usage/SKILL.md`)).toBe(true);
      const ext = json(`${d}/gemini-extension/gemini-extension.json`);
      expect(ext.name).toBe(`meridian-usage-${env}`);
      expect(ext.mcpServers).toHaveProperty(name);
    }
  });

  it("local hosts launch the self-contained bundle", () => {
    const out = tmp();
    renderAll(out, "/opt/m");
    for (const f of ["claude-desktop.json", "gemini-settings.json"]) {
      const [srv] = Object.values(json(`${out}/prod/${f}`).mcpServers) as any[];
      expect(srv.args).toEqual(["/opt/m/bundle/server.mjs"]);
    }
  });

  it("the plugin manifest has an author and asks for the identity", () => {
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    const pj = json(`${out}/prod/claude-plugin/.claude-plugin/plugin.json`);
    expect(pj.author.name).toBeTruthy();
    expect(pj.userConfig.meridian_user.required).toBe(true);
  });

  it("builds a Claude Desktop extension manifest per environment", () => {
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    for (const [env, name] of [["dev", "meridian-usage-dev"], ["prod", "meridian-usage"]] as const) {
      const mf = json(`${out}/${env}/claude-desktop-extension/manifest.json`);
      expect(mf).toMatchObject({ manifest_version: "0.3", name, server: { type: "node" } });
      expect(mf.server.mcp_config.args).toEqual(["${__dirname}/server/index.mjs"]);
      expect(mf.server.mcp_config.env).toMatchObject({ MERIDIAN_USER: "${user_config.meridian_user}", MERIDIAN_ENV: env });
      expect(mf.user_config.meridian_user.required).toBe(true);
      expect(mf.tools.map((t: any) => t.name).sort()).toEqual(["capability_status", "set_capability", "top_users", "usage_summary"]);
    }
  });

  it("rendering one environment leaves the others alone; unknown environments are rejected", () => {
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    const dev = readFileSync(`${out}/dev/permissions.json`, "utf8");
    writeFileSync(`${out}/prod/permissions.json`, "stale");
    renderAll(out, "${INSTALL_ROOT}", ["prod"]);
    expect(json(`${out}/prod/permissions.json`).environment).toBe("prod");
    expect(readFileSync(`${out}/dev/permissions.json`, "utf8")).toBe(dev);
    expect(() => renderAll(tmp(), "${INSTALL_ROOT}", ["qa"])).toThrow(/unknown environment/);
  });

  it("the drift check detects hand edits", () => {
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    expect(checkAgainst(out, "${INSTALL_ROOT}")).toEqual([]);
    const p = `${out}/prod/permissions.json`;
    const m = json(p);
    m.scopes["capabilities:write"]!.roles.push("team_lead");
    writeFileSync(p, JSON.stringify(m));
    expect(checkAgainst(out, "${INSTALL_ROOT}").some((d) => d.includes("prod/permissions.json"))).toBe(true);
  });
});


describe("command line", () => {
  const cli = (...args: string[]) => spawnSync("npx", ["tsx", "src/provisioning/render.ts", ...args], { cwd: ROOT, encoding: "utf8" });

  it("--check passes on the committed dist/ and fails on a hand edit", () => {
    expect(cli("--check").status).toBe(0);
    const out = tmp();
    renderAll(out, "${INSTALL_ROOT}");
    const p = `${out}/dev/permissions.json`;
    writeFileSync(p, readFileSync(p, "utf8").replace("dev", "devx"));
    expect(checkAgainst(out, "${INSTALL_ROOT}").length).toBeGreaterThan(0);
  });

  it("--out with --env writes only that environment", () => {
    const out = tmp();
    const r = cli("--out", out, "--env", "prod");
    expect(r.status).toBe(0);
    expect(existsSync(`${out}/prod/permissions.json`)).toBe(true);
    expect(existsSync(`${out}/dev`)).toBe(false);
  });

  it("--install-root substitutes the path into local host configs", () => {
    const out = tmp();
    cli("--out", out, "--install-root", "/opt/m");
    expect(json(`${out}/prod/claude-desktop.json`).mcpServers["meridian-usage"].args).toEqual(["/opt/m/bundle/server.mjs"]);
  });

  it("exits non-zero on an unknown environment", () => {
    expect(cli("--env", "qa").status).not.toBe(0);
  });
});

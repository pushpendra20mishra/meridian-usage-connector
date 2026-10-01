// renders the permissions manifest + host configs per environment
// npm run render [-- --check | --out DIR --install-root PATH]
import _Ajv from "ajv/dist/2020.js";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

type Validate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
// ajv's 2020 build is a cjs module, depending on the loader the class is on .default or on the module
const Ajv = ((_Ajv as unknown as { default?: unknown }).default ?? _Ajv) as unknown as new (opts: object) => { compile(schema: object): Validate };
export const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const ENVS = ["dev", "staging", "prod"] as const;
const ALL_GROUPS_ROLES = ["platform_admin"];
export const PLACEHOLDER = "${INSTALL_ROOT}";

const TOOLS: Record<string, string> = {
  usage_summary: "Tokens and cost for one group over a period, split by platform.",
  top_users: "Users in one group ranked by total tokens over a period.",
  capability_status: "Which capabilities are enabled for a group.",
  set_capability: "Enable or disable a capability for a group (platform admins).",
};

export class ValidationError extends Error {}

const envSpec = z.object({
  environment: z.string(),
  scopes: z.object({
    "usage:read": z.object({ roles: z.array(z.string()), group_visibility: z.enum(["own_group", "all"]) }),
    "capabilities:write": z.object({ roles: z.array(z.string()) }),
  }),
  capability_defaults: z.record(z.union([z.enum(["enabled", "disabled"]), z.object({ enabled_for: z.array(z.string()) })])),
  host: z.object({ server_name: z.string() }),
});
const targetsFile = z.object({
  plugin: z.object({ name: z.string(), version: z.string(), description: z.string(), author: z.string() }),
  environments: z.record(z.object({ service_url: z.string() })),
});
type EnvSpec = z.infer<typeof envSpec>;

function parseFile<T extends z.ZodTypeAny>(schema: T, input: unknown, where: string): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  throw new ValidationError(`${where}: ${i.path.join(".") || "<root>"}: ${i.message}`);
}

export interface Manifest {
  schema_version: 1;
  environment: string;
  server_name: string;
  scopes: Record<string, { roles: string[]; group_visibility: "own_group" | "all"; all_groups_roles: string[] }>;
  capability_defaults: Record<string, Record<string, boolean>>;
}

export function buildManifest(env: string, rawSpec: unknown, groupIds: string[]): Manifest {
  const spec: EnvSpec = parseFile(envSpec, rawSpec, env);
  const read = spec.scopes["usage:read"];
  const write = spec.scopes["capabilities:write"];
  const defaults: Manifest["capability_defaults"] = {};
  for (const [cap, val] of Object.entries(spec.capability_defaults)) {
    let on: Set<string>;
    if (val === "enabled") on = new Set(groupIds);
    else if (val === "disabled") on = new Set();
    else {
      on = new Set(val.enabled_for);
      const unknown = [...on].filter((g) => !groupIds.includes(g)).sort();
      if (unknown.length) throw new ValidationError(`${env}: ${cap} enabled_for lists groups that do not cover the directory: ${JSON.stringify(unknown)}`);
    }
    defaults[cap] = Object.fromEntries(groupIds.map((g) => [g, on.has(g)]));
  }
  return {
    schema_version: 1,
    environment: spec.environment,
    server_name: spec.host.server_name,
    scopes: {
      "usage:read": { roles: [...read.roles].sort(), group_visibility: read.group_visibility, all_groups_roles: ALL_GROUPS_ROLES },
      // env files say who can write, not where. non-admins stay on their own group
      "capabilities:write": { roles: [...write.roles].sort(), group_visibility: "own_group", all_groups_roles: ALL_GROUPS_ROLES },
    },
    capability_defaults: defaults,
  };
}

const subset = (a: string[], b: string[]) => a.every((x) => b.includes(x));

export function validateManifest(env: string, m: Manifest, directoryRoles: Set<string>, groupIds: string[], contractCaps: string[]): void {
  const schema = JSON.parse(readFileSync(`${ROOT}/provisioning/permissions.schema.json`, "utf8"));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const errs: string[] = [];
  if (!validate(m)) for (const e of validate.errors ?? []) errs.push(`${env}: ${e.instancePath || "<root>"}: ${e.message}`);
  if (env !== m.environment) errs.push(`${env}: file declares environment ${JSON.stringify(m.environment)}`);
  const expectedName = env === "prod" ? "meridian-usage" : `meridian-usage-${env}`;
  if (m.server_name !== expectedName) errs.push(`${env}: server_name ${JSON.stringify(m.server_name)} != ${JSON.stringify(expectedName)}`);
  for (const [scope, s] of Object.entries(m.scopes)) {
    for (const role of [...s.roles, ...s.all_groups_roles]) if (!directoryRoles.has(role)) errs.push(`${env}: ${scope} references unknown role ${JSON.stringify(role)}`);
  }
  const declared = Object.keys(m.capability_defaults);
  const diff = [...declared.filter((c) => !contractCaps.includes(c)), ...contractCaps.filter((c) => !declared.includes(c))].sort();
  if (diff.length) errs.push(`${env}: capabilities differ from contracts/tools.schema.json: ${JSON.stringify(diff)}`);
  for (const [cap, perGroup] of Object.entries(m.capability_defaults)) {
    const keys = Object.keys(perGroup);
    if (keys.length !== groupIds.length || !subset(keys, groupIds)) errs.push(`${env}: ${cap} defaults do not cover exactly the directory's groups`);
  }
  const read = m.scopes["usage:read"]!;
  const write = m.scopes["capabilities:write"]!;
  if (!subset(write.roles, read.roles)) errs.push(`${env}: a role may write controls it cannot read`);
  if (env !== "dev" && read.group_visibility === "all") errs.push(`${env}: usage:read group_visibility 'all' is only allowed in dev`);
  if (env === "prod" && !subset(write.roles, ALL_GROUPS_ROLES)) errs.push("prod: only platform admins may hold capabilities:write");
  if (env === "prod" && read.roles.includes("member")) errs.push("prod: members may not hold usage:read");
  if (errs.length) throw new ValidationError(errs.join("\n"));
}

const IDENTITY_DESCRIPTION = "Directory user this connector runs as (simulated identity).";

interface Plugin { name: string; version: string; description: string; author: string }

class Host {
  readonly name: string;
  readonly serviceUrl: string;
  constructor(readonly env: string, readonly m: Manifest, target: { service_url: string }, readonly plugin: Plugin, readonly root: string) {
    this.name = m.server_name;
    this.serviceUrl = target.service_url;
  }
  serverEnv(perms: string, directory: string, user: string) {
    return { MERIDIAN_ENV: this.env, MERIDIAN_SERVICE_URL: this.serviceUrl, MERIDIAN_PERMISSIONS: perms, MERIDIAN_DIRECTORY: directory, MERIDIAN_USER: user };
  }
  localEnv(user = "REPLACE_WITH_USER_EMAIL") {
    return this.serverEnv(`${this.root}/dist/${this.env}/permissions.json`, `${this.root}/data/directory`, user);
  }
  packagedEnv(base: string, user: string) {
    return this.serverEnv(`${base}/permissions.json`, `${base}/directory`, user);
  }
  get description() {
    return `${this.plugin.description} (${this.env})`;
  }
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

const stdio = (h: Host, args: string[], env: object, extra: object = {}) => ({ mcpServers: { [h.name]: { command: "node", args, env, ...extra } } });
const identityPrompt = () => ({ type: "string", title: "Your Meridian email", description: IDENTITY_DESCRIPTION, required: true });

function renderClaudeDesktop(h: Host, d: string) {
  writeJson(`${d}/claude-desktop.json`, stdio(h, [`${h.root}/bundle/server.mjs`], h.localEnv()));
}

function renderGeminiSettings(h: Host, d: string) {
  writeJson(`${d}/gemini-settings.json`, stdio(h, [`${h.root}/bundle/server.mjs`], h.localEnv(), { timeout: 15000 }));
}

// server/index.mjs gets added by make package
function renderClaudePlugin(h: Host, d: string) {
  const cp = `${d}/claude-plugin`;
  writeJson(`${cp}/.claude-plugin/plugin.json`, {
    name: h.plugin.name, version: h.plugin.version, description: h.description,
    author: { name: h.plugin.author }, userConfig: { meridian_user: identityPrompt() },
  });
  const base = "${CLAUDE_PLUGIN_ROOT}";
  writeJson(`${cp}/.mcp.json`, stdio(h, [`${base}/server/index.mjs`], h.packagedEnv(base, "${user_config.meridian_user}")));
  writeJson(`${cp}/permissions.json`, h.m);
  cpSync(`${ROOT}/plugin-src/skills`, `${cp}/skills`, { recursive: true });
}

function renderDesktopExtension(h: Host, d: string) {
  const de = `${d}/claude-desktop-extension`;
  writeJson(`${de}/manifest.json`, {
    manifest_version: "0.3", name: h.name, display_name: `Meridian usage (${h.env})`,
    version: h.plugin.version, description: h.plugin.description, author: { name: h.plugin.author },
    server: {
      type: "node", entry_point: "server/index.mjs",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"], env: h.packagedEnv("${__dirname}", "${user_config.meridian_user}") },
    },
    tools: Object.entries(TOOLS).map(([name, description]) => ({ name, description })),
    user_config: { meridian_user: identityPrompt() },
    compatibility: { platforms: ["darwin", "win32", "linux"] },
  });
  writeJson(`${de}/permissions.json`, h.m);
}

function renderGeminiExtension(h: Host, d: string) {
  const ge = `${d}/gemini-extension`;
  const base = "${extensionPath}";
  writeJson(`${ge}/gemini-extension.json`, {
    name: `${h.plugin.name}-${h.env}`, version: h.plugin.version, description: h.description, contextFileName: "GEMINI.md",
    settings: [{ name: "Your Meridian email", description: IDENTITY_DESCRIPTION, envVar: "MERIDIAN_USER" }],
    ...stdio(h, [`${base}/server/index.mjs`], h.packagedEnv(base, "$MERIDIAN_USER"), { cwd: base }),
  });
  writeJson(`${ge}/permissions.json`, h.m);
  cpSync(`${ROOT}/plugin-src/GEMINI.md`, `${ge}/GEMINI.md`);
}

const HOST_RENDERERS = [renderClaudeDesktop, renderGeminiSettings, renderClaudePlugin, renderDesktopExtension, renderGeminiExtension];

function renderEnv(env: string, m: Manifest, target: { service_url: string }, plugin: Plugin, out: string, root: string) {
  const d = `${out}/${env}`;
  writeJson(`${d}/permissions.json`, m);
  const host = new Host(env, m, target, plugin, root);
  for (const render of HOST_RENDERERS) render(host, d);
}

function loadInputs() {
  const json = (p: string) => JSON.parse(readFileSync(`${ROOT}/${p}`, "utf8"));
  return {
    groupIds: (json("data/directory/groups.json").groups as { group_id: string }[]).map((g) => g.group_id),
    roles: new Set(Object.keys(json("data/directory/users.json").roles)),
    contractCaps: json("contracts/tools.schema.json").$defs.Capability.enum as string[],
    targets: parseFile(targetsFile, parse(readFileSync(`${ROOT}/provisioning/targets.yaml`, "utf8")), "targets.yaml"),
    specs: (env: string) => parse(readFileSync(`${ROOT}/environments/${env}.yaml`, "utf8")) as unknown,
  };
}

export function renderAll(out: string, root: string, only?: string[]): void {
  const { groupIds, roles, contractCaps, targets, specs } = loadInputs();

  const unknown = (only ?? []).filter((e) => !(ENVS as readonly string[]).includes(e));
  if (unknown.length) throw new ValidationError(`unknown environment(s): ${JSON.stringify(unknown.sort())}`);

  // validate all three even for --env, the name check needs them
  const manifests = new Map<string, Manifest>();
  for (const env of ENVS) {
    const m = buildManifest(env, specs(env), groupIds);
    validateManifest(env, m, roles, groupIds, contractCaps);
    manifests.set(env, m);
  }
  const names = [...manifests.values()].map((m) => m.server_name);
  if (new Set(names).size !== names.length) throw new ValidationError("server names collide across environments");

  for (const [env, m] of manifests) {
    if (only?.length && !only.includes(env)) continue;
    rmSync(`${out}/${env}`, { recursive: true, force: true });
    renderEnv(env, m, targets.environments[env]!, targets.plugin, out, root);
  }
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]));
}

export function checkAgainst(committed: string, root: string): string[] {
  const fresh = mkdtempSync(join(tmpdir(), "render-fresh-"));
  try {
    renderAll(fresh, root);
    if (!existsSync(committed)) return [`${committed} missing`];
    const want = new Set(files(fresh));
    const have = new Set(files(committed));
    return [
      ...[...want].filter((f) => !have.has(f)).map((f) => `missing: ${join(committed, f)}`),
      ...[...have].filter((f) => !want.has(f)).map((f) => `unexpected: ${join(committed, f)}`),
      ...[...want].filter((f) => have.has(f) && readFileSync(join(fresh, f), "utf8") !== readFileSync(join(committed, f), "utf8")).map((f) => `differs: ${join(committed, f)}`),
    ];
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const root = arg("--install-root") ?? PLACEHOLDER;
  const only = argv.flatMap((a, i) => (a === "--env" ? [argv[i + 1]!] : []));
  try {
    if (argv.includes("--check")) {
      const diffs = checkAgainst(`${ROOT}/dist`, root);
      if (diffs.length) {
        console.error("dist/ is out of date or hand-edited (run `npm run render`):");
        for (const d of diffs) console.error(`  ${d}`);
        return 1;
      }
      console.log("dist/ matches a fresh render");
      return 0;
    }
    const out = arg("--out") ?? `${ROOT}/dist`;
    renderAll(out, root, only);
    console.log(`rendered ${only.length ? only.join(", ") : ENVS.join(", ")} -> ${out}; validation passed`);
    return 0;
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`validation failed:\n${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

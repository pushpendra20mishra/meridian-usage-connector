import { readFileSync } from "node:fs";
import _Ajv from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpServiceClient } from "../../src/connector/service.js";
import { type Env, ROOT, connect, text } from "./helpers.js";
import { type RunningService, startService } from "./service-process.js";

interface Case {
  env: Env;
  user: string;
  tool: string;
  args: Record<string, unknown>;
  expect: "allow" | "deny";
  denied_by?: "scope" | "visibility" | "capability_gate";
}
const cases: Case[] = JSON.parse(readFileSync(`${ROOT}/contracts/policy-matrix.json`, "utf8")).cases;
const Ajv: any = (_Ajv as any).default ?? _Ajv;
const addFormats: any = (_addFormats as any).default ?? _addFormats;
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(`${ROOT}/contracts/tools.schema.json`, "utf8")), "c");
const PORTS: Record<Env, number> = { dev: 18081, staging: 18082, prod: 18083 };

describe.each(["dev", "staging", "prod"] as Env[])("matrix on %s", (env) => {
  let svc: RunningService;
  beforeAll(async () => {
    svc = await startService(env, PORTS[env]);
  }, 30_000);
  afterAll(() => svc?.stop());

  it.each(cases.filter((c) => c.env === env))("$user $tool $args -> $expect $denied_by", async (c) => {
    const client = await connect(env, c.user, new HttpServiceClient(svc.url, c.user));
    const args = c.tool === "capability_status" || c.tool === "set_capability" ? c.args : { period: "2026-08", ...c.args };
    const r = await client.callTool({ name: c.tool, arguments: args });
    if (c.expect === "allow") {
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      const ok = ajv.validate({ $ref: `c#/tools/${c.tool}/output` }, text(r));
      expect(ok, JSON.stringify(ajv.errors)).toBe(true);
      return;
    }
    expect(r.isError).toBe(true);
    const body = text(r);
    expect(ajv.validate({ $ref: "c#/$defs/Denial" }, body), JSON.stringify(ajv.errors)).toBe(true);
    expect(body.error).toBe("permission_denied");
    expect(body.reason).toBeTruthy();
    if (c.denied_by === "scope") expect(body.required_scope).toMatch(/^(usage:read|capabilities:write)$/);
    if (c.denied_by === "capability_gate") expect(body.reason).toContain("usage-connector");
    expect(JSON.stringify(r)).not.toMatch(/total_tokens|cost_usd/);
  });
});

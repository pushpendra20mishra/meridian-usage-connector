import { readFileSync } from "node:fs";
import _Ajv from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { FakeService, ROOT, allEnabled, connect, text } from "./helpers.js";

const LEAD = "priya.nair@meridianls.example";
const ADMIN = "chloe.dubois@meridianls.example";
const FIN_LEAD = "sofia.rossi@meridianls.example";
const Ajv: typeof _Ajv = (_Ajv as any).default ?? _Ajv;
const addFormats: (a: any) => any = (_addFormats as any).default ?? _addFormats;
const contract = JSON.parse(readFileSync(`${ROOT}/contracts/tools.schema.json`, "utf8"));

const summary = {
  group: "clinical-operations",
  period: { start: "2026-08-01", end_exclusive: "2026-09-01" },
  platforms: [
    { platform: "claude", requests: 10, input_tokens: 1, output_tokens: 2, total_tokens: 3, cost_usd: 1.5 },
    { platform: "gemini", requests: null, input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0.5 },
  ],
  totals: { total_tokens: 5, cost_usd: 2 },
};
const happy = (method: string, path: string) => {
  if (path.startsWith("/api/v1/capabilities/self")) return allEnabled();
  if (path.startsWith("/api/v1/usage/summary")) return { status: 200, body: summary };
  return { status: 200, body: [] };
};

describe("tool surface", () => {
  it("exposes exactly the four contract tools, with annotations and tight schemas", async () => {
    const c = await connect("prod", LEAD, new FakeService(happy));
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["capability_status", "set_capability", "top_users", "usage_summary"]);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations?.readOnlyHint).toBe(t.name !== "set_capability");
      expect(t.annotations?.destructiveHint).toBe(false);
    }
    for (const t of tools.filter((t) => ["usage_summary", "top_users"].includes(t.name))) {
      expect((t.inputSchema.properties as any).period.description).toMatch(/2026-09-28.*2026-08/);
    }
    const top = tools.find((t) => t.name === "top_users")!;
    expect((top.inputSchema.properties as any).limit).toMatchObject({ minimum: 1, maximum: 25 });
    expect((tools.find((t) => t.name === "usage_summary")!.inputSchema.properties as any).group.enum).toHaveLength(6);
  });
});

describe("allowed reads", () => {
  it("usage_summary returns contract-shaped data for the caller's own group by default", async () => {
    const svc = new FakeService(happy);
    const c = await connect("prod", LEAD, svc);
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBeFalsy();
    const body = text(r);
    const ajv = new (Ajv as any)({ strict: false });
    addFormats(ajv);
    ajv.addSchema(contract, "c");
    expect(ajv.validate({ $ref: "c#/tools/usage_summary/output" }, body), JSON.stringify(ajv.errors)).toBe(true);
    expect(r.structuredContent).toEqual(body);
    expect(svc.calls.at(-1)!.path).toContain("group=clinical-operations");
  });

  it("array results keep the contract shape in text and are wrapped for structuredContent", async () => {
    const c = await connect("prod", LEAD, new FakeService(happy));
    const r = await c.callTool({ name: "top_users", arguments: { period: "2026-08", limit: 3 } });
    expect(Array.isArray(text(r))).toBe(true);
    expect(r.structuredContent).toEqual({ results: text(r) });
  });
});

describe("denials are structured, final, and make no data call", () => {
  it("cross-group read by a team lead", async () => {
    const svc = new FakeService(happy);
    const c = await connect("prod", LEAD, svc);
    for (const name of ["usage_summary", "top_users", "capability_status"]) {
      const r = await c.callTool({ name, arguments: { period: "2026-08", group: "finance" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatchObject({ error: "permission_denied", required_scope: "usage:read" });
      expect(JSON.stringify(r)).not.toMatch(/total_tokens|cost_usd/);
    }
    expect(svc.calls.filter((c) => c.path.startsWith("/api/v1/usage"))).toEqual([]);
    expect(svc.calls.filter((c) => c.path.startsWith("/api/v1/capabilities?"))).toEqual([]);
  });

  it("write by a team lead in prod", async () => {
    const svc = new FakeService(happy);
    const c = await connect("prod", LEAD, svc);
    const r = await c.callTool({ name: "set_capability", arguments: { group: "clinical-operations", capability: "web-search", enabled: false } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ error: "permission_denied", required_scope: "capabilities:write" });
    expect(svc.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("usage-connector disabled for the caller's group denies every tool", async () => {
    const off = (m: string, p: string) =>
      p.startsWith("/api/v1/capabilities/self")
        ? { status: 200, body: [{ group: "finance", capability: "usage-connector", enabled: false, updated_at: null, updated_by: null }] }
        : happy(m, p);
    const svc = new FakeService(off);
    const c = await connect("staging", FIN_LEAD, svc);
    for (const name of ["usage_summary", "top_users", "capability_status"]) {
      const r = await c.callTool({ name, arguments: { period: "2026-08" } });
      expect(r.isError).toBe(true);
      expect(text(r).error).toBe("permission_denied");
      expect(text(r).reason).toContain("usage-connector");
    }
    expect(svc.calls.every((c) => c.path.startsWith("/api/v1/capabilities/self"))).toBe(true);
  });

  it("a suspended account is reported as such, not as a disabled connector", async () => {
    const suspended = { error: "permission_denied", reason: "your account is suspended by a platform admin" };
    const svc = new FakeService((_m, p) => (p.includes("/self") ? { status: 403, body: suspended } : happy(_m, p)));
    const c = await connect("prod", LEAD, svc);
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toEqual(suspended);
    expect(svc.calls.every((x) => x.path.includes("/self"))).toBe(true); // no data request
  });

  it("a missing usage-connector row is treated as disabled", async () => {
    const c = await connect("staging", LEAD, new FakeService((m, p) => (p.includes("/self") ? { status: 200, body: [] } : happy(m, p))));
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBe(true);
  });

  it("denial text cannot be talked around: the same call is denied every time", async () => {
    const c = await connect("prod", LEAD, new FakeService(happy));
    const args = { period: "last_30_days", group: "hr", limit: 25 };
    const a = await c.callTool({ name: "top_users", arguments: args });
    const b = await c.callTool({ name: "top_users", arguments: args });
    expect(text(a)).toEqual(text(b));
  });
});

describe("strict clients (those that list tools first, then validate structured output)", () => {
  it("still receive denials and errors as ordinary error results", async () => {
    const lead = await connect("prod", LEAD, new FakeService(happy));
    await lead.listTools(); // strict clients validate after this
    const denied = await lead.callTool({ name: "usage_summary", arguments: { group: "finance", period: "2026-08" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatchObject({ error: "permission_denied", required_scope: "usage:read" });
    const write = await lead.callTool({ name: "set_capability", arguments: { group: "clinical-operations", capability: "web-search", enabled: false } });
    expect(text(write).error).toBe("permission_denied");
    const down = await connect("prod", LEAD, { request: async () => { throw new Error("ECONNREFUSED"); } });
    await down.listTools();
    const r = await down.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(text(r).error).toBe("service_unavailable");
  });
  it("successful results still carry structured output that matches the schema", async () => {
    const c = await connect("prod", LEAD, new FakeService(happy));
    await c.listTools();
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(text(r));
  });
});

describe("admin write", () => {
  it("set_capability goes through for admins and returns the service's state", async () => {
    const state = { group: "hr", capability: "usage-connector", enabled: true, updated_at: "2026-09-30T10:00:00Z", updated_by: ADMIN };
    const svc = new FakeService((m, p) => (m === "PUT" ? { status: 200, body: state } : happy(m, p)));
    const c = await connect("prod", ADMIN, svc);
    const r = await c.callTool({ name: "set_capability", arguments: { group: "hr", capability: "usage-connector", enabled: true } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toEqual(state);
    expect(svc.calls.find((c) => c.method === "PUT")!.path).toBe("/api/v1/capabilities/hr/usage-connector");
  });
});

describe("failure handling is closed", () => {
  it("service errors become a structured error, never partial data", async () => {
    const c = await connect("prod", LEAD, new FakeService((m, p) => (p.includes("/self") ? allEnabled() : { status: 500, body: { detail: "boom" } })));
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBe(true);
    expect(text(r).error).toBe("service_error");
  });

  it("an unreachable service fails closed even for the gate lookup", async () => {
    const c = await connect("prod", LEAD, { request: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(r.isError).toBe(true);
    expect(text(r).error).toBe("service_unavailable");
  });

  it("a service-side 403 is passed through as the same denial shape", async () => {
    const denial = { error: "permission_denied", reason: "nope", required_scope: "usage:read" };
    const c = await connect("dev", LEAD, new FakeService((m, p) => (p.includes("/self") ? allEnabled() : { status: 403, body: denial })));
    const r = await c.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(text(r)).toEqual(denial);
  });

  it("rejects bad input at the schema, before any policy or service work", async () => {
    const svc = new FakeService(happy);
    const c = await connect("prod", LEAD, svc);
    const r = await c.callTool({ name: "top_users", arguments: { period: "whenever", limit: 99 } });
    expect(r.isError).toBe(true);
    expect(svc.calls).toEqual([]);
  });
});

describe("input schemas follow the contract", () => {
  it("enums, patterns and bounds come from contracts/tools.schema.json", async () => {
    const c = await connect("prod", LEAD, new FakeService(happy));
    const byName = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t.inputSchema.properties as any]));
    const defs = contract.$defs;
    for (const [name, props] of Object.entries(byName)) {
      const want = contract.tools[name].input.properties;
      expect(Object.keys(props).sort(), name).toEqual(Object.keys(want).sort());
      if (props.group) expect(props.group.enum, name).toEqual(defs.GroupId.enum);
      if (props.period) expect(props.period.pattern, name).toBe(defs.Period.pattern);
      if (props.capability) expect(props.capability.enum, name).toEqual(defs.Capability.enum);
    }
    expect(byName.top_users.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 25, default: 10 });
    expect(byName.set_capability.enabled.type).toBe("boolean");
  });
});

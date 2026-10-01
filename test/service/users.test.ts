import { describe, expect, it } from "vitest";
import { ADMIN, FIN_LEAD, LEAD, MEMBER, makeClient } from "./helpers.js";

type Client = Awaited<ReturnType<typeof makeClient>>;
const U = "/api/v1/admin/users";
const idOf = async (c: Client, email: string) =>
  (await c.get("/api/v1/identities")).json.users.find((u: any) => u.email === email).user_id as string;
const self = async (c: Client, who: string) => (await c.get("/api/v1/capabilities/self", who)).json;
const find = (rows: any[], cap: string) => rows.find((r) => r.capability === cap);

describe("usage drill-down for any user", () => {
  it("an admin sees one person's usage, from any group, with weeks and models", async () => {
    const c = await makeClient("prod");
    const finId = await idOf(c, FIN_LEAD);
    const r = await c.get(`${U}/${finId}/usage?period=2026-08`, ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ email: FIN_LEAD, role: "team_lead", group: "finance" });
    expect(r.json.platforms.map((p: any) => p.platform)).toEqual(["claude", "gemini"]);
    expect(r.json.weeks.length).toBeGreaterThan(0);
    expect(r.json.models.length).toBeGreaterThan(0);
    const row = (await c.get("/api/v1/usage/by-user?period=2026-08&group=finance", ADMIN)).json.find((x: any) => x.user_id === finId);
    expect(r.json.totals.total_tokens).toBe(row.total_tokens);
    expect(r.json.totals.cost_usd).toBe(row.cost_usd);
    expect(r.json.weeks.reduce((a: number, w: any) => a + w.total_tokens, 0)).toBe(row.total_tokens);
    expect(r.json.models.reduce((a: number, m: any) => a + m.total_tokens, 0)).toBe(row.total_tokens);
  });
  it("is admin-only", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, MEMBER);
    for (const who of [LEAD, FIN_LEAD, MEMBER]) expect((await c.get(`${U}/${id}/usage?period=2026-08`, who)).status).toBe(403);
    expect((await (await makeClient("staging")).get(`${U}/${id}/usage?period=2026-08`, LEAD)).status).toBe(403);
  });
  it("404 for an unknown user", async () => {
    expect((await (await makeClient("prod")).get(`${U}/user_nope/usage?period=2026-08`, ADMIN)).status).toBe(404);
  });
});

describe("per-user capability overrides", () => {
  it("an override beats the group setting for that user only, and clearing reverts", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, LEAD);
    expect(find(await self(c, LEAD), "usage-connector")).toMatchObject({ enabled: true, source: "group" });
    const set = await c.put(`${U}/${id}/capabilities/usage-connector`, ADMIN, { enabled: false });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ user_id: id, capability: "usage-connector", enabled: false, source: "user_override", group_enabled: true });
    expect(find(await self(c, LEAD), "usage-connector")).toMatchObject({ enabled: false, source: "user_override" });
    expect(find(await self(c, MEMBER), "usage-connector")).toMatchObject({ enabled: true, source: "group" });
    const cleared = await c.put(`${U}/${id}/capabilities/usage-connector`, ADMIN, { enabled: null });
    expect(cleared.json).toMatchObject({ enabled: true, source: "group" });
    expect(find(await self(c, LEAD), "usage-connector").source).toBe("group");
  });

  it("can also switch a capability ON for one user where the group has it off", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, FIN_LEAD);
    await c.put(`${U}/${id}/capabilities/usage-connector`, ADMIN, { enabled: true });
    expect(find(await self(c, FIN_LEAD), "usage-connector")).toMatchObject({ enabled: true, source: "user_override" });
  });

  it("lists a user's effective capabilities with their source", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, LEAD);
    await c.put(`${U}/${id}/capabilities/web-search`, ADMIN, { enabled: false });
    const rows = (await c.get(`${U}/${id}/capabilities`, ADMIN)).json;
    expect(rows.map((r: any) => r.capability)).toEqual(["usage-connector", "web-search", "code-execution"]);
    expect(find(rows, "web-search")).toMatchObject({ enabled: false, source: "user_override", group_enabled: true });
    expect(find(rows, "usage-connector")).toMatchObject({ source: "group" });
  });

  it("is admin-only and validates its input", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, MEMBER);
    expect((await c.put(`${U}/${id}/capabilities/web-search`, LEAD, { enabled: false })).status).toBe(403);
    expect((await c.put(`${U}/${id}/capabilities/nuke`, ADMIN, { enabled: false })).status).toBe(422);
    expect((await c.put(`${U}/${id}/capabilities/web-search`, ADMIN, { enabled: "yes" })).status).toBe(422);
    expect((await c.put(`${U}/user_nope/capabilities/web-search`, ADMIN, { enabled: false })).status).toBe(404);
    expect(find(await self(c, MEMBER), "web-search").source).toBe("group");
  });

  it("persists across a restart and does not touch the group setting", async () => {
    const c = await makeClient("prod");
    await c.put(`${U}/${await idOf(c, LEAD)}/capabilities/usage-connector`, ADMIN, { enabled: false });
    const c2 = await c.restart();
    expect(find(await self(c2, LEAD), "usage-connector")).toMatchObject({ enabled: false, source: "user_override" });
    const group = (await c2.get("/api/v1/capabilities?group=clinical-operations", ADMIN)).json;
    expect(find(group, "usage-connector").enabled).toBe(true);
  });
});

describe("suspension", () => {
  it("a suspended user is refused everywhere; restoring brings them back", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, LEAD);
    const s = await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: true, reason: "left the project" });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ user_id: id, suspended: true, reason: "left the project", suspended_by: ADMIN });
    for (const url of ["/api/v1/me", "/api/v1/usage/summary?period=2026-08", "/api/v1/capabilities/self", "/api/v1/capabilities/matrix"]) {
      const r = await c.get(url, LEAD);
      expect(r.status, url).toBe(403);
      expect(r.json.error).toBe("permission_denied");
      expect(r.json.reason).toMatch(/suspended/i);
      expect(JSON.stringify(r.json)).not.toMatch(/total_tokens|cost_usd/);
    }
    expect((await c.get("/api/v1/me", MEMBER)).status).toBe(200);
    const back = await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: false });
    expect(back.json).toMatchObject({ suspended: false });
    expect((await c.get("/api/v1/me", LEAD)).status).toBe(200);
  });

  it("an admin cannot suspend themselves (no lock-out), nor can anyone else suspend", async () => {
    const c = await makeClient("prod");
    expect((await c.put(`${U}/${await idOf(c, ADMIN)}/suspension`, ADMIN, { suspended: true })).status).toBe(422);
    expect((await c.get("/api/v1/me", ADMIN)).status).toBe(200);
    expect((await c.put(`${U}/${await idOf(c, MEMBER)}/suspension`, LEAD, { suspended: true })).status).toBe(403);
    expect((await c.get("/api/v1/me", MEMBER)).status).toBe(200);
  });

  it("lists suspended users, persists across restart, and a suspended admin is also blocked", async () => {
    const c = await makeClient("prod");
    const other = "arjun.mehta@meridianls.example";
    const id = await idOf(c, other);
    await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: true, reason: "test" });
    const c2 = await c.restart();
    expect((await c2.get("/api/v1/me", other)).status).toBe(403);
    expect((await c2.get(`${U}/suspensions`, ADMIN)).json.map((s: any) => s.user_id)).toEqual([id]);
  });

  it("404 for an unknown user", async () => {
    expect((await (await makeClient("prod")).put(`${U}/user_nope/suspension`, ADMIN, { suspended: true })).status).toBe(404);
  });
});

describe("audit trail (one log for group switches and user actions)", () => {
  it("records overrides, clears and suspensions with who, what and when, newest first", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, LEAD);
    await c.put(`${U}/${id}/capabilities/web-search`, ADMIN, { enabled: false });
    await c.put(`${U}/${id}/capabilities/web-search`, ADMIN, { enabled: null });
    await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: true, reason: "why" });
    await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: false });
    const rows = (await c.get("/api/v1/admin/audit", ADMIN)).json;
    expect(rows.map((r: any) => r.action)).toEqual(["restored", "suspended", "override_cleared", "override_set"]);
    expect(rows[1]).toMatchObject({ user_id: id, user_name: "Priya Nair", group: "clinical-operations", detail: "why", changed_by: ADMIN });
    expect(rows[3]).toMatchObject({ capability: "web-search", detail: "off" });
    expect(rows[0].changed_at).toMatch(/Z$/);
    expect((await c.get("/api/v1/admin/audit", LEAD)).status).toBe(403);
  });

  it("interleaves group switches and user actions in the order they happened", async () => {
    const c = await makeClient("prod");
    const id = await idOf(c, LEAD);
    await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: true });
    await c.put("/api/v1/capabilities/finance/usage-connector", ADMIN, { enabled: true });
    await c.put(`${U}/${id}/suspension`, ADMIN, { suspended: false });
    expect((await c.get("/api/v1/admin/audit", ADMIN)).json.map((r: any) => r.action)).toEqual(["restored", "capability_set", "suspended"]);
  });

  it("the old separate user-audit endpoint is gone", async () => {
    expect((await (await makeClient("prod")).get(`${U}/audit`, ADMIN)).status).toBe(404);
  });
});

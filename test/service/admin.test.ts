import { describe, expect, it } from "vitest";
import { ADMIN, LEAD, MEMBER, makeClient } from "./helpers.js";

const CAPS = ["usage-connector", "web-search", "code-execution"];
const put = (c: Awaited<ReturnType<typeof makeClient>>, who: string, group: string, cap: string, enabled: boolean) =>
  c.put(`/api/v1/capabilities/${group}/${cap}`, who, { enabled });

describe("capability matrix", () => {
  it("admins see every group and capability", async () => {
    const body = (await (await makeClient("prod")).get("/api/v1/capabilities/matrix", ADMIN)).json;
    expect(body.capabilities).toEqual(CAPS);
    expect(body.groups).toHaveLength(6);
    const fin = body.groups.find((g: any) => g.group === "finance");
    expect(fin.capabilities["usage-connector"].enabled).toBe(false);
    expect(fin.capabilities["web-search"].enabled).toBe(true);
    expect(fin.can_write).toBe(true);
  });
  it("a lead sees only their own row, read-only in prod", async () => {
    const body = (await (await makeClient("prod")).get("/api/v1/capabilities/matrix", LEAD)).json;
    expect(body.groups.map((g: any) => g.group)).toEqual(["clinical-operations"]);
    expect(body.groups[0].can_write).toBe(false);
  });
  it("is denied without usage:read", async () => {
    const r = await (await makeClient("prod")).get("/api/v1/capabilities/matrix", MEMBER);
    expect(r.status).toBe(403);
    expect(r.json.required_scope).toBe("usage:read");
  });
  it("in dev, non-admins still get only their own group (not a firehose)", async () => {
    const body = (await (await makeClient("dev")).get("/api/v1/capabilities/matrix", MEMBER)).json;
    expect(body.groups.map((g: any) => g.group)).toEqual(["clinical-operations"]);
  });
});

describe("audit", () => {
  it("records who, what and when, newest first", async () => {
    const c = await makeClient("prod");
    await put(c, ADMIN, "finance", "usage-connector", true);
    await put(c, ADMIN, "hr", "web-search", false);
    const rows = (await c.get("/api/v1/admin/audit", ADMIN)).json;
    expect(rows.map((r: any) => [r.group, r.capability, r.detail])).toEqual([["hr", "web-search", "off"], ["finance", "usage-connector", "on"]]);
    expect(rows[0]).toMatchObject({ action: "capability_set", user_id: null, changed_by: ADMIN });
    expect(rows[0].changed_at).toMatch(/Z$/);
  });
  it("is denied without capabilities:write", async () => {
    const r = await (await makeClient("prod")).get("/api/v1/admin/audit", LEAD);
    expect(r.status).toBe(403);
    expect(r.json.required_scope).toBe("capabilities:write");
  });
  it("for a staging lead is limited to their own group", async () => {
    const c = await makeClient("staging");
    await put(c, ADMIN, "finance", "web-search", false);
    await put(c, LEAD, "clinical-operations", "code-execution", true);
    expect((await c.get("/api/v1/admin/audit", LEAD)).json.map((r: any) => r.group)).toEqual(["clinical-operations"]);
    expect((await c.get("/api/v1/admin/audit", ADMIN)).json).toHaveLength(2);
  });
  it("a staging lead never sees admin actions on individual users", async () => {
    const c = await makeClient("staging");
    const leadId = (await c.get("/api/v1/identities")).json.users.find((u: any) => u.email === LEAD).user_id;
    await c.put(`/api/v1/admin/users/${leadId}/capabilities/web-search`, ADMIN, { enabled: false });
    await put(c, LEAD, "clinical-operations", "code-execution", true);
    expect((await c.get("/api/v1/admin/audit", LEAD)).json.map((r: any) => r.action)).toEqual(["capability_set"]);
    expect((await c.get("/api/v1/admin/audit", ADMIN)).json.map((r: any) => r.action)).toEqual(["capability_set", "override_set"]);
  });
});

describe("data health", () => {
  it("is admin-only, even where leads can write", async () => {
    const c = await makeClient("staging");
    expect((await c.get("/api/v1/admin/data-health", LEAD)).status).toBe(403);
    const body = (await c.get("/api/v1/admin/data-health", ADMIN)).json;
    expect(body).toMatchObject({ data_end_exclusive: "2026-09-28", ingest_issues: 0 });
    expect(new Set(body.platforms.map((p: any) => p.platform))).toEqual(new Set(["claude", "gemini"]));
    expect(body.platforms.every((p: any) => p.rows > 0 && p.first_day && p.last_day)).toBe(true);
  });
});

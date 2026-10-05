import { describe, expect, it } from "vitest";
import { ADMIN, FIN_LEAD, LEAD, makeClient, raw } from "./helpers.js";

const SUMMARY = "/api/v1/usage/summary";

describe("identity", () => {
  it("requires a known directory user", async () => {
    const c = await makeClient("prod");
    expect((await c.get("/api/v1/me")).status).toBe(401);
    expect((await c.get("/api/v1/me", "nobody@x.example")).status).toBe(401);
  });
  it("/me reports effective access", async () => {
    const c = await makeClient("prod");
    const lead = (await c.get("/api/v1/me", LEAD)).json;
    expect(lead.readable_groups).toEqual(["clinical-operations"]);
    expect(lead.writable_groups).toEqual([]);
    const admin = (await c.get("/api/v1/me", ADMIN)).json;
    expect(admin.readable_groups).toHaveLength(6);
    expect(admin.writable_groups).toHaveLength(6);
    expect((await c.get("/api/v1/me", FIN_LEAD)).json.scopes).toEqual(["usage:read"]);
  });
});

describe("every protected endpoint refuses an unidentified caller", () => {
  const GETS = [
    "/api/v1/me", "/api/v1/usage?period=2026-08", "/api/v1/usage/summary?period=2026-08", "/api/v1/usage/top-users?period=2026-08",
    "/api/v1/usage/by-user?period=2026-08", "/api/v1/capabilities", "/api/v1/capabilities/matrix", "/api/v1/capabilities/self",
    "/api/v1/admin/audit", "/api/v1/admin/data-health", "/api/v1/admin/users/suspensions",
    "/api/v1/admin/users/user_x/usage?period=2026-08", "/api/v1/admin/users/user_x/capabilities",
  ];
  it.each(GETS)("GET %s -> 401 with no identity and with an unknown one", async (url) => {
    const c = await makeClient("prod");
    expect((await c.get(url)).status).toBe(401);
    expect((await c.get(url, "nobody@x.example")).status).toBe(401);
  });
  it.each([
    "/api/v1/capabilities/finance/web-search", "/api/v1/admin/users/user_x/suspension", "/api/v1/admin/users/user_x/capabilities/web-search",
  ])("PUT %s -> 401 with no identity", async (url) => {
    const c = await makeClient("prod");
    expect((await c.put(url, undefined, { enabled: true, suspended: true })).status).toBe(401);
  });
  it("only the identity list, health and the page are open", async () => {
    const c = await makeClient("prod");
    for (const url of ["/api/v1/identities", "/health"]) expect((await c.get(url)).status).toBe(200);
    expect((await c.app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(200);
  });
});

describe("the identity check cannot be skipped by how the path is written", () => {
  const send = async (c: Awaited<ReturnType<typeof makeClient>>, url: string, user?: string) => {
    const r = await c.app.inject({ method: "GET", url, headers: user ? { "x-meridian-user": user } : {} });
    return { status: r.statusCode, body: r.body };
  };
  const SPELLINGS = ["/%61pi/v1/usage/summary?period=2026-08", "/api/v1/usage/summary/?period=2026-08", "/api/%76%31/usage/summary?period=2026-08"];

  it.each(SPELLINGS)("%s with no identity is a clean 401, never a 500 or data", async (url) => {
    const r = await send(await makeClient("prod"), url);
    expect([401, 404]).toContain(r.status);
    expect(r.body).not.toMatch(/total_tokens|cost_usd/);
  });

  it("an encoded admin path with no identity is not reachable either", async () => {
    const r = await send(await makeClient("prod"), "/%61pi/v1/admin/audit");
    expect([401, 404]).toContain(r.status);
  });

  it("an encoded path with a team lead still gets the normal group check", async () => {
    const c = await makeClient("prod");
    const other = await send(c, "/%61pi/v1/usage/summary?period=2026-08&group=finance", LEAD);
    expect([403, 404]).toContain(other.status);
    expect(other.body).not.toMatch(/total_tokens|cost_usd/);
  });

  it("no route under /api/v1 ever answers 500 for a missing identity", async () => {
    const c = await makeClient("prod");
    for (const url of ["/api/v1/me", "/api/v1/capabilities/self", "/api/v1/admin/data-health", "/api/v1/admin/users/suspensions"]) {
      expect((await send(c, url)).status, url).toBe(401);
    }
  });
});

describe("identity switcher", () => {
  it("lists directory users, with no default unless configured", async () => {
    const body = (await (await makeClient("prod")).get("/api/v1/identities")).json;
    expect(body.users).toHaveLength(22);
    expect(body.users[0]).toHaveProperty("email");
    expect(body.default_user).toBeNull();
  });
  it("reports the configured default identity (used by the admin page instead of a URL parameter)", async () => {
    const c = await makeClient("prod", undefined, { uiDefaultUser: LEAD });
    expect((await c.get("/api/v1/identities")).json.default_user).toBe(LEAD);
  });
  it("ignores a default that is not in the directory", async () => {
    const c = await makeClient("prod", undefined, { uiDefaultUser: "ghost@nowhere.example" });
    expect((await c.get("/api/v1/identities")).json.default_user).toBeNull();
  });
});

describe("usage", () => {
  it("summary matches the raw cost rows for a group and month", async () => {
    const c = await makeClient("prod");
    const r = raw();
    const clin = r.groups.find((g: any) => g.group_id === "clinical-operations");
    const microCents = r.cost.data
      .filter((x: any) => x.rbac_group_id === clin.claude_rbac_group_id && x.starting_at.startsWith("2026-08"))
      .reduce((a: bigint, x: any) => a + BigInt(x.amount.replace(".", "")), 0n);
    const body = (await c.get(`${SUMMARY}?period=2026-08`, LEAD)).json;
    const claude = body.platforms.find((p: any) => p.platform === "claude");
    expect(Math.round(claude.cost_usd * 1e6)).toBe(Number((microCents + 50n) / 100n)); // 1e-6 cents -> 1e-6 USD
    expect(body.group).toBe("clinical-operations");
    expect(body.totals.total_tokens).toBe(body.platforms.reduce((a: number, p: any) => a + p.total_tokens, 0));
    expect(body.platforms.map((p: any) => p.platform)).toEqual(["claude", "gemini"]);
  });

  it("breaks down by week, and by group + platform (admins see all groups, leads their own)", async () => {
    const c = await makeClient("prod");
    const wk = (await c.get("/api/v1/usage?period=last_30_days&by=week", LEAD)).json;
    expect(wk.groups).toEqual(["clinical-operations"]);
    const weeks = wk.rows.map((r: any) => r.week);
    expect(weeks).toEqual([...weeks].sort());
    expect(wk.rows.every((r: any) => r.week_start)).toBe(true);
    const admin = (await c.get("/api/v1/usage?period=2026-09&by=group&by=platform", ADMIN)).json;
    expect(admin.groups).toHaveLength(6);
    expect(new Set(admin.rows.map((r: any) => r.group))).toEqual(new Set(admin.groups));
    const lead = (await c.get("/api/v1/usage?period=2026-09&by=group", LEAD)).json;
    expect(new Set(lead.rows.map((r: any) => r.group))).toEqual(new Set(["clinical-operations"]));
  });

  it("breakdown defaults to by platform", async () => {
    const c = await makeClient("prod");
    expect((await c.get("/api/v1/usage?period=2026-08", LEAD)).json.by).toEqual(["platform"]);
  });

  it("weeks sum to the period total", async () => {
    const c = await makeClient("prod");
    const weeks = (await c.get("/api/v1/usage?period=2026-08&by=week", LEAD)).json;
    const total = (await c.get(`${SUMMARY}?period=2026-08`, LEAD)).json;
    expect(weeks.rows.reduce((a: number, r: any) => a + r.total_tokens, 0)).toBe(total.totals.total_tokens);
  });

  it("top users are ranked, limited and scoped", async () => {
    const c = await makeClient("prod");
    const rows = (await c.get("/api/v1/usage/top-users?period=2026-08&limit=3", LEAD)).json;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r: any) => r.group))).toEqual(new Set(["clinical-operations"]));
    const toks = rows.map((r: any) => r.total_tokens);
    expect(toks).toEqual([...toks].sort((a: number, b: number) => b - a));
    expect((await c.get("/api/v1/usage/top-users?period=2026-08&limit=99", LEAD)).status).toBe(422);
  });

  it("flags a partial period", async () => {
    const c = await makeClient("prod");
    expect((await c.get(`${SUMMARY}?period=2026-09`, LEAD)).json.period.partial).toBe(true);
    expect((await c.get(`${SUMMARY}?period=2026-08`, LEAD)).json.period).not.toHaveProperty("partial");
  });

  it("rejects bad periods and unknown groups", async () => {
    const c = await makeClient("prod");
    expect((await c.get(`${SUMMARY}?period=2026-W99`, ADMIN)).status).toBe(422);
    expect((await c.get(`${SUMMARY}?period=2026-08&group=nope`, ADMIN)).status).toBe(422);
  });
});

describe("capabilities", () => {
  it("prod defaults: usage-connector off for finance, with null audit fields", async () => {
    const c = await makeClient("prod");
    const fin = (await c.get("/api/v1/capabilities?group=finance", ADMIN)).json;
    expect(Object.fromEntries(fin.map((r: any) => [r.capability, r.enabled]))).toEqual({
      "usage-connector": false, "web-search": true, "code-execution": false,
    });
    expect(fin.every((r: any) => r.updated_at === null && r.updated_by === null)).toBe(true);
  });

  it("set persists, is audited, and survives a restart", async () => {
    const c = await makeClient("prod");
    const r = await c.put("/api/v1/capabilities/finance/usage-connector", ADMIN, { enabled: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, updated_by: ADMIN });
    expect(r.json.updated_at).toMatch(/Z$/);
    const c2 = await c.restart();
    const fin = (await c2.get("/api/v1/capabilities?group=finance", ADMIN)).json;
    expect(fin.find((x: any) => x.capability === "usage-connector").enabled).toBe(true);
    expect((await c2.get("/api/v1/admin/audit", ADMIN)).json).toHaveLength(1);
  });

  it("a denied write changes nothing", async () => {
    const c = await makeClient("prod");
    const r = await c.put("/api/v1/capabilities/clinical-operations/web-search", LEAD, { enabled: false });
    expect(r.status).toBe(403);
    expect(r.json.required_scope).toBe("capabilities:write");
    const st = (await c.get("/api/v1/capabilities?group=clinical-operations", LEAD)).json;
    expect(st.find((x: any) => x.capability === "web-search").enabled).toBe(true);
  });

  it("rejects an unknown capability", async () => {
    const c = await makeClient("prod");
    expect((await c.put("/api/v1/capabilities/finance/nuke", ADMIN, { enabled: true })).status).toBe(422);
  });
});

describe("admin page", () => {
  it("loads its script from a separate file, served as JavaScript", async () => {
    const c = await makeClient("dev");
    const page = await c.app.inject({ method: "GET", url: "/admin" });
    expect(page.body).toContain('<script src="/admin.js"');
    expect(page.body).not.toContain("async function loadAll"); // the logic is no longer inline
    const js = await c.app.inject({ method: "GET", url: "/admin.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.body).toContain("async function loadAll");
  });

  it("is served", async () => {
    const c = await makeClient("dev");
    const r = await c.app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Meridian AI usage");
  });
});

describe("usage by user (every member of the group)", () => {
  const BY_USER = "/api/v1/usage/by-user";

  it("lists every member of the group with per-platform usage, biggest first", async () => {
    const c = await makeClient("prod");
    const rows = (await c.get(`${BY_USER}?period=2026-08`, LEAD)).json;
    expect(rows.map((r: any) => r.name).sort()).toEqual(["Aisha Rahman", "Daniel Okafor", "Priya Nair", "Tomasz Kowalski"]);
    const toks = rows.map((r: any) => r.total_tokens);
    expect(toks).toEqual([...toks].sort((a: number, b: number) => b - a));
    for (const r of rows) {
      expect(r.claude.total_tokens + r.gemini.total_tokens).toBe(r.total_tokens);
      expect(Math.round((r.claude.cost_usd + r.gemini.cost_usd) * 1e6)).toBe(Math.round(r.cost_usd * 1e6));
    }
  });

  it("totals agree with the group summary", async () => {
    const c = await makeClient("prod");
    const rows = (await c.get(`${BY_USER}?period=2026-08`, LEAD)).json;
    const summary = (await c.get(`${SUMMARY}?period=2026-08`, LEAD)).json;
    expect(rows.reduce((a: number, r: any) => a + r.total_tokens, 0)).toBe(summary.totals.total_tokens);
  });

  it("still lists members who have no usage in the period", async () => {
    const c = await makeClient("prod");
    const rows = (await c.get(`${BY_USER}?period=2026-01`, LEAD)).json;
    expect(rows).toHaveLength(4);
    expect(rows.every((r: any) => r.total_tokens === 0 && r.cost_usd === 0)).toBe(true);
  });

  it("is scoped like every other read: a lead cannot list another group; an admin can", async () => {
    const c = await makeClient("prod");
    const denied = await c.get(`${BY_USER}?period=2026-08&group=finance`, LEAD);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.json)).not.toMatch(/Sofia|total_tokens/);
    const ok = await c.get(`${BY_USER}?period=2026-08&group=finance`, ADMIN);
    expect(ok.json.map((r: any) => r.name).sort()).toEqual(["Hannah Fischer", "Ravi Iyer", "Sofia Rossi"]);
  });
});

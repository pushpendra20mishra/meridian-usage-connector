import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Env, ROOT } from "../helpers.js";
import { makeClient } from "./helpers.js";

interface Case { env: Env; user: string; tool: string; args: Record<string, any>; expect: "allow" | "deny"; denied_by?: string }
const cases: Case[] = JSON.parse(readFileSync(`${ROOT}/contracts/policy-matrix.json`, "utf8")).cases;

describe.each(cases)("$env $user $tool $args -> $expect $denied_by", (c) => {
  it("matches", async () => {
    const client = await makeClient(c.env);
    const q = new URLSearchParams({ period: "2026-08", ...(c.args.group ? { group: c.args.group } : {}) });
    let r;
    if (c.tool === "usage_summary") r = await client.get(`/api/v1/usage/summary?${q}`, c.user);
    else if (c.tool === "top_users") r = await client.get(`/api/v1/usage/top-users?${q}&limit=${c.args.limit ?? 10}`, c.user);
    else if (c.tool === "capability_status") r = await client.get(`/api/v1/capabilities${c.args.group ? `?group=${c.args.group}` : ""}`, c.user);
    else r = await client.put(`/api/v1/capabilities/${c.args.group}/${c.args.capability}`, c.user, { enabled: c.args.enabled });
    // the connector gate is not enforced by the service
    const serviceDenies = c.expect === "deny" && c.denied_by !== "capability_gate";
    if (serviceDenies) {
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("permission_denied");
      expect(r.json.reason).toBeTruthy();
      expect(JSON.stringify(r.json)).not.toMatch(/tokens|cost_usd/);
    } else {
      expect(r.status).toBe(200);
    }
  });
});

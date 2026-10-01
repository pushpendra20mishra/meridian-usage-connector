import { describe, expect, it } from "vitest";
import { Denied, Policy } from "../../src/core/policy.js";
import { directory, manifest } from "../helpers.js";

const d = directory();
const u = (email: string) => d.user(email)!;
const LEAD = "priya.nair@meridianls.example";
const ADMIN = "chloe.dubois@meridianls.example";
const MEMBER = "daniel.okafor@meridianls.example";

describe("Policy", () => {
  it("defaults the group to the caller's own", () => {
    expect(new Policy(manifest("prod")).resolveGroup(u(LEAD), "usage:read", undefined)).toBe("clinical-operations");
  });

  it("denies another group to a team lead with a structured, data-free denial", () => {
    try {
      new Policy(manifest("prod")).resolveGroup(u(LEAD), "usage:read", "finance");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Denied);
      expect((e as Denied).body()).toEqual({
        error: "permission_denied",
        reason: expect.stringContaining("own group"),
        required_scope: "usage:read",
      });
    }
  });

  it("reports the missing scope", () => {
    expect(() => new Policy(manifest("prod")).resolveGroup(u(MEMBER), "usage:read", undefined)).toThrow(Denied);
    expect(() => new Policy(manifest("prod")).resolveGroup(u(LEAD), "capabilities:write", "clinical-operations")).toThrow(/capabilities:write/);
  });

  it("lets admins target any group", () => {
    expect(new Policy(manifest("prod")).resolveGroup(u(ADMIN), "usage:read", "hr")).toBe("hr");
    expect(new Policy(manifest("prod")).resolveGroup(u(ADMIN), "capabilities:write", "finance")).toBe("finance");
  });

  it("dev lets anyone read any group, but writes stay own-group for non-admins", () => {
    const p = new Policy(manifest("dev"));
    expect(p.resolveGroup(u(MEMBER), "usage:read", "finance")).toBe("finance");
    expect(() => p.resolveGroup(u(LEAD), "capabilities:write", "finance")).toThrow(Denied);
    expect(p.resolveGroup(u(LEAD), "capabilities:write", "clinical-operations")).toBe("clinical-operations");
  });

  it("fails closed on an unknown scope or an unknown role", () => {
    const p = new Policy(manifest("prod"));
    expect(() => p.resolveGroup(u(LEAD), "usage:everything" as any, undefined)).toThrow(Denied);
    expect(() => p.resolveGroup({ ...u(LEAD), role: "intern" }, "usage:read", undefined)).toThrow(Denied);
  });
});

import { User } from "../../src/core/directory.js";

const mk = (role: string, group = "clinical-operations"): User => ({ userId: `u_${role}`, email: `${role}@x.example`, name: role, role, groupIds: [group] });
const scope = (roles: string[], vis: "own_group" | "all") => ({ roles, group_visibility: vis, all_groups_roles: ["platform_admin"] });
const man = (read: string[], vis: "own_group" | "all", write: string[]) =>
  new Policy({
    environment: "t", server_name: "x",
    scopes: { "usage:read": scope(read, vis), "capabilities:write": scope(write, "own_group") },
    capability_defaults: { "web-search": { "clinical-operations": true, finance: false, hr: true } },
  });
const GROUPS = ["clinical-operations", "finance", "hr"];

describe("Policy (synthetic manifests)", () => {
  const prodlike = () => man(["team_lead", "platform_admin"], "own_group", ["platform_admin"]);

  it("visibility 'all' widens reads but never writes", () => {
    const p = man(["member", "team_lead", "platform_admin"], "all", ["team_lead", "platform_admin"]);
    expect(p.resolveGroup(mk("member"), "usage:read", "finance")).toBe("finance");
    expect(() => p.resolveGroup(mk("team_lead"), "capabilities:write", "finance")).toThrow(Denied);
  });

  it("defaultGroups: everything for admins, own groups otherwise; visibleGroups empty without scope", () => {
    const p = prodlike();
    expect(p.defaultGroups(mk("platform_admin"), "usage:read", GROUPS)).toEqual(GROUPS);
    expect(p.defaultGroups(mk("team_lead"), "usage:read", GROUPS)).toEqual(["clinical-operations"]);
    expect(p.visibleGroups(mk("member"), "usage:read", GROUPS)).toEqual([]);
    expect(p.visibleGroups(mk("team_lead"), "usage:read", GROUPS)).toEqual(["clinical-operations"]);
  });

  it("requireAllGroups needs the scope and an all-groups role", () => {
    const p = man(["team_lead", "platform_admin"], "own_group", ["team_lead", "platform_admin"]);
    expect(() => p.requireAllGroups(mk("team_lead"), "capabilities:write")).toThrow(Denied);
    expect(() => p.requireAllGroups(mk("platform_admin"), "capabilities:write")).not.toThrow();
  });

  it("hasAllGroups is true only for an all-groups role that holds the scope", () => {
    const p = man(["team_lead", "platform_admin"], "own_group", ["platform_admin"]);
    expect(p.hasAllGroups(mk("platform_admin"), "usage:read")).toBe(true);
    expect(p.hasAllGroups(mk("team_lead"), "usage:read")).toBe(false);
    expect(p.hasAllGroups(mk("platform_admin"), "usage:everything" as any)).toBe(false);
  });

  it("exposes capability names and per-group defaults from the manifest", () => {
    const p = prodlike();
    expect(p.capabilities).toEqual(["web-search"]);
    expect(p.capabilityDefault("finance", "web-search")).toBe(false);
  });
});

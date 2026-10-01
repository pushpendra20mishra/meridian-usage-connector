import { describe, expect, it } from "vitest";
import { Policy } from "../../src/core/policy.js";
import { AuditLog } from "../../src/service/audit.js";
import { CapabilityStore, seedDefaults } from "../../src/service/capabilities.js";
import { openDb } from "../../src/service/db.js";

const M = {
  environment: "t", server_name: "x", scopes: {},
  capability_defaults: { "usage-connector": { a: true, b: false }, "web-search": { a: true, b: true } },
} as any;
const CAPS = ["usage-connector", "web-search"];
const clock = () => "2026-09-30T10:00:00Z";

function store(db = openDb(":memory:")) {
  seedDefaults(db, new Policy(M), ["a", "b"]);
  const audit = new AuditLog(db, new Map());
  return Object.assign(new CapabilityStore(db, CAPS, audit, clock), { log: audit });
}

describe("CapabilityStore", () => {
  it("seeds defaults with null audit fields", () => {
    expect(store().status("b")).toEqual([
      { group: "b", capability: "usage-connector", enabled: false, updated_at: null, updated_by: null },
      { group: "b", capability: "web-search", enabled: true, updated_at: null, updated_by: null },
    ]);
  });

  it("set persists, returns the new state and writes an audit row", () => {
    const s = store();
    expect(s.set("b", "usage-connector", true, "x@y")).toEqual({
      group: "b", capability: "usage-connector", enabled: true, updated_at: "2026-09-30T10:00:00Z", updated_by: "x@y",
    });
    expect(s.status("b").find((x) => x.capability === "usage-connector")!.enabled).toBe(true);
    expect(s.log.list(["b"], 10)).toHaveLength(1);
  });

  it("re-seeding never overwrites a deliberate change", () => {
    const db = openDb(":memory:");
    store(db).set("a", "web-search", false, "x@y");
    expect(store(db).status("a").find((x) => x.capability === "web-search")!.enabled).toBe(false);
  });

  it("an unknown group has no capabilities", () => {
    expect(store().status("zzz")).toEqual([]);
  });
});

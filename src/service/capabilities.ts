import type { Policy } from "../core/policy.js";
import type { AuditLog } from "./audit.js";
import { type Db, all } from "./db.js";

export interface CapabilityState {
  group: string;
  capability: string;
  enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// only fills gaps, so admin changes survive a restart
export function seedDefaults(db: Db, policy: Policy, groupIds: readonly string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO capability (group_id, capability, enabled) VALUES (?,?,?)");
  db.transaction(() => {
    for (const cap of policy.capabilities) for (const g of groupIds) insert.run(g, cap, policy.capabilityDefault(g, cap) ? 1 : 0);
  })();
}

export class CapabilityStore {
  constructor(
    private db: Db,
    private capabilities: string[],
    private audit: AuditLog,
    private clock: () => string = now,
  ) {}

  // one query for any number of groups, rows come back in policy capability order
  private statesFor(groups: readonly string[]): Map<string, CapabilityState[]> {
    const byGroup = new Map<string, CapabilityState[]>(groups.map((g) => [g, []]));
    if (!groups.length) return byGroup;
    const rows = all<{ group_id: string; capability: string; enabled: number; updated_at: string | null; updated_by: string | null }>(
      this.db,
      `SELECT group_id, capability, enabled, updated_at, updated_by FROM capability WHERE group_id IN (${groups.map(() => "?").join(",")})`,
      [...groups],
    );
    const order = new Map(this.capabilities.map((c, i) => [c, i]));
    for (const r of rows.filter((r) => order.has(r.capability)).sort((a, b) => order.get(a.capability)! - order.get(b.capability)!)) {
      byGroup.get(r.group_id)!.push({ group: r.group_id, capability: r.capability, enabled: !!r.enabled, updated_at: r.updated_at, updated_by: r.updated_by });
    }
    return byGroup;
  }

  status(group: string): CapabilityState[] {
    return this.statesFor([group]).get(group)!;
  }

  set(group: string, capability: string, enabled: boolean, by: string): CapabilityState {
    const at = this.clock();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO capability (group_id, capability, enabled, updated_at, updated_by) VALUES (?,?,?,?,?)
          ON CONFLICT (group_id, capability) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(group, capability, enabled ? 1 : 0, at, by);
      this.audit.record({ action: "capability_set", groupId: group, capability, detail: enabled ? "on" : "off", at, by });
    })();
    return { group, capability, enabled, updated_at: at, updated_by: by };
  }

  matrix(groups: readonly string[]) {
    const states = this.statesFor(groups);
    return groups.map((g) => ({ group: g, capabilities: Object.fromEntries(states.get(g)!.map((s) => [s.capability, s])) }));
  }
}

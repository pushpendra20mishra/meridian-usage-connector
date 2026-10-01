// per-user overrides and suspension, on top of the group switches
import type { User } from "../core/directory.js";
import type { AuditLog } from "./audit.js";
import type { CapabilityStore } from "./capabilities.js";
import { type Db, all, one } from "./db.js";

export interface EffectiveCapability {
  user_id: string;
  group: string;
  capability: string;
  enabled: boolean;
  source: "group" | "user_override";
  group_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}
export interface Suspension { user_id: string; suspended: true; reason: string | null; suspended_at: string; suspended_by: string }

interface Override { capability: string; enabled: number; updated_at: string; updated_by: string }
interface SuspensionRow { user_id: string; reason: string | null; suspended_at: string; suspended_by: string }
const toSuspension = (r: SuspensionRow): Suspension => ({ user_id: r.user_id, suspended: true, reason: r.reason, suspended_at: r.suspended_at, suspended_by: r.suspended_by });

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class UserAdmin {
  constructor(
    private db: Db,
    private groupCaps: CapabilityStore,
    private audit: AuditLog,
    private clock: () => string = now,
  ) {}

  effective(user: User): EffectiveCapability[] {
    const group = user.groupIds[0]!;
    const overrides = new Map(
      all<Override>(this.db, "SELECT capability, enabled, updated_at, updated_by FROM user_capability WHERE user_id = ?", [user.userId]).map((r) => [r.capability, r]),
    );
    return this.groupCaps.status(group).map((g) => {
      const o = overrides.get(g.capability);
      return {
        user_id: user.userId, group, capability: g.capability,
        enabled: o ? !!o.enabled : g.enabled,
        source: o ? "user_override" : "group",
        group_enabled: g.enabled,
        updated_at: o ? o.updated_at : g.updated_at,
        updated_by: o ? o.updated_by : g.updated_by,
      };
    });
  }

  setOverride(user: User, capability: string, enabled: boolean | null, by: string): EffectiveCapability {
    const at = this.clock();
    this.db.transaction(() => {
      if (enabled === null) this.db.prepare("DELETE FROM user_capability WHERE user_id=? AND capability=?").run(user.userId, capability);
      else {
        this.db.prepare(`INSERT INTO user_capability (user_id, capability, enabled, updated_at, updated_by) VALUES (?,?,?,?,?)
          ON CONFLICT (user_id, capability) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
          .run(user.userId, capability, enabled ? 1 : 0, at, by);
      }
      this.audit.record({ action: enabled === null ? "override_cleared" : "override_set", groupId: user.groupIds[0]!, userId: user.userId, capability, detail: enabled === null ? null : enabled ? "on" : "off", at, by });
    })();
    return this.effective(user).find((c) => c.capability === capability)!;
  }

  suspension(userId: string): Suspension | null {
    const r = one<SuspensionRow>(this.db, "SELECT user_id, reason, suspended_at, suspended_by FROM user_suspension WHERE user_id=?", [userId]);
    return r ? toSuspension(r) : null;
  }

  suspensions(): Suspension[] {
    return all<SuspensionRow>(this.db, "SELECT user_id, reason, suspended_at, suspended_by FROM user_suspension ORDER BY suspended_at DESC, user_id").map(toSuspension);
  }

  suspend(user: User, reason: string | null, by: string): Suspension {
    const at = this.clock();
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO user_suspension (user_id, reason, suspended_at, suspended_by) VALUES (?,?,?,?)").run(user.userId, reason, at, by);
      this.audit.record({ action: "suspended", groupId: user.groupIds[0]!, userId: user.userId, detail: reason, at, by });
    })();
    return this.suspension(user.userId)!;
  }

  restore(user: User, by: string): void {
    const at = this.clock();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM user_suspension WHERE user_id=?").run(user.userId);
      this.audit.record({ action: "restored", groupId: user.groupIds[0]!, userId: user.userId, at, by });
    })();
  }
}

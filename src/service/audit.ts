import type { Db } from "./db.js";

export type AuditAction = "capability_set" | "override_set" | "override_cleared" | "suspended" | "restored";

export interface AuditEntry {
  action: AuditAction;
  group: string;
  user_id: string | null;
  user_name: string | null;
  capability: string | null;
  detail: string | null;
  changed_at: string;
  changed_by: string;
}

interface NewEntry {
  action: AuditAction;
  groupId: string;
  userId?: string;
  capability?: string;
  detail?: string | null;
  at: string;
  by: string;
}

export class AuditLog {
  constructor(
    private db: Db,
    private names: Map<string, { name: string }>,
  ) {}

  record(e: NewEntry): void {
    this.db
      .prepare("INSERT INTO audit_log (action, group_id, user_id, capability, detail, changed_at, changed_by) VALUES (?,?,?,?,?,?,?)")
      .run(e.action, e.groupId, e.userId ?? null, e.capability ?? null, e.detail ?? null, e.at, e.by);
  }

  // a list of groups only sees switch changes in those groups, "all" also gets the per-user actions
  list(scope: readonly string[] | "all", limit: number): AuditEntry[] {
    const where = scope === "all" ? "1=1" : `action = 'capability_set' AND group_id IN (${scope.map(() => "?").join(",") || "NULL"})`;
    const args = scope === "all" ? [] : [...scope];
    const rows = this.db
      .prepare(`SELECT action, group_id, user_id, capability, detail, changed_at, changed_by FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as Record<string, string | null>[];
    return rows.map((r) => ({
      action: r.action as AuditAction,
      group: r.group_id!,
      user_id: r.user_id ?? null,
      user_name: r.user_id ? (this.names.get(r.user_id)?.name ?? r.user_id) : null,
      capability: r.capability ?? null,
      detail: r.detail ?? null,
      changed_at: r.changed_at!,
      changed_by: r.changed_by!,
    }));
  }
}

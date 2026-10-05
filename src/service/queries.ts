import { nanoToUsd } from "../core/money.js";
import { type DateRange, weekStart } from "../core/periods.js";
import { type Db, all, one } from "./db.js";

export const PLATFORMS = ["claude", "gemini"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Dim = "platform" | "group" | "week";
const DIM_COLUMN: Record<Dim, string> = { platform: "platform", group: "group_id", week: "week" };

interface Sums {
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
}
interface Split {
  claude_tokens: number | null;
  claude_cost: number | null;
  gemini_tokens: number | null;
  gemini_cost: number | null;
}

const SUMS = `SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(total_tokens) AS total_tokens, SUM(cost_nano_usd) AS cost`;
const splitOf = (p: Platform) => `SUM(CASE WHEN platform='${p}' THEN total_tokens END) AS ${p}_tokens, SUM(CASE WHEN platform='${p}' THEN cost_nano_usd END) AS ${p}_cost`;
const SPLIT = `${splitOf("claude")}, ${splitOf("gemini")}`;

const range = (rng: DateRange) => ({ sql: "day >= ? AND day < ?", args: [rng.start, rng.endExclusive] });

const totals = (r: Partial<Sums>) => ({
  requests: r.requests ?? null,
  input_tokens: r.input_tokens ?? 0,
  output_tokens: r.output_tokens ?? 0,
  total_tokens: r.total_tokens ?? 0,
  cost_usd: nanoToUsd(r.cost ?? 0),
});

const platformPart = (s: Split, p: Platform) => ({ total_tokens: s[`${p}_tokens`] ?? 0, cost_usd: nanoToUsd(s[`${p}_cost`] ?? 0) });
const bothPlatforms = (s: Split) => ({ claude: platformPart(s, "claude"), gemini: platformPart(s, "gemini") });

export function dataEndExclusive(db: Db): string {
  const row = one<{ value: string }>(db, "SELECT value FROM meta WHERE key='data_end_exclusive'");
  if (!row) throw new Error("no usage data ingested");
  return row.value;
}

function perPlatform(db: Db, where: string, args: unknown[]) {
  const rows = new Map(all<Sums & { platform: Platform }>(db, `SELECT platform, ${SUMS} FROM usage_fact WHERE ${where} GROUP BY platform`, args).map((r) => [r.platform, r]));
  const platforms = PLATFORMS.map((p) => ({ platform: p, ...totals(rows.get(p) ?? {}) }));
  const sum = (key: "total_tokens" | "cost") => [...rows.values()].reduce((a, r) => a + (r[key] ?? 0), 0);
  return { platforms, totals: { total_tokens: sum("total_tokens"), cost_usd: nanoToUsd(sum("cost")) } };
}

export function summary(db: Db, rng: DateRange, group: string) {
  const r = range(rng);
  return { group, ...perPlatform(db, `${r.sql} AND group_id = ?`, [...r.args, group]) };
}

export type BreakdownRow = Partial<Record<Dim, string>> & ReturnType<typeof totals>;

export function breakdown(db: Db, rng: DateRange, groups: readonly string[], by: Dim[]): BreakdownRow[] {
  const cols = by.map((d) => DIM_COLUMN[d]);
  const r = range(rng);
  const rows = all<Sums & Record<string, string>>(
    db,
    `SELECT ${cols.join(", ")}, ${SUMS} FROM usage_fact WHERE ${r.sql} AND group_id IN (${groups.map(() => "?").join(",")})
     GROUP BY ${cols.join(", ")} ORDER BY ${cols.join(", ")}`,
    [...r.args, ...groups],
  );
  return rows.map((row) => ({ ...Object.fromEntries(by.map((d, i) => [d, row[cols[i]!]])), ...totals(row) }));
}

export function topUsers(db: Db, rng: DateRange, group: string, limit: number, names: Map<string, { name: string; email: string }>) {
  const r = range(rng);
  const rows = all<{ user_id: string; group_id: string; tokens: number; cost: number }>(
    db,
    `SELECT user_id, group_id, SUM(total_tokens) AS tokens, SUM(cost_nano_usd) AS cost FROM usage_fact
     WHERE ${r.sql} AND group_id = ? GROUP BY user_id, group_id ORDER BY tokens DESC, user_id LIMIT ?`,
    [...r.args, group, limit],
  );
  return rows.map((x) => {
    const who = names.get(x.user_id)!;
    return { user_id: x.user_id, name: who.name, email: who.email, group: x.group_id, total_tokens: x.tokens, cost_usd: nanoToUsd(x.cost) };
  });
}

const NO_USAGE: Split & { tokens: number; cost: number } = { tokens: 0, cost: 0, claude_tokens: 0, claude_cost: 0, gemini_tokens: 0, gemini_cost: 0 };

export function byUser(db: Db, rng: DateRange, members: readonly { userId: string; name: string; email: string; role: string }[], group: string) {
  const r = range(rng);
  const rows = new Map(
    all<Split & { user_id: string; tokens: number; cost: number }>(
      db,
      `SELECT user_id, SUM(total_tokens) AS tokens, SUM(cost_nano_usd) AS cost, ${SPLIT} FROM usage_fact WHERE ${r.sql} AND group_id = ? GROUP BY user_id`,
      [...r.args, group],
    ).map((x) => [x.user_id, x]),
  );
  return members
    .map((m) => {
      const x = rows.get(m.userId) ?? NO_USAGE;
      return { user_id: m.userId, name: m.name, email: m.email, role: m.role, group, ...bothPlatforms(x), total_tokens: x.tokens, cost_usd: nanoToUsd(x.cost) };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens || a.name.localeCompare(b.name));
}

export function userUsage(db: Db, rng: DateRange, userId: string) {
  const r = range(rng);
  const where = `${r.sql} AND user_id = ?`;
  const args = [...r.args, userId];
  const weeks = all<Split & { week: string; tokens: number; cost: number }>(
    db,
    `SELECT week, SUM(total_tokens) AS tokens, SUM(cost_nano_usd) AS cost, ${SPLIT} FROM usage_fact WHERE ${where} GROUP BY week ORDER BY week`,
    args,
  ).map((w) => ({ week: w.week, week_start: weekStart(w.week), ...bothPlatforms(w), total_tokens: w.tokens, cost_usd: nanoToUsd(w.cost) }));
  const models = all<{ platform: string; model: string; tokens: number; cost: number }>(
    db,
    `SELECT platform, model, SUM(total_tokens) AS tokens, SUM(cost_nano_usd) AS cost FROM usage_fact WHERE ${where} GROUP BY platform, model ORDER BY tokens DESC`,
    args,
  ).map((m) => ({ platform: m.platform, model: m.model, total_tokens: m.tokens, cost_usd: nanoToUsd(m.cost) }));
  return { ...perPlatform(db, where, args), weeks, models };
}

export function dataHealth(db: Db) {
  const platforms = all<{ platform: string; n: number; lo: string; hi: string; u: number }>(
    db,
    "SELECT platform, COUNT(*) n, MIN(day) lo, MAX(day) hi, COUNT(DISTINCT user_id) u FROM usage_fact GROUP BY platform ORDER BY platform",
  ).map((p) => ({ platform: p.platform, rows: p.n, first_day: p.lo, last_day: p.hi, users: p.u }));
  return {
    data_end_exclusive: dataEndExclusive(db),
    platforms,
    ingest_issues: one<{ c: number }>(db, "SELECT COUNT(*) c FROM ingest_issue")!.c,
    issues: all<{ source: string; ref: string; reason: string }>(db, "SELECT source, ref, reason FROM ingest_issue LIMIT 50"),
  };
}

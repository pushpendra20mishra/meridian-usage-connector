// claude: usage + cost rows joined on user/day/product/model
// gemini: input and output sku rows pivoted into one row
// anything we cannot attribute goes to ingest_issue, never guessed
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Directory } from "../core/directory.js";
import { centsStringToNano, usdFloatToNano } from "../core/money.js";
import { addDays, isoWeekLabel } from "../core/periods.js";
import type { Db } from "./db.js";
import { type ClaudeCostRow, type ClaudeUsageRow, parseClaudeCost, parseClaudeUsage, parseGeminiLine } from "./exports.js";

export interface Fact {
  platform: "claude" | "gemini";
  day: string;
  userId: string;
  groupId: string;
  product: string;
  model: string;
  sourceRef: string;
  requests: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costNanoUsd: number;
}
export interface Issue { source: string; ref: string; reason: string }
export interface IngestResult { facts: Fact[]; issues: Issue[] }

const SKU = /^Gemini (?<model>[\w. ]+?) Text (?<dir>Input|Output) Tokens/i;

export const parseRfc3339Day = (ts: string): string => new Date(ts).toISOString().slice(0, 10);

// bigquery format, not iso: "2026-08-05 00:00:00 UTC"
export function parseGcpDay(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}(?:\.\d+)? UTC$/.exec(ts);
  if (!m) throw new Error(`unrecognised BigQuery timestamp ${JSON.stringify(ts)}`);
  return m[1]!;
}

const labels = (pairs: { key: string; value: string }[]) => Object.fromEntries(pairs.map((p) => [p.key, p.value]));

export function loadClaude(usage: ClaudeUsageRow[], cost: ClaudeCostRow[], directory: Directory, result: IngestResult): void {
  const key = (r: ClaudeUsageRow | ClaudeCostRow) => [r.actor.user_id, r.starting_at, r.product, r.model].join("|");
  const costByKey = new Map<string, number>();
  for (const c of cost) {
    if ((c.currency ?? "USD") !== "USD") {
      result.issues.push({ source: "claude_cost", ref: key(c), reason: `non-USD ${c.currency}` });
      continue;
    }
    costByKey.set(key(c), (costByKey.get(key(c)) ?? 0) + centsStringToNano(c.amount));
  }
  const seen = new Set<string>();
  for (const r of usage) {
    const k = key(r);
    const user = directory.user(r.actor.user_id);
    const group = directory.groupByRbac(r.rbac_group_id);
    if (!user) { result.issues.push({ source: "claude_usage", ref: k, reason: "actor not in directory" }); continue; }
    if (!group) { result.issues.push({ source: "claude_usage", ref: k, reason: "unknown rbac_group_id" }); continue; }
    if (!user.groupIds.includes(group.groupId)) {
      // keep claude's group, just flag the mismatch
      result.issues.push({ source: "claude_usage", ref: k, reason: `rbac group ${group.groupId} not in user's groups` });
    }
    const cc = r.cache_creation;
    const input = r.uncached_input_tokens + r.cache_read_input_tokens + cc.ephemeral_5m_input_tokens + cc.ephemeral_1h_input_tokens;
    const output = r.output_tokens;
    if (input + output !== r.total_tokens) {
      result.issues.push({ source: "claude_usage", ref: k, reason: `total_tokens ${r.total_tokens} != ${input + output}` });
    }
    if (!costByKey.has(k)) result.issues.push({ source: "claude_usage", ref: k, reason: "no matching cost row; cost=0" });
    seen.add(k);
    result.facts.push({
      platform: "claude", day: parseRfc3339Day(r.starting_at), userId: user.userId, groupId: group.groupId,
      product: r.product, model: r.model, sourceRef: r.rbac_group_id, requests: r.requests,
      inputTokens: input, outputTokens: output, totalTokens: r.total_tokens, costNanoUsd: costByKey.get(k) ?? 0,
    });
  }
  for (const k of costByKey.keys()) {
    if (!seen.has(k)) result.issues.push({ source: "claude_cost", ref: k, reason: "cost row without usage row; dropped" });
  }
}

export function loadGemini(lines: string[], directory: Directory, result: IngestResult): void {
  const pivot = new Map<string, Fact>();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const row = parseGeminiLine(line, i + 1);
    const ref = `line ${i + 1}`;
    if (row.service.description !== "Vertex AI") return;
    const m = SKU.exec(row.sku.description);
    if (!m?.groups) { result.issues.push({ source: "gemini", ref, reason: `unparsed SKU ${JSON.stringify(row.sku.description)}` }); return; }
    if (row.currency !== "USD") { result.issues.push({ source: "gemini", ref, reason: `non-USD ${row.currency}` }); return; }
    const lab = labels(row.labels);
    const user = directory.user(lab.owner ?? "");
    if (!user) { result.issues.push({ source: "gemini", ref, reason: "owner label missing or not in directory" }); return; }
    const projectGroup = directory.groupByProject(row.project.id);
    if (!projectGroup || !user.groupIds.includes(projectGroup.groupId)) {
      result.issues.push({ source: "gemini", ref, reason: `owner's group != project ${row.project.id} group` });
    }
    const model = lab.model || m.groups.model!.toLowerCase().replaceAll(" ", "-");
    // credits come through negative
    const credits = (row.credits ?? []).reduce((a, c) => a + c.amount, 0);
    const nano = usdFloatToNano(row.cost) + usdFloatToNano(credits);
    const day = parseGcpDay(row.usage_start_time);
    const agent = lab.agent ?? "unknown";
    const k = [day, user.userId, agent, model, row.project.id].join("|");
    let fact = pivot.get(k);
    if (!fact) {
      fact = { platform: "gemini", day, userId: user.userId, groupId: user.groupIds[0]!, product: agent, model,
        sourceRef: row.project.id, requests: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costNanoUsd: 0 };
      pivot.set(k, fact);
    }
    const tokens = Math.trunc(row.usage.amount);
    if (m.groups.dir!.toLowerCase() === "input") fact.inputTokens += tokens;
    else fact.outputTokens += tokens;
    fact.totalTokens += tokens;
    fact.costNanoUsd += nano;
  });
  result.facts.push(...pivot.values());
}

export function build(dataDir: string, directory: Directory): IngestResult {
  const result: IngestResult = { facts: [], issues: [] };
  const json = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf8"));
  loadClaude(parseClaudeUsage(json("claude/user_usage_report.json")), parseClaudeCost(json("claude/user_cost_report.json")), directory, result);
  const files = readdirSync(join(dataDir, "gemini")).filter((f) => /^gcp_billing_export_.*\.jsonl$/.test(f));
  if (files.length !== 1) throw new Error(`expected exactly one Gemini billing export, found ${files.length}`);
  loadGemini(readFileSync(join(dataDir, "gemini", files[0]!), "utf8").split("\n"), directory, result);
  return result;
}

export function write(db: Db, result: IngestResult): void {
  const insertFact = db.prepare(
    `INSERT INTO usage_fact (platform, day, week, user_id, group_id, product, model, source_ref, requests,
       input_tokens, output_tokens, total_tokens, cost_nano_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertIssue = db.prepare("INSERT INTO ingest_issue (source, ref, reason) VALUES (?,?,?)");
  db.transaction(() => {
    db.exec("DELETE FROM usage_fact; DELETE FROM ingest_issue");
    for (const f of result.facts) {
      insertFact.run(f.platform, f.day, isoWeekLabel(f.day), f.userId, f.groupId, f.product, f.model, f.sourceRef,
        f.requests, f.inputTokens, f.outputTokens, f.totalTokens, f.costNanoUsd);
    }
    for (const i of result.issues) insertIssue.run(i.source, i.ref, i.reason);
    const last = result.facts.reduce((a, f) => (f.day > a ? f.day : a), "");
    if (last) db.prepare("INSERT OR REPLACE INTO meta VALUES ('data_end_exclusive', ?)").run(addDays(last, 1));
  })();
}

export function run(db: Db, dataDir: string, directory: Directory): IngestResult {
  const result = build(dataDir, directory);
  write(db, result);
  return result;
}

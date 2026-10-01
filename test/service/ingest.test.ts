// expected values come from the raw files, not from the ingest code
import { describe, expect, it } from "vitest";
import { loadDirectory } from "../../src/core/directory.js";
import { centsStringToNano } from "../../src/core/money.js";
import { openDb } from "../../src/service/db.js";
import * as ingest from "../../src/service/ingest.js";
import { ROOT, raw } from "../helpers.js";


const directory = () => loadDirectory(`${ROOT}/data/directory`);
function ingested() {
  const db = openDb(":memory:");
  const result = ingest.run(db, `${ROOT}/data`, directory());
  return { db, result };
}
const sumMicro = (xs: string[]) => xs.reduce((a, s) => a + BigInt(s.replace(".", "")), 0n);

describe("ingest: mapping", () => {
  it("attributes every row and reports no issues", () => {
    expect(ingested().result.issues).toEqual([]);
  });

  it("Claude cost per group equals the raw cost rows (cents -> USD, exact)", () => {
    const { db } = ingested();
    const r = raw();
    const rbac = new Map(r.groups.map((g: any) => [g.claude_rbac_group_id, g.group_id]));
    const expected = new Map<string, bigint>();
    for (const c of r.cost.data) {
      const g = rbac.get(c.rbac_group_id) as string;
      expected.set(g, (expected.get(g) ?? 0n) + sumMicro([c.amount]));
    }
    const got = db.prepare("SELECT group_id g, SUM(cost_nano_usd) c FROM usage_fact WHERE platform='claude' GROUP BY group_id").all() as any[];
    for (const row of got) expect(BigInt(row.c)).toBe(expected.get(row.g)! * 10n); // 1e-6 cents = 10 nano-USD
    expect(got).toHaveLength(expected.size);
  });

  it("folds the web_search cost line into the same fact as the token cost", () => {
    const { db } = ingested();
    const r = raw();
    const ws = r.cost.data.find((c: any) => c.cost_type === "web_search");
    const key = (c: any) => [c.actor.user_id, c.starting_at, c.product, c.model].join("|");
    const tok = r.cost.data.find((c: any) => c.cost_type === "tokens" && key(c) === key(ws));
    const row = db.prepare("SELECT cost_nano_usd c FROM usage_fact WHERE platform='claude' AND user_id=? AND day=? AND product=? AND model=?")
      .get(ws.actor.user_id, ws.starting_at.slice(0, 10), ws.product, ws.model) as any;
    expect(row.c).toBe(centsStringToNano(ws.amount) + centsStringToNano(tok.amount));
  });

  it("Claude input includes cache tokens and input + output == total", () => {
    const { db } = ingested();
    expect((db.prepare("SELECT COUNT(*) c FROM usage_fact WHERE input_tokens + output_tokens != total_tokens").get() as any).c).toBe(0);
    const r = raw();
    const rawTotal = r.usage.data.reduce((a: number, x: any) => a + x.total_tokens, 0);
    expect((db.prepare("SELECT SUM(total_tokens) t, COUNT(*) n FROM usage_fact WHERE platform='claude'").get() as any)).toEqual({ t: rawTotal, n: r.usage.data.length });
  });

  it("Gemini totals match the raw rows; input/output SKUs pivot into one fact; requests are NULL", () => {
    const { db } = ingested();
    const g = raw().gemini;
    const sum = (re: RegExp) => g.filter((x: any) => re.test(x.sku.description)).reduce((a: number, x: any) => a + x.usage.amount, 0);
    const row = db.prepare("SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost_nano_usd) c, COUNT(*) n, COUNT(requests) r FROM usage_fact WHERE platform='gemini'").get() as any;
    expect([row.i, row.o]).toEqual([sum(/Input/), sum(/Output/)]);
    expect(row.c).toBe(g.reduce((a: number, x: any) => a + Math.round(x.cost * 1e9), 0));
    expect(row.n).toBeLessThan(g.length);
    expect(row.r).toBe(0);
  });

  it("parses BigQuery and RFC 3339 timestamps", () => {
    expect(ingest.parseGcpDay("2026-08-05 00:00:00 UTC")).toBe("2026-08-05");
    expect(ingest.parseRfc3339Day("2026-08-03T00:00:00.000Z")).toBe("2026-08-03");
  });

  it("Gemini attribution goes through the owner label", () => {
    const { db } = ingested();
    const r = raw();
    const groupOf = new Map(r.users.map((u: any) => [u.email, u.group_ids[0]]));
    const expected = new Map<string, number>();
    for (const x of r.gemini) {
      const owner = x.labels.find((l: any) => l.key === "owner").value;
      expected.set(groupOf.get(owner) as string, (expected.get(groupOf.get(owner) as string) ?? 0) + Math.trunc(x.usage.amount));
    }
    const got = Object.fromEntries((db.prepare("SELECT group_id g, SUM(total_tokens) t FROM usage_fact WHERE platform='gemini' GROUP BY group_id").all() as any[]).map((x) => [x.g, x.t]));
    expect(got).toEqual(Object.fromEntries(expected));
  });

  it("reports an unknown owner instead of guessing", () => {
    const row = structuredClone(raw().gemini[0]);
    row.labels = [{ key: "owner", value: "ghost@nowhere.example" }, ...row.labels.slice(1)];
    const result: ingest.IngestResult = { facts: [], issues: [] };
    ingest.loadGemini([JSON.stringify(row)], directory(), result);
    expect(result.facts).toEqual([]);
    expect(result.issues[0]!.reason).toContain("owner");
  });

  it("nets Gemini credits off the cost", () => {
    const row = structuredClone(raw().gemini[0]);
    row.cost = 0.1;
    row.credits = [{ name: "promo", amount: -0.025 }];
    const result: ingest.IngestResult = { facts: [], issues: [] };
    ingest.loadGemini([JSON.stringify(row)], directory(), result);
    expect(result.facts[0]!.costNanoUsd).toBe(75_000_000);
  });

  it("is idempotent", () => {
    const { db, result } = ingested();
    ingest.run(db, `${ROOT}/data`, directory());
    expect((db.prepare("SELECT COUNT(*) c FROM usage_fact").get() as any).c).toBe(result.facts.length);
  });

  it("derives the data window end from the data", () => {
    const { db } = ingested();
    expect((db.prepare("SELECT value v FROM meta WHERE key='data_end_exclusive'").get() as any).v).toBe("2026-09-28");
  });
});

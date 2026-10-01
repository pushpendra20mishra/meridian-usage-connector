import { describe, expect, it } from "vitest";
import { loadDirectory } from "../../src/core/directory.js";
import { ExportError, parseClaudeCost, parseClaudeUsage, parseGeminiLine } from "../../src/service/exports.js";
import * as ingest from "../../src/service/ingest.js";
import { ROOT, raw } from "../helpers.js";


describe("export shapes", () => {
  it("the real starter files parse", () => {
    const r = raw();
    expect(parseClaudeUsage(r.usage)).toHaveLength(r.usage.data.length);
    expect(parseClaudeCost(r.cost)).toHaveLength(r.cost.data.length);
    expect(parseGeminiLine(JSON.stringify(r.gemini[0]), 1).project.id).toBeTruthy();
  });

  it("a claude usage row without cache_creation is rejected, naming the field and row", () => {
    const usage = structuredClone(raw().usage);
    delete usage.data[2].cache_creation;
    expect(() => parseClaudeUsage(usage)).toThrow(ExportError);
    expect(() => parseClaudeUsage(usage)).toThrow(/data\.2\.cache_creation/);
  });

  it("a cost amount that is not a decimal string is rejected", () => {
    const cost = structuredClone(raw().cost);
    cost.data[0].amount = "12,5";
    expect(() => parseClaudeCost(cost)).toThrow(/data\.0\.amount/);
    cost.data[0].amount = 12.5; // a number, not the string the API sends
    expect(() => parseClaudeCost(cost)).toThrow(ExportError);
  });

  it("a bad gemini line says which line", () => {
    expect(() => parseGeminiLine("{not json", 7)).toThrow(/line 7/);
    const row = structuredClone(raw().gemini[0]);
    delete row.sku;
    expect(() => parseGeminiLine(JSON.stringify(row), 9)).toThrow(/line 9.*sku/);
  });

  it("ingest aborts on a malformed row instead of mapping it half-way", () => {
    const row = structuredClone(raw().gemini[0]);
    row.usage.amount = "lots";
    const result: ingest.IngestResult = { facts: [], issues: [] };
    expect(() => ingest.loadGemini([JSON.stringify(row)], loadDirectory(`${ROOT}/data/directory`), result)).toThrow(ExportError);
    expect(result.facts).toEqual([]);
  });
});

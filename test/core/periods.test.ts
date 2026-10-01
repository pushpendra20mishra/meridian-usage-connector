import { describe, expect, it } from "vitest";
import { InvalidPeriod, isoWeekLabel, parsePeriod, weekStart } from "../../src/core/periods.js";

const END = "2026-09-28";
const d = (s: string) => s;

describe("parsePeriod", () => {
  it("anchors relative periods to the end of the data window", () => {
    expect(parsePeriod("last_7_days", END)).toMatchObject({ start: d("2026-09-21"), endExclusive: END });
    expect(parsePeriod("last_30_days", END).start).toBe("2026-08-29");
  });

  it("ISO weeks start on Monday", () => {
    expect(parsePeriod("2026-W36", END)).toMatchObject({ start: "2026-08-31", endExclusive: "2026-09-07" });
  });

  it("months, including the December rollover", () => {
    expect(parsePeriod("2026-08", END).endExclusive).toBe("2026-09-01");
    expect(parsePeriod("2026-12", END).endExclusive).toBe("2027-01-01");
  });

  it.each(["2026-W54", "2026-13", "yesterday", "", "2026-W3", "last_90_days"])("rejects %j", (bad) => {
    expect(() => parsePeriod(bad, END)).toThrow(InvalidPeriod);
  });

  it("flags a period that runs past the end of the data as partial", () => {
    expect(parsePeriod("2026-09", END).partial).toBe(true);
    expect(parsePeriod("2026-08", END).partial).toBe(false);
    expect(parsePeriod("last_7_days", END).partial).toBe(false);
    expect(parsePeriod("2026-W40", END).partial).toBe(true);
  });
});

describe("week labels", () => {
  it("isoWeekLabel and weekStart are inverses", () => {
    expect(isoWeekLabel("2026-08-03")).toBe("2026-W32");
    expect(weekStart("2026-W36")).toBe("2026-08-31");
    expect(isoWeekLabel(weekStart("2026-W36"))).toBe("2026-W36");
  });
  it("handles a year boundary (2026-01-01 is in 2026-W01)", () => {
    expect(isoWeekLabel("2026-01-01")).toBe("2026-W01");
    expect(isoWeekLabel("2027-01-01")).toBe("2026-W53");
  });
});

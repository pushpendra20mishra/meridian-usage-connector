import { describe, expect, it } from "vitest";
import { centsStringToNano, nanoToUsd, usdFloatToNano } from "../../src/core/money.js";

describe("money is exact (integer nano-USD)", () => {
  it("Claude cents strings", () => {
    expect(centsStringToNano("88.900050")).toBe(889_000_500); // $0.8890005
    expect(centsStringToNano("1.000000")).toBe(10_000_000);
    expect(centsStringToNano("0")).toBe(0);
  });
  it("Gemini dollar floats do not pick up binary noise", () => {
    expect(usdFloatToNano(0.107564)).toBe(107_564_000);
    expect(usdFloatToNano(0.1 + 0.2)).toBe(300_000_000); // 0.30000000000000004 -> $0.30
    expect(usdFloatToNano(-0.025)).toBe(-25_000_000);
    expect(usdFloatToNano(3e-7)).toBe(300);
  });
  it("converts back to USD at 6 dp", () => {
    expect(nanoToUsd(889_000_500)).toBe(0.889001);
    expect(nanoToUsd(0)).toBe(0);
  });
  it("rejects garbage rather than guessing", () => {
    expect(() => centsStringToNano("abc")).toThrow();
  });
});

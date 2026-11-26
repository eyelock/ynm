import { describe, expect, it } from "vitest";
import { meanInterval, wilsonInterval } from "./interval.js";

describe("wilsonInterval", () => {
  it("brackets the observed proportion and stays inside [0, 1]", () => {
    const [lo, hi] = wilsonInterval(15, 20);
    expect(lo).toBeLessThan(0.75);
    expect(hi).toBeGreaterThan(0.75);
    expect(lo).toBeCloseTo(0.5313, 3);
    expect(hi).toBeCloseTo(0.8881, 3);
    expect(wilsonInterval(20, 20)[1]).toBe(1);
    expect(wilsonInterval(0, 20)[0]).toBe(0);
  });

  it("narrows as the sample grows, so n = 20 and n = 500 are told apart", () => {
    const width = (n: number) => {
      const [lo, hi] = wilsonInterval(n * 0.75, n);
      return hi - lo;
    };
    expect(width(500)).toBeLessThan(width(60));
    expect(width(60)).toBeLessThan(width(20));
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe("meanInterval", () => {
  it("is the mean plus or minus 1.96 standard errors, clamped to [0, 1]", () => {
    // values 0.25, 0.25, 0.75, 0.75: mean 0.5, sample variance 1/12, standard error sqrt(1/48)
    const [lo, hi] = meanInterval(2, 1.25, 4);
    expect(lo).toBeCloseTo(0.5 - 1.96 * Math.sqrt(1 / 48), 3);
    expect(hi).toBeCloseTo(0.5 + 1.96 * Math.sqrt(1 / 48), 3);
    expect(meanInterval(2, 2, 4)[0]).toBe(0); // 0, 0, 1, 1 would reach below 0: clamped
    expect(meanInterval(4, 4, 4)).toEqual([1, 1]);
    expect(meanInterval(1, 1, 1)).toEqual([1, 1]);
    expect(meanInterval(0, 0, 0)).toEqual([0, 1]);
  });
});

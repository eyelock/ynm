/** A 95% confidence interval, [low, high], each rounded to four places like the reports' numbers. */
export type Interval = [number, number];

const Z95 = 1.96;

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Wilson score interval for `successes` out of `n` trials; it stays inside [0, 1] at small n. */
export function wilsonInterval(successes: number, n: number): Interval {
  if (n <= 0) return [0, 1];
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

/** Normal interval for the mean of `n` values in [0, 1], from their sum and sum of squares. */
export function meanInterval(sum: number, sumSq: number, n: number): Interval {
  if (n <= 0) return [0, 1];
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  const half = Z95 * Math.sqrt(variance / n);
  return [round(Math.max(0, mean - half)), round(Math.min(1, mean + half))];
}

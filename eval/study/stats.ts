/** The statistics PLAN 11.7 asks for. No dependencies, deterministic, and tested against oracles. */

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

/** Linear interpolation between order statistics (R type 7, numpy's default). */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below);
}

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export type Spread = { n: number; median: number | null; q1: number | null; q3: number | null; iqr: number | null };

export function spread(values: number[]): Spread {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return { n: values.length, median: median(values), q1, q3, iqr: q1 === null || q3 === null ? null : q3 - q1 };
}

export type Wilcoxon = { w_plus: number; w_minus: number; n_nonzero: number; p: number; method: string };

/**
 * Two-sided Wilcoxon signed-rank test with an exact p-value. Zero differences are dropped and ties
 * get midranks, then the null distribution comes from every assignment of signs to those same ranks,
 * so it stays exact with the heavy ties that catch rates out of 4 produce. A normal approximation
 * would be wrong at this n.
 */
export function wilcoxonSignedRank(differences: number[]): Wilcoxon {
  const method = "exact signed-rank, zeros dropped, midranks for ties, two-sided";
  const nonzero = differences.filter((d) => d !== 0);
  if (nonzero.length === 0) return { w_plus: 0, w_minus: 0, n_nonzero: 0, p: 1, method };

  const byMagnitude = nonzero.map((d) => ({ d, abs: Math.abs(d) })).sort((a, b) => a.abs - b.abs);
  const ranks: number[] = new Array<number>(byMagnitude.length);
  for (let i = 0; i < byMagnitude.length; ) {
    let j = i;
    while (j + 1 < byMagnitude.length && byMagnitude[j + 1]!.abs === byMagnitude[i]!.abs) j += 1;
    const midrank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = midrank;
    i = j + 1;
  }
  let wPlus = 0;
  byMagnitude.forEach(({ d }, i) => {
    if (d > 0) wPlus += ranks[i]!;
  });
  const total = ranks.reduce((sum, rank) => sum + rank, 0);
  const wMinus = total - wPlus;

  // Midranks are whole or half, so doubling makes every sum an integer index.
  const doubled = ranks.map((rank) => Math.round(rank * 2));
  const maxSum = doubled.reduce((sum, rank) => sum + rank, 0);
  let ways = new Array<number>(maxSum + 1).fill(0);
  ways[0] = 1;
  for (const rank of doubled) {
    const next = [...ways];
    for (let sum = 0; sum + rank <= maxSum; sum += 1) next[sum + rank]! += ways[sum]!;
    ways = next;
  }
  const outcomes = 2 ** doubled.length;
  const observed = Math.round(Math.min(wPlus, wMinus) * 2);
  let lowerTail = 0;
  for (let sum = 0; sum <= observed; sum += 1) lowerTail += ways[sum]!;
  return { w_plus: wPlus, w_minus: wMinus, n_nonzero: nonzero.length, p: Math.min(1, (2 * lowerTail) / outcomes), method };
}

/** Small, seedable PRNG, so the same results always give the same confidence interval. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BootstrapCi = { low: number; high: number; resamples: number; seed: number; method: string };

/** Percentile bootstrap 95% CI for the mean. */
export function bootstrapMeanCi(values: number[], options: { resamples?: number; seed?: number } = {}): BootstrapCi | null {
  if (values.length === 0) return null;
  const resamples = options.resamples ?? 10_000;
  const seed = options.seed ?? 20261106;
  const random = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(random() * values.length)]!;
    means[r] = sum / values.length;
  }
  means.sort();
  return {
    low: means[Math.floor(0.025 * resamples)]!,
    high: means[Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)]!,
    resamples,
    seed,
    method: "percentile bootstrap of the mean paired difference",
  };
}

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function variance(arr) {
  const m = mean(arr);
  return mean(arr.map(x => (x - m) ** 2));
}

export function stddev(arr) {
  return Math.sqrt(variance(arr));
}

export function covariance(arr1, arr2) {
  const m1 = mean(arr1);
  const m2 = mean(arr2);
  return mean(arr1.map((x, i) => (x - m1) * (arr2[i] - m2)));
}

export function pearson(arr1, arr2) {
  const cov = covariance(arr1, arr2);
  const s1 = stddev(arr1);
  const s2 = stddev(arr2);
  if (s1 === 0 || s2 === 0) return 0;
  return cov / (s1 * s2);
}

export function beta(stockReturns, benchmarkReturns) {
  const cov = covariance(stockReturns, benchmarkReturns);
  const benchVar = variance(benchmarkReturns);
  if (benchVar === 0) return 1;
  return cov / benchVar;
}

export function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function pctChange(curr, prev) {
  if (!prev || prev === 0) return 0;
  return (curr - prev) / prev;
}

export function atr(bars) {
  // bars: array of { high, low, close } objects
  const trueRanges = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose)
    );
  });
  return mean(trueRanges);
}

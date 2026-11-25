/** 规则插件共用的确定性随机：由 Host 私有种子派生，同一种子可重放 */

/** sfc32，取种子前 16 字节 */
function createSeededPrng(seed: Uint8Array): () => number {
  const w = (i: number): number =>
    ((seed[i % seed.length]! << 24) | (seed[(i + 1) % seed.length]! << 16) | (seed[(i + 2) % seed.length]! << 8) | seed[(i + 3) % seed.length]!) >>> 0;
  let a = w(0);
  let b = w(4);
  let c = w(8);
  let d = w(12) | 1;
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** 拒绝采样，保证 [0, n) 均匀 */
function uniformIndex(next: () => number, n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const r = next();
    if (r < limit) return r % n;
  }
}

/** Fisher–Yates 洗牌；不修改输入 */
export function seededShuffle<T>(items: readonly T[], seed: Uint8Array): T[] {
  const next = createSeededPrng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = uniformIndex(next, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

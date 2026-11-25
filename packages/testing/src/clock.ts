import type { Clock, RandomSource } from '@we/platform';

/** 手动推进的虚拟时钟：相同输入、时间推进与 seed 可重现 */
export interface ManualClock extends Clock {
  advance(ms: number): void;
  /** 推进到没有待执行任务或达到上限 */
  runUntilIdle(maxMs?: number): void;
  pending(): number;
}

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();

  const nextDue = (limit: number): number | null => {
    let best: { id: number; at: number; seq: number } | null = null;
    for (const [id, t] of timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = { id, at: t.at, seq: t.seq };
    }
    return best ? best.id : null;
  };

  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const id = nextDue(target);
      if (id === null) break;
      const t = timers.get(id)!;
      timers.delete(id);
      now = Math.max(now, t.at);
      t.fn();
    }
    now = target;
  };

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), seq: id, fn });
      return () => timers.delete(id);
    },
    advance,
    runUntilIdle(maxMs = 600_000) {
      const end = now + maxMs;
      while (timers.size > 0 && now < end) {
        let min = Infinity;
        for (const t of timers.values()) min = Math.min(min, t.at);
        advance(Math.max(0, min - now));
      }
    },
    pending: () => timers.size,
  };
}

/** mulberry32 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 测试用确定性随机源（不可用于生产凭证） */
export function createSeededRandom(seed: number): RandomSource {
  const rng = createSeededRng(seed);
  return {
    async bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
      return out;
    },
  };
}

import { createMemoryStorage, type Canvas2D, type Clock, type Platform, type PointerInput, type RandomSource, type StoragePort } from '@we/platform';

/** 无 DOM 的测试平台：Canvas 绘制为空操作，文本宽度按字号估算，输入由测试注入 */
export interface FakePlatform extends Platform {
  tap(x: number, y: number): void;
  prompts: string[];
  announcements: string[];
  visibility(v: boolean): void;
}

function fakeContext(): Canvas2D {
  let font = '16px sans-serif';
  const noop = (): void => undefined;
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    get font() {
      return font;
    },
    set font(f: string) {
      font = f;
    },
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    save: noop,
    restore: noop,
    setTransform: noop,
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillText: noop,
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
      let w = 0;
      for (const ch of text) w += ch.charCodeAt(0) > 255 ? size : size * 0.55;
      return { width: w };
    },
  };
}

export function createFakePlatform(options: { clock: Clock; random: RandomSource; storage?: StoragePort }): FakePlatform {
  const pointer = new Set<(e: PointerInput) => void>();
  const vis = new Set<(v: boolean) => void>();
  const ctx = fakeContext();
  const canvas = { width: 390, height: 844, getContext2d: () => ctx };
  let pid = 0;
  const platform: FakePlatform = {
    kind: 'web',
    viewport: () => ({ width: 390, height: 844, pixelRatio: 1, safeArea: { top: 20, right: 0, bottom: 12, left: 0 } }),
    createCanvas: () => canvas,
    requestFrame: (fn) => options.clock.setTimeout(() => fn(options.clock.now()), 16),
    onPointer(fn) {
      pointer.add(fn);
      return () => pointer.delete(fn);
    },
    onResize: () => () => undefined,
    onVisibility(fn) {
      vis.add(fn);
      return () => vis.delete(fn);
    },
    async promptText() {
      return platform.prompts.shift() ?? null;
    },
    keepScreenOn: () => undefined,
    audio: {
      announce: (t) => platform.announcements.push(t),
      cue: () => undefined,
      setMuted: () => undefined,
      dispose: () => undefined,
    },
    storage: options.storage ?? createMemoryStorage(),
    clock: options.clock,
    random: options.random,
    dispose: () => undefined,
    tap(x, y) {
      const id = ++pid;
      pointer.forEach((fn) => fn({ type: 'down', pointerId: id, x, y }));
      pointer.forEach((fn) => fn({ type: 'up', pointerId: id, x, y }));
    },
    prompts: [],
    announcements: [],
    visibility(v) {
      vis.forEach((fn) => fn(v));
    },
  };
  return platform;
}

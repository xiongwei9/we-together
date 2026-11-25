/**
 * Platform ports（设计 §6.1）。
 * 共享核心只依赖这里的窄接口，不引用 HTMLCanvasElement、wx 等平台类型。
 */

export type Unsubscribe = () => void;

export interface Viewport {
  /** 逻辑宽高（CSS px / 小游戏逻辑像素） */
  width: number;
  height: number;
  /** 画布像素 / 逻辑像素 */
  pixelRatio: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}

export interface Clock {
  /** 单调时间（ms） */
  now(): number;
  setTimeout(fn: () => void, ms: number): Unsubscribe;
}

export interface RandomSource {
  bytes(length: number): Promise<Uint8Array>;
}

export interface StoragePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface TextMetricsLike {
  width: number;
}

/** CanvasRenderingContext2D 的最小子集 */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  textBaseline: 'top' | 'middle' | 'alphabetic' | 'bottom' | 'hanging' | 'ideographic';
  globalAlpha: number;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): TextMetricsLike;
}

export interface CanvasPort {
  /** 像素尺寸 */
  width: number;
  height: number;
  getContext2d(): Canvas2D;
}

export interface PointerInput {
  type: 'down' | 'move' | 'up' | 'cancel';
  pointerId: number;
  /** 逻辑坐标 */
  x: number;
  y: number;
}

export interface TextInputOptions {
  title: string;
  initial?: string;
  placeholder?: string;
  maxLength?: number;
  numeric?: boolean;
}

export interface AudioPort {
  /** 公共裁判播报（文字转语音或预录音频，由平台决定） */
  announce(text: string): void;
  /** 短提示音 */
  cue(name: 'tick' | 'alert' | 'success'): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export interface Platform {
  readonly kind: 'web' | 'wechat';
  viewport(): Viewport;
  createCanvas(): CanvasPort;
  requestFrame(fn: (time: number) => void): Unsubscribe;
  onPointer(fn: (event: PointerInput) => void): Unsubscribe;
  onResize(fn: (view: Viewport) => void): Unsubscribe;
  onVisibility(fn: (visible: boolean) => void): Unsubscribe;
  promptText(options: TextInputOptions): Promise<string | null>;
  keepScreenOn(on: boolean): void;
  audio: AudioPort;
  storage: StoragePort;
  clock: Clock;
  random: RandomSource;
  dispose(): void;
}

/** 每实例独立的内存存储（Web 模拟器与测试使用） */
export function createMemoryStorage(initial?: Iterable<[string, string]>): StoragePort & {
  snapshot(): Record<string, string>;
} {
  const data = new Map<string, string>(initial);
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    snapshot() {
      return Object.fromEntries(data);
    },
  };
}

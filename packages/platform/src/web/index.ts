import type { AudioPort, Canvas2D, CanvasPort, Clock, Platform, PointerInput, RandomSource, StoragePort, TextInputOptions, Unsubscribe, Viewport } from '../index';

/**
 * Web 平台适配（设计 §6.1 / §13.3）。
 * 每个模拟实例注入独立 Canvas、Storage、文本输入 overlay；帧调度使用页面级单个 RAF。
 */

export interface FrameScheduler {
  request(fn: (time: number) => void): Unsubscribe;
  dispose(): void;
}

/** 页面级 RAF 调度器：多个实例共享一个 requestAnimationFrame */
export function createFrameScheduler(): FrameScheduler {
  const pending = new Set<(time: number) => void>();
  let handle: number | null = null;
  const loop = (time: number): void => {
    handle = null;
    const batch = [...pending];
    pending.clear();
    for (const fn of batch) fn(time);
  };
  return {
    request(fn) {
      pending.add(fn);
      if (handle === null) handle = requestAnimationFrame(loop);
      return () => pending.delete(fn);
    },
    dispose() {
      if (handle !== null) cancelAnimationFrame(handle);
      pending.clear();
    },
  };
}

export function createRealClock(): Clock {
  return {
    now: () => performance.now(),
    setTimeout(fn, ms) {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  };
}

export function createWebRandom(): RandomSource {
  if (!globalThis.crypto?.getRandomValues) throw new Error('crypto.getRandomValues unavailable');
  return {
    async bytes(length) {
      const out = new Uint8Array(length);
      crypto.getRandomValues(out);
      return out;
    },
  };
}

let sharedAudioContext: AudioContext | null = null;

/** 页面需通过一次用户操作解锁音频 */
function unlockWebAudio(): void {
  try {
    sharedAudioContext ??= new AudioContext();
    void sharedAudioContext.resume();
  } catch {
    /* 音频不可用时静默降级为纯文字 */
  }
}

function createWebAudio(initialMuted: boolean): AudioPort {
  let muted = initialMuted;
  const tones: Record<'tick' | 'alert' | 'success', [number, number]> = { tick: [880, 0.06], alert: [440, 0.25], success: [660, 0.15] };
  return {
    announce(text) {
      if (muted || typeof speechSynthesis === 'undefined') return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    },
    cue(name) {
      if (muted || !sharedAudioContext) return;
      const [freq, dur] = tones[name];
      const ctx = sharedAudioContext;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    },
    setMuted(m) {
      muted = m;
      if (m && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    },
    dispose() {
      muted = true;
    },
  };
}

interface WebPlatformOptions {
  canvas: HTMLCanvasElement;
  /** 文本输入 overlay 的挂载容器（与 Canvas 同一 Tile，position: relative） */
  overlayHost: HTMLElement;
  logicalSize: { width: number; height: number };
  safeArea?: Viewport['safeArea'];
  storage: StoragePort;
  clock: Clock;
  random: RandomSource;
  frames: FrameScheduler;
  muted?: boolean;
}

export function createWebPlatform(options: WebPlatformOptions): Platform {
  const { canvas, overlayHost, logicalSize, storage, clock, random, frames } = options;
  const safeArea = options.safeArea ?? { top: 20, right: 0, bottom: 12, left: 0 };
  const cleanups: Unsubscribe[] = [];
  const resizeHandlers = new Set<(v: Viewport) => void>();
  const visibilityHandlers = new Set<(v: boolean) => void>();
  const audio = createWebAudio(options.muted ?? false);
  let activePrompt: { cancel(): void } | null = null;

  const viewport = (): Viewport => {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width > 0 ? rect.width : logicalSize.width;
    return {
      width: logicalSize.width,
      height: logicalSize.height,
      pixelRatio: Math.max(0.5, (cssWidth * (window.devicePixelRatio || 1)) / logicalSize.width),
      safeArea,
    };
  };

  const canvasPort: CanvasPort = {
    get width() {
      return canvas.width;
    },
    set width(v) {
      canvas.width = v;
    },
    get height() {
      return canvas.height;
    },
    set height(v) {
      canvas.height = v;
    },
    getContext2d() {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D unavailable');
      return ctx as unknown as Canvas2D;
    },
  };

  const observer = new ResizeObserver(() => {
    const v = viewport();
    resizeHandlers.forEach((h) => h(v));
  });
  observer.observe(canvas);
  cleanups.push(() => observer.disconnect());

  /** 按 Canvas 自身的显示矩形映射回逻辑坐标（处理网格缩放） */
  const toLogical = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * logicalSize.width,
      y: ((e.clientY - rect.top) / rect.height) * logicalSize.height,
    };
  };

  return {
    kind: 'web',
    viewport,
    createCanvas: () => canvasPort,
    requestFrame: (fn) => frames.request(fn),
    onPointer(fn) {
      const map = (type: PointerInput['type']) => (e: PointerEvent) => {
        if (type === 'down') {
          canvas.setPointerCapture?.(e.pointerId);
          unlockWebAudio();
        }
        const p = toLogical(e);
        fn({ type, pointerId: e.pointerId, x: p.x, y: p.y });
        e.preventDefault();
      };
      const handlers: [string, (e: PointerEvent) => void][] = [
        ['pointerdown', map('down')],
        ['pointermove', map('move')],
        ['pointerup', map('up')],
        ['pointercancel', map('cancel')],
      ];
      handlers.forEach(([t, h]) => canvas.addEventListener(t, h as EventListener));
      return () => handlers.forEach(([t, h]) => canvas.removeEventListener(t, h as EventListener));
    },
    onResize(fn) {
      resizeHandlers.add(fn);
      return () => resizeHandlers.delete(fn);
    },
    // 实例级 show/hide 由模拟器通过 GameInstance.setVisible 驱动；页面级可见性由实例管理器处理
    onVisibility(fn) {
      visibilityHandlers.add(fn);
      return () => visibilityHandlers.delete(fn);
    },
    promptText(opts: TextInputOptions) {
      activePrompt?.cancel();
      return new Promise<string | null>((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'we-prompt';
        const box = document.createElement('div');
        box.className = 'we-prompt-box';
        const title = document.createElement('div');
        title.className = 'we-prompt-title';
        title.textContent = opts.title;
        const input = document.createElement('input');
        input.value = opts.initial ?? '';
        input.placeholder = opts.placeholder ?? '';
        if (opts.maxLength) input.maxLength = opts.maxLength;
        if (opts.numeric) input.inputMode = 'numeric';
        const actions = document.createElement('div');
        actions.className = 'we-prompt-actions';
        const ok = document.createElement('button');
        ok.textContent = '确定';
        const cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.className = 'secondary';
        actions.append(cancel, ok);
        box.append(title, input, actions);
        wrap.append(box);
        overlayHost.append(wrap);
        const finish = (value: string | null): void => {
          wrap.remove();
          if (activePrompt === handle) activePrompt = null;
          resolve(value);
        };
        const handle = { cancel: () => finish(null) };
        activePrompt = handle;
        ok.onclick = () => finish(input.value);
        cancel.onclick = () => finish(null);
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(input.value);
          if (e.key === 'Escape') finish(null);
        };
        wrap.onpointerdown = (e) => {
          if (e.target === wrap) finish(null);
        };
        setTimeout(() => input.focus({ preventScroll: true }), 0);
      });
    },
    keepScreenOn() {
      /* PC 模拟器不需要 */
    },
    audio,
    storage,
    clock,
    random,
    dispose() {
      activePrompt?.cancel();
      cleanups.forEach((c) => c());
      resizeHandlers.clear();
      visibilityHandlers.clear();
      audio.dispose();
    },
  };
}

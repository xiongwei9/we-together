import type { AudioPort, Canvas2D, CanvasPort, Clock, Platform, PointerInput, RandomSource, StoragePort, TextInputOptions, Unsubscribe, Viewport } from '../index';

/**
 * Web 平台适配（设计 §6.1 / §13.3）。
 * 模拟器：每个实例注入独立 Canvas、Storage、文本输入 overlay；帧调度使用页面级单个 RAF。
 * Web 客户端：单个实例占满页面（`page: true`），逻辑尺寸跟随 Canvas 显示尺寸，存储使用 localStorage。
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

/**
 * localStorage 存储（Web 客户端）；按前缀隔离键名。
 * 隐私模式等不可用时退化为内存存储（刷新后丢失，不影响游戏）。
 */
export function createLocalStorage(prefix: string): StoragePort {
  const fallback = new Map<string, string>();
  const attempt = <T>(fn: (ls: Storage) => T, otherwise: () => T): T => {
    try {
      return fn(window.localStorage);
    } catch {
      return otherwise();
    }
  };
  return {
    async get(key) {
      return attempt((ls) => ls.getItem(prefix + key), () => fallback.get(key) ?? null);
    },
    async set(key, value) {
      attempt((ls) => ls.setItem(prefix + key, value), () => void fallback.set(key, value));
    },
    async remove(key) {
      attempt((ls) => ls.removeItem(prefix + key), () => void fallback.delete(key));
    },
  };
}

interface WebPlatformOptions {
  canvas: HTMLCanvasElement;
  /** 文本输入 overlay 的挂载容器（与 Canvas 同一 Tile，position: relative） */
  overlayHost: HTMLElement;
  /** 固定逻辑尺寸（模拟器模拟手机屏幕）；不提供时跟随 Canvas 的显示尺寸（Web 客户端） */
  logicalSize?: { width: number; height: number };
  /**
   * 单个实例占满整个页面（Web 客户端）：跟随页面可见性（切到后台 / 锁屏）触发 onVisibility，
   * keepScreenOn 使用 Screen Wake Lock API。模拟器由实例管理器驱动可见性，不开启。
   */
  page?: boolean;
  safeArea?: Viewport['safeArea'];
  storage: StoragePort;
  clock: Clock;
  random: RandomSource;
  frames: FrameScheduler;
  muted?: boolean;
}

export function createWebPlatform(options: WebPlatformOptions): Platform {
  const { canvas, overlayHost, storage, clock, random, frames } = options;
  /** 逻辑尺寸：固定值，或 Canvas 当前的 CSS 尺寸 */
  const logicalSize = (): { width: number; height: number } => {
    if (options.logicalSize) return options.logicalSize;
    const rect = canvas.getBoundingClientRect();
    return { width: Math.max(1, rect.width || window.innerWidth), height: Math.max(1, rect.height || window.innerHeight) };
  };
  const safeArea = options.safeArea ?? { top: 20, right: 0, bottom: 12, left: 0 };
  const cleanups: Unsubscribe[] = [];
  const resizeHandlers = new Set<(v: Viewport) => void>();
  const visibilityHandlers = new Set<(v: boolean) => void>();
  const audio = createWebAudio(options.muted ?? false);
  let activePrompt: { cancel(): void } | null = null;

  const viewport = (): Viewport => {
    const size = logicalSize();
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width > 0 ? rect.width : size.width;
    return {
      width: size.width,
      height: size.height,
      pixelRatio: Math.max(0.5, (cssWidth * (window.devicePixelRatio || 1)) / size.width),
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
    const size = logicalSize();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.width,
      y: ((e.clientY - rect.top) / rect.height) * size.height,
    };
  };

  // 屏幕常亮（仅 page 模式）：页面回到前台时浏览器会释放 Wake Lock，需要重新申请
  let wantAwake = false;
  let wakeLock: WakeLockSentinel | null = null;
  const acquireWakeLock = (): void => {
    if (!wantAwake || wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(
      (lock) => {
        if (!wantAwake) return void lock.release();
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock === lock) wakeLock = null;
        });
      },
      () => undefined, // 不支持或被拒绝：静默降级
    );
  };
  if (options.page) {
    const onPageVisibility = (): void => {
      const visible = document.visibilityState === 'visible';
      visibilityHandlers.forEach((h) => h(visible));
      if (visible) acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onPageVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onPageVisibility));
  }

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
    // page 模式跟随页面可见性；模拟器的实例级 show/hide 由实例管理器通过 GameInstance.setVisible 驱动
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
    keepScreenOn(on) {
      // PC 模拟器不需要；Web 客户端（房主）对局中保持屏幕常亮
      if (!options.page) return;
      wantAwake = on;
      if (on) acquireWakeLock();
      else {
        void wakeLock?.release();
        wakeLock = null;
      }
    },
    audio,
    storage,
    clock,
    random,
    dispose() {
      activePrompt?.cancel();
      wantAwake = false;
      void wakeLock?.release();
      wakeLock = null;
      cleanups.forEach((c) => c());
      resizeHandlers.clear();
      visibilityHandlers.clear();
      audio.dispose();
    },
  };
}

/**
 * 浏览器 WebSocket 连接（联网模式中继）。结构上符合 @we/multiplayer 的 RelayConnect：
 * 二进制帧以 Uint8Array 交给上层，文本帧原样交给上层。
 */
export function connectBrowserWebSocket(
  url: string,
  handlers: { open(): void; message(data: Uint8Array | string): void; close(): void },
): { send(data: Uint8Array | string): void; close(): void } {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => handlers.open());
  ws.addEventListener('message', (ev: MessageEvent) => handlers.message(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer)));
  // error 之后浏览器总会触发 close，只需处理 close
  ws.addEventListener('close', () => handlers.close());
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  };
}

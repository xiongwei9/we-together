import type { AudioPort, Canvas2D, CanvasPort, Platform, PointerInput, RandomSource, StoragePort, Unsubscribe, Viewport } from '../index';

/**
 * 微信小游戏平台适配（设计 §6.1）。所有 API 先做能力检测；
 * 权限被拒、API 不存在或调用失败时抛出具体错误，不静默改用云服务。
 */

function createWechatRandom(): RandomSource {
  return {
    bytes(length) {
      return new Promise((resolve, reject) => {
        if (typeof wx.getUserCryptoManager !== 'function') {
          reject(new Error('当前基础库不支持安全随机数（getUserCryptoManager）'));
          return;
        }
        wx.getUserCryptoManager().getRandomValues({
          length,
          success: (res) => resolve(new Uint8Array(res.randomValues)),
          fail: (err) => reject(new Error(`安全随机数不可用：${err.errMsg}`)),
        });
      });
    },
  };
}

function createWechatStorage(): StoragePort {
  return {
    async get(key) {
      try {
        const v: unknown = wx.getStorageSync(key);
        return typeof v === 'string' && v !== '' ? v : null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      wx.setStorageSync(key, value);
    },
    async remove(key) {
      wx.removeStorageSync(key);
    },
  };
}

/** 小游戏没有内置 TTS：公共播报使用预录音频（AssetManifest 中按文本映射），缺失时仅显示文字 */
function createWechatAudio(clips: Record<string, string>): AudioPort {
  let muted = false;
  const ctx = typeof wx.createInnerAudioContext === 'function' ? wx.createInnerAudioContext() : null;
  const play = (src: string | undefined): void => {
    if (muted || !ctx || !src) return;
    ctx.stop();
    ctx.src = src;
    ctx.play();
  };
  return {
    announce: (text) => play(clips[text]),
    cue: (name) => play(clips[`cue:${name}`]),
    setMuted(m) {
      muted = m;
      if (m) ctx?.stop();
    },
    dispose() {
      ctx?.destroy();
    },
  };
}

export function createWechatPlatform(options: { audioClips?: Record<string, string> } = {}): Platform {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const width = info.windowWidth;
  const height = info.windowHeight;
  const dpr = info.pixelRatio || 2;
  const safe = info.safeArea;
  const viewportValue: Viewport = {
    width,
    height,
    pixelRatio: dpr,
    safeArea: {
      top: safe ? safe.top : 20,
      left: safe ? safe.left : 0,
      right: safe ? width - safe.right : 0,
      bottom: safe ? height - safe.bottom : 0,
    },
  };
  // 第一次 createCanvas 得到的是上屏 Canvas
  const screen = wx.createCanvas();
  screen.width = width * dpr;
  screen.height = height * dpr;
  const canvasPort: CanvasPort = {
    get width() {
      return screen.width;
    },
    set width(v) {
      screen.width = v;
    },
    get height() {
      return screen.height;
    },
    set height(v) {
      screen.height = v;
    },
    getContext2d: () => screen.getContext('2d') as Canvas2D,
  };
  const perf = typeof wx.getPerformance === 'function' ? wx.getPerformance() : null;
  const cleanups: Unsubscribe[] = [];

  return {
    kind: 'wechat',
    viewport: () => viewportValue,
    createCanvas: () => canvasPort,
    requestFrame(fn) {
      const id = requestAnimationFrame(fn);
      return () => cancelAnimationFrame(id);
    },
    onPointer(fn) {
      const map =
        (type: PointerInput['type']) =>
        (res: { changedTouches: { identifier: number; clientX: number; clientY: number }[] }): void => {
          for (const t of res.changedTouches) fn({ type, pointerId: t.identifier, x: t.clientX, y: t.clientY });
        };
      const down = map('down');
      const move = map('move');
      const up = map('up');
      const cancel = map('cancel');
      wx.onTouchStart(down);
      wx.onTouchMove(move);
      wx.onTouchEnd(up);
      wx.onTouchCancel(cancel);
      return () => {
        wx.offTouchStart(down);
        wx.offTouchMove(move);
        wx.offTouchEnd(up);
        wx.offTouchCancel(cancel);
      };
    },
    onResize() {
      return () => undefined;
    },
    onVisibility(fn) {
      const show = (): void => fn(true);
      const hide = (): void => fn(false);
      wx.onShow(show);
      wx.onHide(hide);
      return () => {
        wx.offShow(show);
        wx.offHide(hide);
      };
    },
    promptText(opts) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v: string | null): void => {
          if (done) return;
          done = true;
          wx.offKeyboardConfirm(onConfirm);
          wx.offKeyboardComplete(onComplete);
          resolve(v);
        };
        const onConfirm = (res: { value: string }): void => {
          finish(res.value);
          wx.hideKeyboard({});
        };
        const onComplete = (res: { value: string }): void => finish(res.value);
        wx.onKeyboardConfirm(onConfirm);
        wx.onKeyboardComplete(onComplete);
        wx.showKeyboard({
          defaultValue: opts.initial ?? '',
          maxLength: opts.maxLength ?? 32,
          multiple: false,
          confirmHold: false,
          confirmType: 'done',
          keyboardType: opts.numeric ? 'number' : 'text',
          fail: () => finish(null),
        });
      });
    },
    keepScreenOn(on) {
      if (typeof wx.setKeepScreenOn === 'function') wx.setKeepScreenOn({ keepScreenOn: on });
    },
    audio: createWechatAudio(options.audioClips ?? {}),
    storage: createWechatStorage(),
    clock: {
      // wx Performance.now() 单位为微秒
      now: () => (perf ? perf.now() / 1000 : Date.now()),
      setTimeout(fn, ms) {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    },
    random: createWechatRandom(),
    dispose() {
      cleanups.forEach((c) => c());
    },
  };
}

import type { Canvas2D, Platform, PointerInput, Unsubscribe } from '@we/platform';
import { createMeasurer, fontOf, layout, lineHeightOf, type LaidOut } from './layout';
import { column, text, theme, type BoxNode, type UINode } from './ui';

/** Scene 生命周期：enter / render / exit；退出时释放全部监听 */
export interface Scene {
  readonly id: string;
  enter?(): void;
  render(): UINode;
  exit?(): void;
}

export interface UiApp {
  setScene(scene: Scene): void;
  /** 状态变化后请求重绘（只在需要时调度帧） */
  invalidate(): void;
  toast(message: string, ms?: number): void;
  /** 倒计时等需要周期性重绘时开启 */
  setTicking(on: boolean): void;
  setVisible(visible: boolean): void;
  /** 测试 / 调试：最近一次布局结果中所有可点击节点 */
  pressables(): { label: string; x: number; y: number; w: number; h: number; disabled: boolean }[];
  /** 测试 / 调试：最近一次布局中按绘制顺序的全部文本 */
  texts(): string[];
  dispose(): void;
}

function roundRect(ctx: Canvas2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

const inside = (l: LaidOut, x: number, y: number): boolean => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h;

type Hit = { kind: 'press'; target: LaidOut } | { kind: 'blocked' } | null;

/** 按可见层级逆序命中；弹窗拦截底层点击 */
function hitTest(l: LaidOut, x: number, y: number): Hit {
  if (l.node.kind !== 'box') return null;
  const box = l.node;
  const within = inside(l, x, y);
  if (!within && !box.absolute) {
    // 子节点不会溢出父节点（absolute 覆盖父容器）
    return null;
  }
  for (let i = l.children.length - 1; i >= 0; i--) {
    const h = hitTest(l.children[i]!, x, y);
    if (h) return h;
  }
  if (!within) return null;
  if (box.onPress && !box.disabled) return { kind: 'press', target: l };
  if (box.blockInput) return { kind: 'blocked' };
  return null;
}

function labelOf(l: LaidOut): string {
  if (l.node.kind === 'text') return l.node.text;
  return l.children.map(labelOf).filter(Boolean).join(' ');
}

export function createUiApp(platform: Platform): UiApp {
  const canvas = platform.createCanvas();
  const ctx = canvas.getContext2d();
  const measurer = createMeasurer(ctx);
  let scene: Scene | null = null;
  let tree: LaidOut | null = null;
  let frameCancel: Unsubscribe | null = null;
  let tickCancel: Unsubscribe | null = null;
  let ticking = false;
  let visible = true;
  let disposed = false;
  let pressed: { pointerId: number; target: LaidOut; inside: boolean } | null = null;
  const toasts: { id: number; message: string }[] = [];
  const toastTimers = new Set<Unsubscribe>();
  let toastSeq = 0;

  const paint = (l: LaidOut): void => {
    const n = l.node;
    if (n.kind === 'text') {
      ctx.font = fontOf(n);
      ctx.fillStyle = n.style.color ?? theme.text;
      ctx.textBaseline = 'top';
      const align = n.style.align ?? 'left';
      ctx.textAlign = align;
      const lh = lineHeightOf(n);
      const size = n.style.size ?? 16;
      const ax = align === 'center' ? l.x + l.w / 2 : align === 'right' ? l.x + l.w : l.x;
      (l.lines ?? []).forEach((line, i) => ctx.fillText(line, ax, l.y + i * lh + (lh - size) / 2));
      return;
    }
    const s = n.style;
    const alpha = s.opacity ?? 1;
    if (alpha !== 1) {
      ctx.save();
      ctx.globalAlpha *= alpha;
    }
    const isPressed = pressed && pressed.inside && pressed.target === l;
    const bg = isPressed && n.pressedBg ? n.pressedBg : s.bg;
    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, l.x, l.y, l.w, l.h, s.radius ?? 0);
      ctx.fill();
    }
    if (s.borderColor && (s.borderWidth ?? 0) > 0) {
      ctx.strokeStyle = s.borderColor;
      ctx.lineWidth = s.borderWidth!;
      const bw = s.borderWidth! / 2;
      roundRect(ctx, l.x + bw, l.y + bw, l.w - 2 * bw, l.h - 2 * bw, s.radius ?? 0);
      ctx.stroke();
    }
    l.children.forEach(paint);
    if (alpha !== 1) ctx.restore();
  };

  const toastLayer = (): BoxNode | null =>
    toasts.length === 0
      ? null
      : {
          kind: 'box',
          dir: 'column',
          absolute: true,
          style: { justify: 'end', align: 'center', padding: [0, 24, 96, 24], gap: 8 },
          children: toasts.map((t) =>
            column({ bg: 'rgba(20,18,28,0.94)', radius: 10, padding: [10, 16, 10, 16], borderColor: theme.border, borderWidth: 1 }, [
              text(t.message, { size: 15, align: 'center' }),
            ]),
          ),
        };

  const draw = (): void => {
    frameCancel = null;
    if (disposed || !visible || !scene) return;
    const vp = platform.viewport();
    if (canvas.width !== Math.round(vp.width * vp.pixelRatio)) canvas.width = Math.round(vp.width * vp.pixelRatio);
    if (canvas.height !== Math.round(vp.height * vp.pixelRatio)) canvas.height = Math.round(vp.height * vp.pixelRatio);
    ctx.setTransform(vp.pixelRatio, 0, 0, vp.pixelRatio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, vp.width, vp.height);
    const root = scene.render();
    const t = toastLayer();
    const full: BoxNode = {
      kind: 'box',
      dir: 'overlay',
      style: {},
      children: t ? [root, t] : [root],
    };
    const prevPressed = pressed;
    tree = layout(measurer, full, 0, 0, vp.width, vp.height);
    if (prevPressed) {
      // 重绘后节点对象变化：按位置重新匹配按下的目标
      const h = hitTest(tree, prevPressed.target.x + 1, prevPressed.target.y + 1);
      pressed = h?.kind === 'press' ? { ...prevPressed, target: h.target } : null;
    }
    paint(tree);
  };

  const invalidate = (): void => {
    if (disposed || frameCancel || !visible) return;
    frameCancel = platform.requestFrame(draw);
  };

  const tick = (): void => {
    tickCancel = null;
    if (!ticking || disposed) return;
    invalidate();
    tickCancel = platform.clock.setTimeout(tick, 500);
  };

  const onPointer = (e: PointerInput): void => {
    if (!tree || !visible) return;
    if (e.type === 'down') {
      if (pressed) return;
      const h = hitTest(tree, e.x, e.y);
      if (h?.kind === 'press') {
        pressed = { pointerId: e.pointerId, target: h.target, inside: true };
        invalidate();
      }
      return;
    }
    if (!pressed || pressed.pointerId !== e.pointerId) return;
    if (e.type === 'move') {
      const now = inside(pressed.target, e.x, e.y);
      if (now !== pressed.inside) {
        pressed.inside = now;
        invalidate();
      }
      return;
    }
    const p = pressed;
    pressed = null;
    invalidate();
    if (e.type === 'up' && inside(p.target, e.x, e.y)) {
      const node = p.target.node;
      if (node.kind === 'box' && node.onPress && !node.disabled) node.onPress();
    }
  };

  const offs: Unsubscribe[] = [platform.onPointer(onPointer), platform.onResize(() => invalidate())];

  return {
    setScene(next) {
      if (scene === next) return;
      scene?.exit?.();
      scene = next;
      pressed = null;
      scene.enter?.();
      invalidate();
    },
    invalidate,
    toast(message, ms = 2200) {
      const id = ++toastSeq;
      toasts.push({ id, message });
      if (toasts.length > 3) toasts.shift();
      const cancel = platform.clock.setTimeout(() => {
        toastTimers.delete(cancel);
        const i = toasts.findIndex((t) => t.id === id);
        if (i >= 0) toasts.splice(i, 1);
        invalidate();
      }, ms);
      toastTimers.add(cancel);
      invalidate();
    },
    setTicking(on) {
      if (on === ticking) return;
      ticking = on;
      if (on) tick();
      else {
        tickCancel?.();
        tickCancel = null;
      }
    },
    setVisible(v) {
      visible = v;
      if (v) invalidate();
      else {
        frameCancel?.();
        frameCancel = null;
        pressed = null;
      }
    },
    pressables() {
      const out: ReturnType<UiApp['pressables']> = [];
      const walk = (l: LaidOut): void => {
        if (l.node.kind === 'box' && l.node.onPress) out.push({ label: labelOf(l), x: l.x, y: l.y, w: l.w, h: l.h, disabled: !!l.node.disabled });
        l.children.forEach(walk);
      };
      if (tree) walk(tree);
      return out;
    },
    texts() {
      const out: string[] = [];
      const walk = (l: LaidOut): void => {
        if (l.node.kind === 'text') out.push(l.node.text);
        l.children.forEach(walk);
      };
      if (tree) walk(tree);
      return out;
    },
    dispose() {
      disposed = true;
      scene?.exit?.();
      scene = null;
      frameCancel?.();
      tickCancel?.();
      toastTimers.forEach((c) => c());
      offs.forEach((off) => off());
    },
  };
}

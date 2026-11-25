import type { Canvas2D } from '@we/platform';
import type { Insets, TextNode, UINode } from './ui';

/** 简单 flex 布局：padding/gap、固定尺寸、flex、对齐、叠放 */

export interface LaidOut {
  node: UINode;
  x: number;
  y: number;
  w: number;
  h: number;
  children: LaidOut[];
  lines?: string[];
}

const FONT_FAMILY = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

export function fontOf(node: TextNode): string {
  return `${node.style.weight === 'bold' ? 'bold ' : ''}${node.style.size ?? 16}px ${FONT_FAMILY}`;
}

export const lineHeightOf = (node: TextNode): number => node.style.lineHeight ?? Math.round((node.style.size ?? 16) * 1.4);

function insets(p: Insets | undefined): [number, number, number, number] {
  if (p === undefined) return [0, 0, 0, 0];
  return typeof p === 'number' ? [p, p, p, p] : p;
}

interface Measurer {
  wrap(node: TextNode, maxWidth: number): { lines: string[]; width: number };
}

export function createMeasurer(ctx: Canvas2D): Measurer {
  const cache = new Map<string, number>();
  const width = (font: string, s: string): number => {
    const key = `${font}|${s}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(s).width;
      if (cache.size > 4000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
  return {
    wrap(node, maxWidth) {
      const font = fontOf(node);
      const lines: string[] = [];
      let widest = 0;
      for (const para of node.text.split('\n')) {
        // 逐字符贪心换行；ASCII 单词尽量不拆
        const tokens = para.match(/[A-Za-z0-9_.:\-/@#%]+|\s|./gu) ?? [''];
        let line = '';
        for (const tok of tokens) {
          const candidate = line + tok;
          if (line && width(font, candidate) > maxWidth) {
            lines.push(line.trimEnd());
            line = tok.trim() ? tok : '';
            while (width(font, line) > maxWidth && line.length > 1) {
              // 超长单词强制拆分
              let cut = line.length - 1;
              while (cut > 1 && width(font, line.slice(0, cut)) > maxWidth) cut--;
              lines.push(line.slice(0, cut));
              line = line.slice(cut);
            }
          } else line = candidate;
        }
        lines.push(line);
      }
      const max = node.style.maxLines;
      if (max && lines.length > max) {
        lines.length = max;
        let last = lines[max - 1]!;
        while (last.length > 0 && width(font, `${last}…`) > maxWidth) last = last.slice(0, -1);
        lines[max - 1] = `${last}…`;
      }
      for (const l of lines) widest = Math.max(widest, width(font, l));
      return { lines, width: Math.min(widest, maxWidth) };
    },
  };
}

interface Size {
  w: number;
  h: number;
}

function measure(m: Measurer, node: UINode, availW: number): Size {
  if (node.kind === 'text') {
    const w = node.style.width ?? availW;
    const { lines, width } = m.wrap(node, w);
    return { w: node.style.width ?? Math.ceil(width), h: lines.length * lineHeightOf(node) };
  }
  const s = node.style;
  const [pt, pr, pb, pl] = insets(s.padding);
  const outerW = s.width ?? availW;
  const innerW = Math.max(0, outerW - pl - pr);
  const gap = s.gap ?? 0;
  let contentW = 0;
  let contentH = 0;
  const kids = node.children.filter((c) => !(c.kind === 'box' && c.absolute));
  if (node.dir === 'row') {
    let remaining = innerW - gap * Math.max(0, kids.length - 1);
    const flexKids = kids.filter((c) => (c.style.flex ?? 0) > 0);
    const totalFlex = flexKids.reduce((n, c) => n + (c.style.flex ?? 0), 0);
    const sizes = new Map<UINode, Size>();
    for (const c of kids) {
      if ((c.style.flex ?? 0) > 0) continue;
      const sz = measure(m, c, Math.max(0, remaining));
      sizes.set(c, sz);
      remaining -= sz.w;
    }
    for (const c of flexKids) sizes.set(c, measure(m, c, Math.max(0, (remaining * (c.style.flex ?? 0)) / totalFlex)));
    for (const c of kids) {
      const sz = sizes.get(c)!;
      contentW += sz.w;
      contentH = Math.max(contentH, sz.h);
    }
    contentW += gap * Math.max(0, kids.length - 1);
  } else if (node.dir === 'column') {
    for (const c of kids) {
      const sz = measure(m, c, innerW);
      contentW = Math.max(contentW, sz.w);
      contentH += sz.h;
    }
    contentH += gap * Math.max(0, kids.length - 1);
  } else {
    for (const c of kids) {
      const sz = measure(m, c, innerW);
      contentW = Math.max(contentW, sz.w);
      contentH = Math.max(contentH, sz.h);
    }
  }
  const h = s.height ?? Math.max(s.minHeight ?? 0, contentH + pt + pb);
  return { w: s.width ?? contentW + pl + pr, h };
}

export function layout(m: Measurer, node: UINode, x: number, y: number, w: number, h: number): LaidOut {
  if (node.kind === 'text') {
    const { lines } = m.wrap(node, w);
    return { node, x, y, w, h, children: [], lines };
  }
  const s = node.style;
  const [pt, pr, pb, pl] = insets(s.padding);
  const ix = x + pl;
  const iy = y + pt;
  const iw = Math.max(0, w - pl - pr);
  const ih = Math.max(0, h - pt - pb);
  const gap = s.gap ?? 0;
  const out: LaidOut = { node, x, y, w, h, children: [] };
  const flow = node.children.filter((c) => !(c.kind === 'box' && c.absolute));
  const flexOf = (c: UINode): number => c.style.flex ?? 0;

  if (node.dir === 'overlay') {
    for (const c of node.children) {
      if (c.kind === 'box' && c.absolute) out.children.push(layout(m, c, x, y, w, h));
      else out.children.push(layout(m, c, ix, iy, iw, ih));
    }
    return out;
  }

  const isRow = node.dir === 'row';
  const align = s.align ?? (isRow ? 'center' : 'stretch');
  const mainAvail = (isRow ? iw : ih) - gap * Math.max(0, flow.length - 1);
  const sizes = flow.map((c) => {
    if (isRow) {
      const sz = flexOf(c) > 0 ? { w: 0, h: measure(m, c, iw).h } : measure(m, c, c.style.width ?? iw);
      return { main: flexOf(c) > 0 ? 0 : sz.w, cross: sz.h };
    }
    const crossW = align === 'stretch' ? iw : Math.min(iw, measure(m, c, iw).w);
    const sz = measure(m, c, crossW);
    return { main: flexOf(c) > 0 ? 0 : sz.h, cross: align === 'stretch' ? iw : sz.w };
  });
  const used = sizes.reduce((n, sz) => n + sz.main, 0);
  const totalFlex = flow.reduce((n, c) => n + flexOf(c), 0);
  const free = Math.max(0, mainAvail - used);
  flow.forEach((c, i) => {
    if (flexOf(c) > 0) sizes[i]!.main = (free * flexOf(c)) / totalFlex;
  });
  if (isRow) {
    // flex 子项在确定宽度后重新测量高度
    flow.forEach((c, i) => {
      if (flexOf(c) > 0) sizes[i]!.cross = measure(m, c, sizes[i]!.main).h;
    });
  }
  const total = sizes.reduce((n, sz) => n + sz.main, 0) + gap * Math.max(0, flow.length - 1);
  let cursor = 0;
  let spacing = gap;
  const justify = totalFlex > 0 ? 'start' : (s.justify ?? 'start');
  const mainSize = isRow ? iw : ih;
  if (justify === 'center') cursor = (mainSize - total) / 2;
  else if (justify === 'end') cursor = mainSize - total;
  else if (justify === 'space-between' && flow.length > 1) spacing = gap + (mainSize - total) / (flow.length - 1);

  flow.forEach((c, i) => {
    const sz = sizes[i]!;
    const crossSize = isRow ? ih : iw;
    const childCross = align === 'stretch' ? crossSize : Math.min(sz.cross, crossSize);
    const crossOffset = align === 'center' ? (crossSize - childCross) / 2 : align === 'end' ? crossSize - childCross : 0;
    out.children.push(
      isRow
        ? layout(m, c, ix + cursor, iy + crossOffset, sz.main, childCross)
        : layout(m, c, ix + crossOffset, iy + cursor, childCross, sz.main),
    );
    cursor += sz.main + spacing;
  });
  for (const c of node.children) if (c.kind === 'box' && c.absolute) out.children.push(layout(m, c, x, y, w, h));
  return out;
}

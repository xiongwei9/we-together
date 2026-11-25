/** 轻量节点树 + 声明式工厂函数（设计 §6.2）。不实现 JSX / reconciler / Hooks。 */

export type Insets = number | [number, number, number, number];

interface BoxStyle {
  width?: number;
  height?: number;
  minHeight?: number;
  flex?: number;
  padding?: Insets;
  gap?: number;
  /** 交叉轴对齐 */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** 主轴分布 */
  justify?: 'start' | 'center' | 'end' | 'space-between';
  bg?: string;
  radius?: number;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
}

interface TextStyle {
  size?: number;
  color?: string;
  weight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  maxLines?: number;
  flex?: number;
  width?: number;
}

export interface BoxNode {
  kind: 'box';
  dir: 'row' | 'column' | 'overlay';
  style: BoxStyle;
  children: UINode[];
  onPress?: () => void;
  disabled?: boolean;
  pressedBg?: string;
  /** 弹窗遮罩：拦截底层点击 */
  blockInput?: boolean;
  /** 弹窗：绝对定位覆盖整个父容器 */
  absolute?: boolean;
}

export interface TextNode {
  kind: 'text';
  text: string;
  style: TextStyle;
}

export type UINode = BoxNode | TextNode;
type Child = UINode | null | undefined | false;

const compact = (children: readonly Child[]): UINode[] => children.filter((c): c is UINode => !!c);

export const theme = {
  bg: '#14121c',
  surface: '#221f2e',
  surfaceAlt: '#2c2840',
  border: '#3b3654',
  text: '#f1edff',
  muted: '#9a93b8',
  primary: '#c9a24d',
  primaryText: '#1a1408',
  danger: '#c8504a',
  success: '#4fae7b',
  wolf: '#d0574f',
  good: '#5b9ee0',
  night: '#0d0c17',
  overlay: 'rgba(5,4,10,0.72)',
} as const;

export function column(style: BoxStyle, children: readonly Child[]): BoxNode {
  return { kind: 'box', dir: 'column', style, children: compact(children) };
}

export function row(style: BoxStyle, children: readonly Child[]): BoxNode {
  return { kind: 'box', dir: 'row', style: { align: 'center', ...style }, children: compact(children) };
}

export function spacer(flex = 1): BoxNode {
  return { kind: 'box', dir: 'column', style: { flex }, children: [] };
}

export function text(value: string, style: TextStyle = {}): TextNode {
  return { kind: 'text', text: value, style };
}

interface ButtonOptions {
  onPress?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'selected';
  height?: number;
  width?: number;
  flex?: number;
  size?: number;
}

export function button(label: string, options: ButtonOptions = {}): BoxNode {
  const variant = options.variant ?? 'primary';
  const palette: Record<NonNullable<ButtonOptions['variant']>, { bg: string; fg: string; pressed: string; border?: string }> = {
    primary: { bg: theme.primary, fg: theme.primaryText, pressed: '#a7843a' },
    secondary: { bg: theme.surfaceAlt, fg: theme.text, pressed: '#3a3554', border: theme.border },
    danger: { bg: theme.danger, fg: '#fff', pressed: '#9e3d38' },
    ghost: { bg: 'rgba(0,0,0,0)', fg: theme.muted, pressed: 'rgba(255,255,255,0.08)' },
    selected: { bg: '#5a4a20', fg: theme.primary, pressed: '#4a3c18', border: theme.primary },
  };
  const p = palette[variant];
  return {
    kind: 'box',
    dir: 'row',
    style: {
      height: options.height ?? 48,
      width: options.width,
      flex: options.flex,
      bg: p.bg,
      radius: 12,
      align: 'center',
      justify: 'center',
      padding: [0, 16, 0, 16],
      borderColor: p.border,
      borderWidth: p.border ? 1 : 0,
      // 没有可执行操作的按钮一律置灰
      opacity: options.disabled || !options.onPress ? 0.4 : 1,
    },
    pressedBg: p.pressed,
    onPress: options.onPress,
    disabled: options.disabled || !options.onPress,
    children: [text(label, { size: options.size ?? 17, color: p.fg, weight: 'bold', align: 'center', maxLines: 1 })],
  };
}

export function card(children: readonly Child[], style: BoxStyle = {}): BoxNode {
  return column({ bg: theme.surface, radius: 14, padding: 16, gap: 10, borderColor: theme.border, borderWidth: 1, ...style }, children);
}

export function list<T>(items: readonly T[], render: (item: T, index: number) => UINode, style: BoxStyle = {}): BoxNode {
  return column({ gap: 8, ...style }, items.map(render));
}

/** 可点击的任意容器 */
export function pressable(node: BoxNode, onPress: (() => void) | undefined, options: { disabled?: boolean; pressedBg?: string } = {}): BoxNode {
  return { ...node, onPress, disabled: options.disabled || !onPress, pressedBg: options.pressedBg ?? 'rgba(255,255,255,0.08)' };
}

/** 模态弹窗：遮罩拦截底层点击，内容居中 */
export function modal(content: UINode, options: { onDismiss?: () => void } = {}): BoxNode {
  return {
    kind: 'box',
    dir: 'column',
    absolute: true,
    blockInput: true,
    onPress: options.onDismiss,
    style: { bg: theme.overlay, padding: 24, justify: 'center', align: 'stretch' },
    // 内容区域同样拦截点击，避免点到内容时触发遮罩的关闭
    children: [content.kind === 'box' ? { ...content, blockInput: true } : content],
  };
}

/** 叠放：后面的子节点覆盖在前面之上 */
export function stack(children: readonly Child[], style: BoxStyle = {}): BoxNode {
  return { kind: 'box', dir: 'overlay', style, children: compact(children) };
}

import { COLORS, type Card, type Color, type ColumnScore, type Expeditions } from './types';

/** 60 张牌（§2.1）：每色 2–10 数字牌各一张 + 3 张握手牌，ID 唯一 */
export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const color of COLORS) {
    for (let w = 1; w <= 3; w++) cards.push({ id: `${color}-w${w}`, color, value: null });
    for (let v = 2; v <= 10; v++) cards.push({ id: `${color}-${v}`, color, value: v });
  }
  return cards;
}

export const emptyExpeditions = (): Expeditions => ({ red: [], yellow: [], blue: [], green: [], white: [] });

export const emptyPiles = (): Record<Color, Card[]> => ({ red: [], yellow: [], blue: [], green: [], white: [] });

/** 能否把 card 追加到同色探险列末尾（§5） */
export function canAppend(column: readonly Card[], card: Card): boolean {
  const last = column[column.length - 1];
  if (!last) return true;
  if (last.color !== card.color) return false;
  // 握手牌只能在所有数字牌之前
  if (card.value === null) return last.value === null;
  return last.value === null || card.value > last.value;
}

/** 单列计分（§7.1）：score = (S − 20) × (W + 1) + (N ≥ 8 ? 20 : 0)；空列 0 分 */
export function scoreColumn(column: readonly Card[]): ColumnScore {
  const count = column.length;
  const wagers = column.filter((c) => c.value === null).length;
  const sum = column.reduce((s, c) => s + (c.value ?? 0), 0);
  if (count === 0) return { sum: 0, wagers: 0, count: 0, bonus: false, score: 0 };
  const bonus = count >= 8;
  return { sum, wagers, count, bonus, score: (sum - 20) * (wagers + 1) + (bonus ? 20 : 0) };
}

export function scoreExpeditions(exp: Expeditions): { columns: Record<Color, ColumnScore>; total: number } {
  const columns = Object.fromEntries(COLORS.map((c) => [c, scoreColumn(exp[c])])) as Record<Color, ColumnScore>;
  return { columns, total: COLORS.reduce((s, c) => s + columns[c].score, 0) };
}

import { canAppend } from './cards';
import { COLORS, type Card, type Color, type LostCitiesAction, type LostCitiesPlayerView } from './types';

/**
 * 测试 / 模拟器用的简单 Bot：只读取本玩家的授权视图，经正常 Client 命令链路提交。
 * 返回 null 表示当前无需行动。
 */
export function chooseBotAction(view: LostCitiesPlayerView, rng: () => number): LostCitiesAction | null {
  if (!view.me || view.result || !view.pendingAction || view.submitted) return null;
  const me = view.players.find((p) => p.playerId === view.me!.playerId)!;
  const opp = view.players.find((p) => p.playerId !== me.playerId)!;
  const hand = view.me.hand;
  const lastValue = (col: readonly Card[]): number | null => {
    const last = col[col.length - 1];
    return last ? (last.value ?? 1) : null;
  };
  /** 打出这张牌会跳过的点数；未开启的列以 1 为起点 */
  const gap = (c: Card): number => (c.value ?? 1) - (lastValue(me.expeditions[c.color]) ?? 1);
  const colorSum = (color: Color): number => hand.filter((c) => c.color === color).reduce((s, c) => s + (c.value ?? 0), 0);
  const started = (color: Color): boolean => me.expeditions[color].length > 0;
  const playable = (c: Card): boolean => canAppend(me.expeditions[c.color], c);

  switch (view.pendingAction) {
    case 'next-round':
      return { type: 'NEXT_ROUND' };
    case 'play': {
      // 1. 已开启的列：优先跳过点数最少的牌
      const extend = hand.filter((c) => started(c.color) && playable(c) && gap(c) <= 3).sort((a, b) => gap(a) - gap(b));
      if (extend[0]) return { type: 'PLAY', cardId: extend[0].id };
      // 2. 手中同色点数足够时开启新探险（牌堆还多时才敢用握手牌）
      const opener = COLORS.filter((c) => !started(c) && colorSum(c) >= 22)
        .sort((a, b) => colorSum(b) - colorSum(a))
        .map((color) => {
          const cards = hand.filter((c) => c.color === color).sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
          return view.deckCount > 25 && colorSum(color) >= 27 ? cards[0] : cards.find((c) => c.value !== null);
        })
        .find((c): c is Card => !!c);
      if (opener && view.deckCount > 12) return { type: 'PLAY', cardId: opener.id };
      // 3. 弃牌：先弃已无法打出的牌，再弃对手用不上、同色手牌最少的牌
      const oppCanUse = (c: Card): boolean => opp.expeditions[c.color].length > 0 && canAppend(opp.expeditions[c.color], c);
      const usefulness = (c: Card): number => (playable(c) ? 100 : 0) + (started(c.color) ? 40 : 0) + colorSum(c.color) + (oppCanUse(c) ? 50 : 0) - (c.value ?? 5);
      const discard = [...hand].sort((a, b) => usefulness(a) - usefulness(b))[0]!;
      // 没有可延伸的牌但牌堆快空时，宁可在已开启的列跳大步
      const late = hand.filter((c) => started(c.color) && playable(c) && c.value !== null).sort((a, b) => gap(a) - gap(b))[0];
      if (late && view.deckCount <= 6) return { type: 'PLAY', cardId: late.id };
      return { type: 'DISCARD', cardId: discard.id };
    }
    case 'draw': {
      // 弃牌暗置：偶尔盲抽自己已开启颜色的弃牌堆，否则抽牌堆
      const blind = COLORS.filter((c) => view.discardCounts[c] > 0 && c !== view.blockedDiscard && started(c));
      if (blind.length && rng() < 0.15) return { type: 'DRAW', source: blind[Math.floor(rng() * blind.length)]! };
      if (view.deckCount > 0) return { type: 'DRAW', source: 'deck' };
      const any = COLORS.find((c) => view.discardCounts[c] > 0 && c !== view.blockedDiscard);
      return any ? { type: 'DRAW', source: any } : null;
    }
  }
}

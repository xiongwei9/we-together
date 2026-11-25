import { scoreExpeditions } from './cards';
import { totals } from './engine';
import { COLORS, type Card, type Color, type Expeditions, type LostCitiesPlayerView, type LostCitiesState, type PendingAction, type PublicMove, type VisibleMove } from './types';

const copyCard = (c: Card): Card => ({ id: c.id, color: c.color, value: c.value });
/** 弃牌暗置：他人弃出的牌只公开颜色 */
const visibleMove = (m: PublicMove, viewer: string): VisibleMove => ({
  playerId: m.playerId,
  kind: m.kind,
  color: m.card.color,
  card: m.kind === 'play' || m.playerId === viewer ? copyCard(m.card) : null,
  draw: m.draw,
  auto: m.auto,
});
const copyExpeditions = (e: Expeditions): Expeditions => Object.fromEntries(COLORS.map((c) => [c, e[c].map(copyCard)])) as Expeditions;

function pendingFor(s: LostCitiesState, id: string): PendingAction {
  if (s.result || !(id in s.seats)) return null;
  if (s.phase === 'round-end') return 'next-round';
  if (s.current !== id) return null;
  return s.phase === 'play' ? 'play' : s.phase === 'draw' ? 'draw' : null;
}

/**
 * 显式白名单投影（§9.3）：本人手牌、双方探险列、各色弃牌堆张数、抽牌堆数量与公开记录；
 * 不包含抽牌堆牌面与顺序、对手手牌、弃牌牌面（弃牌暗置）和 Host 种子。
 */
export function projectView(s: LostCitiesState, playerId: string): LostCitiesPlayerView {
  const t = totals(s);
  const mine = s.players[playerId];
  const pending = pendingFor(s, playerId);
  return {
    rulesVersion: s.rulesVersion,
    rules: { rounds: s.config.rounds, turnSec: s.config.turnSec },
    round: s.round,
    phase: s.phase,
    players: s.order.map((id) => {
      const p = s.players[id]!;
      return {
        playerId: id,
        seat: s.seats[id]!,
        handCount: p.hand.length,
        expeditions: copyExpeditions(p.expeditions),
        roundScore: scoreExpeditions(p.expeditions).total,
        total: t[id]!,
      };
    }),
    me: mine ? { playerId, hand: mine.hand.map(copyCard) } : null,
    current: s.current,
    starter: s.starter,
    deckCount: s.deck.length,
    discardCounts: Object.fromEntries(COLORS.map((c) => [c, s.discards[c].length])) as Record<Color, number>,
    blockedDiscard: s.phase === 'draw' ? s.justDiscarded : null,
    pendingAction: pending,
    submitted: pending === 'next-round' && s.nextReady.includes(playerId),
    nextReadyCount: s.nextReady.length,
    pendingMove: s.pendingMove ? visibleMove(s.pendingMove, playerId) : null,
    moves: s.moves.map((m) => visibleMove(m, playerId)),
    history: JSON.parse(JSON.stringify(s.history)) as LostCitiesPlayerView['history'],
    result: s.result ? { winner: s.result.winner, totals: { ...s.result.totals }, resigned: s.result.resigned } : null,
  };
}

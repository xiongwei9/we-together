import { seededShuffle, type Validation } from '@we/multiplayer';
import { canAppend, createDeck, emptyExpeditions, emptyPiles, scoreExpeditions } from './cards';
import type { Card, DrawSource, LostCitiesAction, LostCitiesEvent, LostCitiesResult, LostCitiesState, PlayerRoundState, PublicMove, RoundRecord } from './types';

/** 纯规则状态机（§10）：validate 不改状态，reduce 返回新状态 */

const HAND_SIZE = 8;
const MOVE_LOG = 6;

const ok: Validation = { ok: true };
const fail = (code: string): Validation => ({ ok: false, code });

const other = (s: LostCitiesState, id: string): string => (s.order[0] === id ? s.order[1] : s.order[0]);

/** 已结束轮次的累计分 */
export function totals(s: LostCitiesState): Record<string, number> {
  const out: Record<string, number> = { [s.order[0]]: 0, [s.order[1]]: 0 };
  for (const r of s.history) for (const id of s.order) out[id] = out[id]! + (r.scores[id] ?? 0);
  return out;
}

/** 每轮由 Host 私有种子派生独立洗牌种子 */
function roundSeed(seed: readonly number[], round: number): Uint8Array {
  return Uint8Array.from(seed, (b, i) => (b ^ Math.imul(round + 1, 0x9e) ^ (i * 29)) & 0xff);
}

/** 准备新一轮（§3）：洗 60 张，各发 8 张，其余为抽牌堆 */
export function startRound(s: LostCitiesState, round: number, starter: string): LostCitiesState {
  const cards = seededShuffle(createDeck(), roundSeed(s.seed, round));
  const players: Record<string, PlayerRoundState> = {};
  // 从先手开始轮流发牌
  const dealOrder = [starter, other(s, starter)];
  dealOrder.forEach((id) => (players[id] = { hand: [], expeditions: emptyExpeditions() }));
  for (let i = 0; i < HAND_SIZE * 2; i++) players[dealOrder[i % 2]!]!.hand.push(cards[i]!);
  const turn = s.turn + 1;
  return {
    ...s,
    round,
    turn,
    phase: 'play',
    phaseId: `r${round}-t${turn}`,
    starter,
    current: starter,
    deck: cards.slice(HAND_SIZE * 2),
    discards: emptyPiles(),
    players,
    justDiscarded: null,
    pendingMove: null,
    moves: [],
    nextReady: [],
  };
}

/** 后续轮先手（§9.1）：累计分较高者；相同则与上一轮交换 */
function nextStarter(s: LostCitiesState): string {
  const t = totals(s);
  const [a, b] = s.order;
  if (t[a] !== t[b]) return t[a]! > t[b]! ? a : b;
  return other(s, s.starter);
}

function finish(s: LostCitiesState, resigned: string | null): LostCitiesState {
  const t = totals(s);
  const [a, b] = s.order;
  const winner = resigned ? other(s, resigned) : t[a] === t[b] ? null : t[a]! > t[b]! ? a : b;
  const result: LostCitiesResult = { winner, totals: t, resigned };
  return { ...s, phase: 'finished', phaseId: `r${s.round}-finished`, nextReady: [], result };
}

// ---- 校验 -----------------------------------------------------------------

export function validate(s: LostCitiesState, a: LostCitiesAction, actor: string): Validation {
  if (s.result) return fail('GAME_OVER');
  const isPlayer = actor in s.seats;
  switch (a.type) {
    case 'TIMEOUT':
      return actor === 'system' ? ok : fail('NOT_ALLOWED');
    case 'RESIGN':
      return isPlayer ? ok : fail('NOT_PLAYER');
    case 'NEXT_ROUND':
      if (!isPlayer) return fail('NOT_PLAYER');
      if (s.phase !== 'round-end') return fail('WRONG_PHASE');
      return s.nextReady.includes(actor) ? fail('ALREADY_READY') : ok;
    case 'PLAY':
    case 'DISCARD': {
      if (s.phase !== 'play') return fail('WRONG_PHASE');
      if (actor !== s.current) return fail('NOT_YOUR_TURN');
      const card = s.players[actor]!.hand.find((c) => c.id === a.cardId);
      if (!card) return fail('NOT_IN_HAND');
      if (a.type === 'PLAY' && !canAppend(s.players[actor]!.expeditions[card.color], card)) return fail('ILLEGAL_PLAY');
      return ok;
    }
    case 'DRAW': {
      if (s.phase !== 'draw') return fail('WRONG_PHASE');
      if (actor !== s.current) return fail('NOT_YOUR_TURN');
      if (a.source === 'deck') return s.deck.length ? ok : fail('EMPTY_PILE');
      if (a.source === s.justDiscarded) return fail('JUST_DISCARDED');
      return s.discards[a.source].length ? ok : fail('EMPTY_PILE');
    }
  }
}

// ---- 状态转换 ---------------------------------------------------------------

type Result = { state: LostCitiesState; events: LostCitiesEvent[] };

function placeCard(s: LostCitiesState, kind: 'play' | 'discard', cardId: string, auto: boolean): LostCitiesState {
  const me = s.players[s.current]!;
  const card = me.hand.find((c) => c.id === cardId)!;
  const hand = me.hand.filter((c) => c.id !== cardId);
  const move: PublicMove = { playerId: s.current, kind, card, draw: null, auto };
  if (kind === 'play') {
    const expeditions = { ...me.expeditions, [card.color]: [...me.expeditions[card.color], card] };
    return { ...s, phase: 'draw', players: { ...s.players, [s.current]: { hand, expeditions } }, justDiscarded: null, pendingMove: move };
  }
  const discards = { ...s.discards, [card.color]: [...s.discards[card.color], card] };
  return { ...s, phase: 'draw', players: { ...s.players, [s.current]: { ...me, hand } }, discards, justDiscarded: card.color, pendingMove: move };
}

function endRound(s: LostCitiesState): Result {
  const record: RoundRecord = { round: s.round, starter: s.starter, scores: {}, columns: {} };
  for (const id of s.order) {
    const r = scoreExpeditions(s.players[id]!.expeditions);
    record.scores[id] = r.total;
    record.columns[id] = r.columns;
  }
  const scored: LostCitiesState = { ...s, history: [...s.history, record] };
  const events: LostCitiesEvent[] = [{ type: 'round-end', round: s.round, scores: record.scores }];
  if (s.round >= s.config.rounds) {
    const done = finish(scored, null);
    return { state: done, events: [...events, { type: 'finished', result: done.result! }] };
  }
  return { state: { ...scored, phase: 'round-end', phaseId: `r${s.round}-end`, nextReady: [] }, events };
}

function draw(s: LostCitiesState, source: DrawSource, auto: boolean): Result {
  const me = s.players[s.current]!;
  let card: Card;
  let next: LostCitiesState;
  if (source === 'deck') {
    card = s.deck[0]!;
    next = { ...s, deck: s.deck.slice(1) };
  } else {
    const pile = s.discards[source];
    card = pile[pile.length - 1]!;
    next = { ...s, discards: { ...s.discards, [source]: pile.slice(0, -1) } };
  }
  const move: PublicMove = { ...s.pendingMove!, draw: source, auto: s.pendingMove!.auto || auto };
  next = {
    ...next,
    players: { ...next.players, [s.current]: { ...me, hand: [...me.hand, card] } },
    moves: [...s.moves, move].slice(-MOVE_LOG),
    pendingMove: null,
    justDiscarded: null,
  };
  // 抽走抽牌堆最后一张：本轮立即结束，对手没有补偿回合（§6）
  if (source === 'deck' && next.deck.length === 0) return endRound(next);
  const turn = s.turn + 1;
  return { state: { ...next, turn, phase: 'play', phaseId: `r${s.round}-t${turn}`, current: other(s, s.current) }, events: [] };
}

function nextRound(s: LostCitiesState): Result {
  const starter = nextStarter(s);
  const state = startRound(s, s.round + 1, starter);
  return { state, events: [{ type: 'round-start', round: state.round, starter }] };
}

/** 超时随机弃牌：由 Host 私有种子与回合号派生，客户端无法预测 */
function timeoutCardIndex(s: LostCitiesState, handSize: number): number {
  let h = 2166136261 >>> 0;
  for (const b of s.seed) h = Math.imul(h ^ b, 16777619) >>> 0;
  h = Math.imul(h ^ s.turn, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h % handSize;
}

export function reduce(s: LostCitiesState, a: LostCitiesAction, actor: string): Result {
  switch (a.type) {
    case 'PLAY':
      return { state: placeCard(s, 'play', a.cardId, false), events: [] };
    case 'DISCARD':
      return { state: placeCard(s, 'discard', a.cardId, false), events: [] };
    case 'DRAW':
      return draw(s, a.source, false);
    case 'NEXT_ROUND': {
      const ready = [...s.nextReady, actor];
      if (ready.length < s.order.length) return { state: { ...s, nextReady: ready }, events: [] };
      return nextRound(s);
    }
    case 'RESIGN': {
      const done = finish(s, actor);
      return { state: done, events: [{ type: 'finished', result: done.result! }] };
    }
    case 'TIMEOUT':
      // §9.2：未处理手牌时随机弃一张再抽牌堆；已处理时只抽牌堆
      if (s.phase === 'play') {
        const hand = s.players[s.current]!.hand;
        const placed = placeCard(s, 'discard', hand[timeoutCardIndex(s, hand.length)]!.id, true);
        return draw(placed, 'deck', true);
      }
      if (s.phase === 'draw') return draw(s, 'deck', true);
      if (s.phase === 'round-end') return nextRound(s);
      return { state: s, events: [] };
  }
}

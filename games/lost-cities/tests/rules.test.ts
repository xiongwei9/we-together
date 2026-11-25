import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@we/multiplayer';
import { chooseBotAction, createDeck, lostCitiesRules as R, projectView, scoreColumn, type Card, type Color, type LostCitiesAction, type LostCitiesConfig, type LostCitiesState } from '../src/rules';

type S = LostCitiesState;

const DECK = createDeck();
const card = (id: string): Card => {
  const c = DECK.find((x) => x.id === id);
  if (!c) throw new Error(`unknown card ${id}`);
  return c;
};
const cards = (...ids: string[]): Card[] => ids.map(card);

const seed = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7) & 0xff);

function init(config: Partial<LostCitiesConfig> = {}, n = 1): S {
  return R.createInitialState({
    matchId: 'm1',
    players: [
      { playerId: 'a', seat: 1 },
      { playerId: 'b', seat: 2 },
    ],
    config: { ...R.defaultConfig, ...config },
    seed: seed(n),
  });
}

const ctx = (s: S, actorId: string): CommandContext => ({ actorId, now: 0, phaseId: R.phaseId(s) });

function act(s: S, actor: string, a: LostCitiesAction): S {
  const v = R.validate(s, a, ctx(s, actor));
  if (!v.ok) throw new Error(`${a.type} by ${actor} rejected: ${v.code}`);
  return R.reduce(s, a, ctx(s, actor)).state;
}
const code = (s: S, actor: string, a: LostCitiesAction): string | null => {
  const v = R.validate(s, a, ctx(s, actor));
  return v.ok ? null : v.code;
};

/**
 * 受控局面：a 先手，指定 a 的手牌、红色探险列与弃牌堆；其余牌按牌序补足 a、b 的手牌与抽牌堆。
 * 指定 deck 时截断抽牌堆（不再满足 60 张守恒，只用于结算相关用例）。
 */
function setup(opts: { hand: string[]; red?: string[]; deck?: number; discards?: Partial<Record<Color, string[]>> }): S {
  const s = init();
  const fixed = new Set([...opts.hand, ...(opts.red ?? []), ...Object.values(opts.discards ?? {}).flat()]);
  const rest = DECK.filter((c) => !fixed.has(c.id));
  const hand = cards(...opts.hand);
  const filler = rest.splice(0, 8 - hand.length);
  const bHand = rest.splice(0, 8);
  const deckSize = opts.deck ?? rest.length;
  const discards = { red: [], yellow: [], blue: [], green: [], white: [] } as Record<Color, Card[]>;
  for (const [color, ids] of Object.entries(opts.discards ?? {})) discards[color as Color] = cards(...ids!);
  return {
    ...s,
    current: 'a',
    starter: 'a',
    phase: 'play',
    deck: rest.slice(0, deckSize),
    discards,
    players: {
      a: { hand: [...hand, ...filler], expeditions: { red: cards(...(opts.red ?? [])), yellow: [], blue: [], green: [], white: [] } },
      b: { hand: bHand, expeditions: { red: [], yellow: [], blue: [], green: [], white: [] } },
    },
  };
}

/** 一轮内 60 张牌各在一个区域（§10.3） */
function allCards(s: S): string[] {
  const ids: string[] = [...s.deck.map((c) => c.id)];
  for (const pile of Object.values(s.discards)) ids.push(...pile.map((c) => c.id));
  for (const p of Object.values(s.players)) {
    ids.push(...p.hand.map((c) => c.id));
    for (const col of Object.values(p.expeditions)) ids.push(...col.map((c) => c.id));
  }
  return ids;
}

describe('准备与回合（§3–§4）', () => {
  it('T01 新一轮：双方各 8 张，抽牌堆 44 张，其他区为空，60 张不重复', () => {
    const s = init();
    expect(s.players.a!.hand).toHaveLength(8);
    expect(s.players.b!.hand).toHaveLength(8);
    expect(s.deck).toHaveLength(44);
    expect(Object.values(s.discards).every((p) => p.length === 0)).toBe(true);
    const ids = allCards(s);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(s.phase).toBe('play');
    expect(['a', 'b']).toContain(s.current);
  });

  it('同一种子发牌可重放，不同种子发牌不同；首轮先手随种子变化', () => {
    expect(init({}, 3).deck).toEqual(init({}, 3).deck);
    expect(init({}, 3).deck).not.toEqual(init({}, 4).deck);
    const starters = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => init({}, n).starter));
    expect(starters.size).toBe(2);
  });

  it('T02/T03 空列可从任意数字开始；3 后可打 8', () => {
    let s = setup({ hand: ['red-5', 'red-8'] });
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-5' });
    expect(s.players.a!.expeditions.red.map((c) => c.id)).toEqual(['red-5']);
    expect(s.players.a!.hand).toHaveLength(7);
    expect(s.phase).toBe('draw');
    const t = setup({ hand: ['red-8'], red: ['red-3'] });
    expect(code(t, 'a', { type: 'PLAY', cardId: 'red-8' })).toBeNull();
  });

  it('T04 8 后打 6 被拒绝，状态不变', () => {
    const s = setup({ hand: ['red-6'], red: ['red-8'] });
    expect(code(s, 'a', { type: 'PLAY', cardId: 'red-6' })).toBe('ILLEGAL_PLAY');
    expect(code(setup({ hand: ['red-9'], red: ['red-10'] }), 'a', { type: 'PLAY', cardId: 'red-9' })).toBe('ILLEGAL_PLAY');
  });

  it('T05 牌只能进入同色列：蓝牌进入蓝列，红列不受影响', () => {
    let s = setup({ hand: ['blue-8'], red: ['red-3', 'red-5'] });
    s = act(s, 'a', { type: 'PLAY', cardId: 'blue-8' });
    expect(s.players.a!.expeditions.red.map((c) => c.id)).toEqual(['red-3', 'red-5']);
    expect(s.players.a!.expeditions.blue.map((c) => c.id)).toEqual(['blue-8']);
  });

  it('T06/T07 空列可打握手牌并继续追加握手牌；数字牌之后不能打握手牌', () => {
    let s = setup({ hand: ['red-w1', 'red-w2', 'red-w3', 'red-4'] });
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-w1' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    s = act(s, 'b', { type: 'DISCARD', cardId: s.players.b!.hand[0]!.id });
    s = act(s, 'b', { type: 'DRAW', source: 'deck' });
    expect(code(s, 'a', { type: 'PLAY', cardId: 'red-w2' })).toBeNull();
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-w2' });
    expect(s.players.a!.expeditions.red).toHaveLength(2);
    const t = setup({ hand: ['red-w1'], red: ['red-3'] });
    expect(code(t, 'a', { type: 'PLAY', cardId: 'red-w1' })).toBe('ILLEGAL_PLAY');
  });

  it('T08 不能打入探险的牌可以弃掉，放在同色弃牌堆顶部', () => {
    let s = setup({ hand: ['red-4'], red: ['red-8'], discards: { red: ['red-2'] } });
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    expect(s.discards.red.map((c) => c.id)).toEqual(['red-2', 'red-4']);
    expect(s.justDiscarded).toBe('red');
  });

  it('T09/T10/T11 不能抽回刚弃的牌（也不能抽它覆盖的牌）；可抽其他颜色弃牌堆顶', () => {
    let s = setup({ hand: ['red-4'], discards: { red: ['red-2'], blue: ['blue-3', 'blue-9'] } });
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    expect(code(s, 'a', { type: 'DRAW', source: 'red' })).toBe('JUST_DISCARDED');
    expect(code(s, 'a', { type: 'DRAW', source: 'green' })).toBe('EMPTY_PILE');
    s = act(s, 'a', { type: 'DRAW', source: 'blue' });
    // 只能拿堆顶，下一张成为新堆顶
    expect(s.players.a!.hand.some((c) => c.id === 'blue-9')).toBe(true);
    expect(s.discards.blue.map((c) => c.id)).toEqual(['blue-3']);
  });

  it('T12 下一回合可以抽取先前弃掉的牌（包括弃牌者本人）', () => {
    let s = setup({ hand: ['red-4'] });
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(code(s, 'b', { type: 'DRAW', source: 'red' })).toBe('WRONG_PHASE');
    s = act(s, 'b', { type: 'DISCARD', cardId: s.players.b!.hand.find((c) => c.color !== 'red')!.id });
    s = act(s, 'b', { type: 'DRAW', source: 'deck' });
    s = act(s, 'a', { type: 'DISCARD', cardId: s.players.a!.hand.find((c) => c.color !== 'red')!.id });
    expect(code(s, 'a', { type: 'DRAW', source: 'red' })).toBeNull();
    s = act(s, 'a', { type: 'DRAW', source: 'red' });
    expect(s.players.a!.hand.some((c) => c.id === 'red-4')).toBe(true);
  });

  it('T13/T14 不能先抽后打，也不能一回合打两张', () => {
    let s = setup({ hand: ['red-4', 'red-5'] });
    expect(code(s, 'a', { type: 'DRAW', source: 'deck' })).toBe('WRONG_PHASE');
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-4' });
    expect(code(s, 'a', { type: 'PLAY', cardId: 'red-5' })).toBe('WRONG_PHASE');
    expect(code(s, 'a', { type: 'DISCARD', cardId: 'red-5' })).toBe('WRONG_PHASE');
  });

  it('T15 从弃牌堆抽牌不减少抽牌堆数量', () => {
    let s = setup({ hand: ['red-4'], discards: { blue: ['blue-3'] } });
    const before = s.deck.length;
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'blue' });
    expect(s.deck).toHaveLength(before);
    expect(s.players.a!.hand).toHaveLength(8);
    expect(s.current).toBe('b');
  });

  it('T23 非当前玩家提交操作被拒绝；手牌外的牌被拒绝', () => {
    const s = setup({ hand: ['red-4'] });
    expect(code(s, 'b', { type: 'DISCARD', cardId: s.players.b!.hand[0]!.id })).toBe('NOT_YOUR_TURN');
    expect(code(s, 'a', { type: 'PLAY', cardId: s.players.b!.hand[0]!.id })).toBe('NOT_IN_HAND');
    expect(code(s, 'x', { type: 'RESIGN' })).toBe('NOT_PLAYER');
    expect(code(s, 'a', { type: 'TIMEOUT' })).toBe('NOT_ALLOWED');
  });

  it('reduce 不修改输入状态', () => {
    const s = setup({ hand: ['red-4'] });
    const frozen = JSON.stringify(s);
    act(act(s, 'a', { type: 'DISCARD', cardId: 'red-4' }), 'a', { type: 'DRAW', source: 'deck' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('本轮结束（§6）', () => {
  it('T16/T27 抽走最后一张立即结算，对手没有补偿回合；结算后重放抽牌被拒绝，不重复计分', () => {
    let s = setup({ hand: ['red-4'], deck: 1 });
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(s.deck).toHaveLength(0);
    expect(s.phase).toBe('round-end');
    expect(s.history).toHaveLength(1);
    // 最后一张进入手牌但不能再打出
    expect(s.players.a!.hand).toHaveLength(8);
    expect(code(s, 'a', { type: 'DRAW', source: 'deck' })).toBe('WRONG_PHASE');
    expect(code(s, 'b', { type: 'PLAY', cardId: s.players.b!.hand[0]!.id })).toBe('WRONG_PHASE');
    expect(s.history[0]!.scores).toEqual({ a: -16, b: 0 });
  });

  it('T22 手牌不计分：本轮得分只来自探险列', () => {
    let s = setup({ hand: ['red-4', 'blue-10', 'green-10', 'white-10'], deck: 1 });
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(s.history[0]!.scores.a).toBe(0);
  });

  it('双方确认后进入下一轮：重新洗牌发牌，累计分保留；累计分高者先手', () => {
    let s = setup({ hand: ['red-10'], deck: 1 });
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-10' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(s.history[0]!.scores).toEqual({ a: -10, b: 0 });
    s = act(s, 'a', { type: 'NEXT_ROUND' });
    expect(s.phase).toBe('round-end');
    expect(code(s, 'a', { type: 'NEXT_ROUND' })).toBe('ALREADY_READY');
    s = act(s, 'b', { type: 'NEXT_ROUND' });
    expect(s.round).toBe(2);
    expect(s.phase).toBe('play');
    expect(s.starter).toBe('b');
    expect(s.current).toBe('b');
    expect(s.deck).toHaveLength(44);
    expect(allCards(s)).toHaveLength(60);
    expect(s.players.a!.expeditions.red).toHaveLength(0);
    expect(s.history).toHaveLength(1);
  });

  it('累计分相同时与上一轮交换先手；结算阶段超时自动开始下一轮', () => {
    let s = setup({ hand: ['red-4'], deck: 1 });
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(R.timer(s)).toEqual({ phaseId: s.phaseId, ms: R.defaultConfig.roundEndMs });
    s = act(s, 'system', { type: 'TIMEOUT' });
    expect(s.round).toBe(2);
    expect(s.starter).toBe('b');
  });

  it('T24 比赛按累计分决胜（只赢一轮也可获胜）；T25 累计分相同判平局', () => {
    const base = init({ rounds: 3 });
    const record = (round: number, a: number, b: number): S['history'][number] => ({ round, starter: 'a', scores: { a, b }, columns: {} });
    const last = (history: S['history']): S => {
      let s: S = { ...setup({ hand: ['red-4'], deck: 1 }), round: 3, history, config: base.config };
      s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
      return act(s, 'a', { type: 'DRAW', source: 'deck' });
    };
    // 第 3 轮双方均 0 分：A 30 − 10 = 20，B 32 + 0 = 32
    const s1 = last([record(1, 30, 32), record(2, -10, 0)]);
    expect(s1.phase).toBe('finished');
    expect(s1.result).toEqual({ winner: 'b', totals: { a: 20, b: 32 }, resigned: null });
    // A 只赢最后一轮但累计更高
    const s2 = last([record(1, 30, 32), record(2, 32, 20)]);
    expect(s2.result?.winner).toBe('a');
    const s3 = last([record(1, 10, 5), record(2, -5, 0)]);
    expect(s3.result?.winner).toBeNull();
  });

  it('快速模式 1 轮：第一轮结算后直接结束比赛', () => {
    let s: S = { ...setup({ hand: ['red-4'], deck: 1 }), config: { ...R.defaultConfig, rounds: 1 } };
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    s = act(s, 'a', { type: 'DRAW', source: 'deck' });
    expect(s.phase).toBe('finished');
    expect(R.getResult(s)?.winner).toBeNull();
    expect(code(s, 'a', { type: 'NEXT_ROUND' })).toBe('GAME_OVER');
  });

  it('主动认输：当前比赛直接判负', () => {
    let s = setup({ hand: ['red-4'] });
    s = act(s, 'b', { type: 'RESIGN' });
    expect(s.result).toEqual({ winner: 'a', totals: { a: 0, b: 0 }, resigned: 'b' });
    expect(R.timer(s)).toBeNull();
  });
});

describe('计分（§7）', () => {
  const col = (spec: string): Card[] =>
    spec ? spec.split(' ').map((t, i) => (t === 'H' ? { id: `w${i}`, color: 'red', value: null } : { id: `n${t}`, color: 'red', value: Number(t) })) : [];
  it.each([
    ['', 0],
    ['H', -40],
    ['H H H', -80],
    ['3 7 9', -1],
    ['2 8 10', 0],
    ['6 8 10', 4],
    ['H 4 6', -20],
    ['H H 7 9 10', 18],
    ['2 3 4 5 6 7 8 9', 44],
    ['H H 2 3 4 5 6 7', 41],
    ['H H H 2 3 4 5 6', 20],
  ])('T17–T21 计分示例 %s → %i', (spec, score) => {
    expect(scoreColumn(col(spec)).score).toBe(score);
  });
});

describe('超时（§9.2）', () => {
  it('未出牌超时：随机弃一张并从抽牌堆抽一张，切换对手', () => {
    const s = setup({ hand: ['red-4'] });
    expect(R.timer(s)).toEqual({ phaseId: s.phaseId, ms: 30_000 });
    const t = act(s, 'system', { type: 'TIMEOUT' });
    expect(t.current).toBe('b');
    expect(t.players.a!.hand).toHaveLength(8);
    expect(t.deck).toHaveLength(s.deck.length - 1);
    expect(Object.values(t.discards).flat()).toHaveLength(1);
    expect(t.moves[t.moves.length - 1]).toMatchObject({ kind: 'discard', draw: 'deck', auto: true });
  });

  it('T26 已打牌但抽牌超时：只自动抽牌，不重复出牌；打牌与抽牌共享计时', () => {
    let s = setup({ hand: ['red-4'] });
    const timer = R.timer(s);
    s = act(s, 'a', { type: 'PLAY', cardId: 'red-4' });
    expect(R.timer(s)).toEqual(timer);
    s = act(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.a!.expeditions.red.map((c) => c.id)).toEqual(['red-4']);
    expect(Object.values(s.discards).flat()).toHaveLength(0);
    expect(s.players.a!.hand).toHaveLength(8);
    expect(s.current).toBe('b');
  });

  it('不计时模式没有回合计时器', () => {
    expect(R.timer({ ...init(), config: { ...R.defaultConfig, turnSec: 0 } })).toBeNull();
  });
});

describe('插件接口', () => {
  it('parseCommand：拒绝非法 payload 与网络传入的 TIMEOUT', () => {
    expect(R.parseCommand({ type: 'PLAY', cardId: 'red-10' })).toEqual({ type: 'PLAY', cardId: 'red-10' });
    expect(R.parseCommand({ type: 'DRAW', source: 'white' })).toEqual({ type: 'DRAW', source: 'white' });
    expect(R.parseCommand({ type: 'DRAW', source: 'purple' })).toBeNull();
    expect(R.parseCommand({ type: 'PLAY', cardId: 42 })).toBeNull();
    expect(R.parseCommand({ type: 'PLAY', cardId: '<script>' })).toBeNull();
    expect(R.parseCommand({ type: 'TIMEOUT' })).toBeNull();
    expect(R.parseCommand(null)).toBeNull();
  });

  it('规则项：轮数与回合时间；非法取值返回 null；人数固定 2', () => {
    const c = R.setRuleOption(R.defaultConfig, 'rounds', '1')!;
    expect(c.rounds).toBe(1);
    expect(R.setRuleOption(c, 'turnSec', '0')!.turnSec).toBe(0);
    expect(R.setRuleOption(c, 'turnSec', '45')).toBeNull();
    expect(R.setRuleOption(c, 'board', '6')).toBeNull();
    expect(R.validateConfig(c)).toEqual({ ok: true });
    expect(R.validateConfig({ ...c, rounds: 2 }).ok).toBe(false);
    expect(R.playerCount(c)).toEqual({ min: 2, max: 2 });
  });

  it('投影白名单（§9.3）：不含对手手牌、抽牌堆牌面与 Host 种子', () => {
    const s = init();
    for (const id of ['a', 'b']) {
      const v = projectView(s, id);
      const json = JSON.stringify(v);
      const opp = id === 'a' ? 'b' : 'a';
      expect(v.me?.hand.map((c) => c.id).sort()).toEqual(s.players[id]!.hand.map((c) => c.id).sort());
      for (const c of s.players[opp]!.hand) expect(json).not.toContain(`"${c.id}"`);
      for (const c of s.deck) expect(json).not.toContain(`"${c.id}"`);
      expect(json).not.toContain('seed');
      expect(v.players.find((p) => p.playerId === opp)?.handCount).toBe(8);
      expect(v.deckCount).toBe(44);
    }
    // 旁观者（非玩家）只得到公开信息
    expect(projectView(s, 'x').me).toBeNull();
  });

  it('弃牌暗置（§9.3）：只公开各色弃牌堆张数；他人弃牌只公开颜色，本人可见', () => {
    let s = setup({ hand: ['red-4'], discards: { blue: ['blue-3', 'blue-9'] } });
    const before = projectView(s, 'b');
    expect(before.discardCounts).toEqual({ red: 0, yellow: 0, blue: 2, green: 0, white: 0 });
    expect(JSON.stringify(before)).not.toContain('"blue-9"');
    expect(JSON.stringify(before)).not.toContain('"blue-3"');
    s = act(s, 'a', { type: 'DISCARD', cardId: 'red-4' });
    expect(projectView(s, 'b').pendingMove).toEqual({ playerId: 'a', kind: 'discard', color: 'red', card: null, draw: null, auto: false });
    expect(projectView(s, 'a').pendingMove?.card?.id).toBe('red-4');
    expect(JSON.stringify(projectView(s, 'b'))).not.toContain('"red-4"');
    // 盲抽蓝色弃牌堆顶：牌只进入抽牌者手牌，对手只知道来源颜色
    s = act(s, 'a', { type: 'DRAW', source: 'blue' });
    const opp = projectView(s, 'b');
    expect(opp.moves[opp.moves.length - 1]).toMatchObject({ kind: 'discard', card: null, draw: 'blue' });
    expect(opp.discardCounts.blue).toBe(1);
    expect(JSON.stringify(opp)).not.toContain('"blue-9"');
    expect(projectView(s, 'a').me!.hand.some((c) => c.id === 'blue-9')).toBe(true);
    // 打出的牌在探险列中本就公开
    s = act(s, 'b', { type: 'PLAY', cardId: s.players.b!.hand[0]!.id });
    expect(projectView(s, 'a').pendingMove?.card).not.toBeNull();
  });
});

describe('Bot 自对局', () => {
  it('3 轮比赛可以结束，全程保持卡牌守恒与手牌数量不变量', () => {
    for (const n of [1, 2, 3, 4]) {
      let s = init({}, n);
      let rngState = n;
      const rng = (): number => {
        rngState = (rngState * 1103515245 + 12345) % 2147483648;
        return rngState / 2147483648;
      };
      for (let step = 0; step < 2000 && !s.result; step++) {
        for (const id of ['a', 'b']) {
          const a = chooseBotAction(projectView(s, id), rng);
          if (!a) continue;
          s = act(s, id, a);
          break;
        }
        if (s.phase === 'play' || s.phase === 'draw') {
          expect(new Set(allCards(s)).size).toBe(60);
          expect(allCards(s)).toHaveLength(60);
          const current = s.players[s.current]!.hand.length;
          expect(current).toBe(s.phase === 'play' ? 8 : 7);
          for (const p of Object.values(s.players)) {
            for (const column of Object.values(p.expeditions)) {
              const firstNum = column.findIndex((c) => c.value !== null);
              if (firstNum >= 0) expect(column.slice(firstNum).every((c) => c.value !== null)).toBe(true);
              const nums = column.filter((c) => c.value !== null).map((c) => c.value!);
              expect(nums).toEqual([...nums].sort((x, y) => x - y));
            }
          }
        }
      }
      expect(s.result).not.toBeNull();
      expect(s.history).toHaveLength(3);
      const totals = s.result!.totals;
      expect(totals.a).toBe(s.history.reduce((t, r) => t + r.scores.a!, 0));
    }
  });
});

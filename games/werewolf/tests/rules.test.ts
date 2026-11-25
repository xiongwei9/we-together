import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@we/multiplayer';
import { ROLE_DECKS, projectView, shuffle, werewolfRules as R, type Role, type WerewolfAction, type WerewolfConfig, type WerewolfState } from '../src/rules';

type S = WerewolfState;

// 6 人局：a,b 狼；c 预言家；d 女巫；e,f 平民
const IDS6 = ['a', 'b', 'c', 'd', 'e', 'f'];
const ROLES6: Record<number, Role> = { 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' };
// 9 人局：a,b,c 狼；d 预言家；e 女巫；f 猎人；g,h,i 平民
const IDS9 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const ROLES9: Record<number, Role> = { 1: 'wolf', 2: 'wolf', 3: 'wolf', 4: 'seer', 5: 'witch', 6: 'hunter', 7: 'villager', 8: 'villager', 9: 'villager' };

function fresh(board: 6 | 9 = 6, patch: Partial<WerewolfConfig> = {}, seed = new Uint8Array(32)): S {
  const ids = board === 6 ? IDS6 : IDS9;
  return R.createInitialState({
    matchId: 'm1',
    players: ids.map((playerId, i) => ({ playerId, seat: i + 1 })),
    config: { ...R.defaultConfig, board, ...patch },
    seed,
    fixture: { rolesBySeat: board === 6 ? ROLES6 : ROLES9 },
  });
}

const ctx = (s: S, actorId: string): CommandContext => ({ actorId, now: 0, phaseId: s.phaseId });

function act(s: S, actorId: string, a: WerewolfAction): S {
  const v = R.validate(s, a, ctx(s, actorId));
  if (!v.ok) throw new Error(`${actorId} ${a.type} rejected in ${s.phase}: ${v.code}`);
  return R.reduce(s, a, ctx(s, actorId)).state;
}

function code(s: S, actorId: string, a: WerewolfAction): string | null {
  const v = R.validate(s, a, ctx(s, actorId));
  return v.ok ? null : v.code;
}

const timeout = (s: S): S => act(s, 'system', { type: 'PHASE_TIMEOUT' });
const aliveIds = (s: S): string[] => Object.keys(s.players).filter((id) => s.players[id]!.alive).sort();
const roleAlive = (s: S, role: Role): string[] => aliveIds(s).filter((id) => s.players[id]!.role === role);
const confirmAll = (s: S): S => Object.keys(s.players).reduce((x, id) => act(x, id, { type: 'CONFIRM_ROLE' }), s);

/** 走完一夜：狼人一致投票、女巫行动、预言家查验（存活角色操作，已出局角色等待隐藏延时） */
function night(s: S, o: { kill?: string | null; witch?: WerewolfAction; check?: string } = {}): S {
  expect(s.phase).toBe('night-wolf');
  for (const w of roleAlive(s, 'wolf')) s = act(s, w, { type: 'WOLF_VOTE', targetId: o.kill ?? null });
  expect(s.phase).toBe('night-witch');
  const witch = roleAlive(s, 'witch')[0];
  s = witch ? act(s, witch, o.witch ?? { type: 'WITCH_ACTION', action: 'pass' }) : timeout(s);
  expect(s.phase).toBe('night-seer');
  const seer = roleAlive(s, 'seer')[0];
  if (!seer) return timeout(s);
  if (!o.check) return act(s, seer, { type: 'SEER_PASS' });
  return timeout(act(s, seer, { type: 'SEER_CHECK', targetId: o.check }));
}

/** 9 人局死亡后的技能阶段：没有可开枪的猎人时等待隐藏延时 */
const skipHunter = (s: S): S => (s.phase === 'hunter' ? timeout(s) : s);

/** 依次结束全部发言（遗言 / 发言 / PK 发言） */
function speakAll(s: S): S {
  for (let i = 0; i < 20 && ['last-words', 'day-speech', 'pk-speech', 'sheriff-speech', 'sheriff-pk-speech'].includes(s.phase); i++) {
    s = act(s, s.speech!.order[s.speech!.index]!, { type: 'END_SPEECH' });
  }
  return s;
}

/** 投票：未列出的投票人弃票 */
function voteAll(s: S, votes: Record<string, string | null> = {}): S {
  for (const v of s.voters) s = act(s, v, { type: 'VOTE', targetId: votes[v] ?? null });
  return s;
}

describe('发牌与配置', () => {
  it('Fisher–Yates：两种板子角色数量固定、相同种子可重现、分布均匀', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    for (const board of [6, 9] as const) {
      const deck = ROLE_DECKS[board];
      expect(shuffle(deck, seed)).toEqual(shuffle(deck, seed));
      let wolves = 0;
      for (let n = 0; n < 3000; n++) {
        const s = Uint8Array.from({ length: 32 }, (_, i) => (n * 131 + i * 17 + ((n >> 3) ^ i)) & 255);
        const d = shuffle(deck, s);
        expect([...d].sort()).toEqual([...deck].sort());
        if (d[0] === 'wolf') wolves++;
      }
      // 座位 1 拿到狼的概率约 1/3
      expect(wolves / 3000).toBeGreaterThan(0.28);
      expect(wolves / 3000).toBeLessThan(0.39);
    }
    expect([...ROLE_DECKS[9]].sort()).toEqual(['hunter', 'seer', 'villager', 'villager', 'villager', 'witch', 'wolf', 'wolf', 'wolf']);
  });

  it('人数由板子决定；人数不符时不能开局', () => {
    expect(R.playerCount({ ...R.defaultConfig, board: 6 })).toEqual({ min: 6, max: 6 });
    expect(R.playerCount({ ...R.defaultConfig, board: 9 })).toEqual({ min: 9, max: 9 });
    expect(() =>
      R.createInitialState({ matchId: 'm', players: IDS6.map((playerId, i) => ({ playerId, seat: i + 1 })), config: { ...R.defaultConfig, board: 9 }, seed: new Uint8Array(32) }),
    ).toThrow();
  });

  it('开房自定义规则：列出全部规则项，非法 key / value 被拒绝', () => {
    const opts = R.ruleOptions(R.defaultConfig);
    expect(opts.map((o) => o.key)).toEqual(['board', 'sheriff', 'witchSelfSave', 'wolfKill', 'selfExplode', 'speechSec']);
    // 默认值即规则文档 §14
    expect(Object.fromEntries(opts.map((o) => [o.key, o.value]))).toEqual({
      board: '6',
      sheriff: 'off',
      witchSelfSave: 'never',
      wolfKill: 'majority',
      selfExplode: 'on',
      speechSec: '60',
    });
    let c = R.setRuleOption(R.defaultConfig, 'sheriff', 'on')!;
    c = R.setRuleOption(c, 'witchSelfSave', 'first-night')!;
    c = R.setRuleOption(c, 'board', '9')!;
    c = R.setRuleOption(c, 'speechSec', '120')!;
    expect(c).toMatchObject({ sheriff: true, witchSelfSave: 'first-night', board: 9, speechSec: 120 });
    expect(R.validateConfig(c).ok).toBe(true);
    expect(R.setRuleOption(c, 'board', '7')).toBeNull();
    expect(R.setRuleOption(c, 'nope', 'on')).toBeNull();
    expect(R.validateConfig({ ...c, speechSec: 45 }).ok).toBe(false);
    expect(opts.find((o) => o.key === 'speechSec')?.choices).toEqual([
      { value: '60', label: '60 秒' },
      { value: '90', label: '90 秒' },
      { value: '120', label: '120 秒' },
      { value: '0', label: '不计时' },
    ]);
    expect(R.setRuleOption(c, 'speechSec', '0')).toMatchObject({ speechSec: 0 });
    expect(R.validateConfig({ ...c, timers: { ...c.timers, voteMs: -1 } }).ok).toBe(false);
  });
});

describe('黑夜', () => {
  it('行动顺序：狼人 → 女巫 → 预言家 → 天亮，并照常播报', () => {
    let s = confirmAll(fresh());
    expect(s.phase).toBe('night-wolf');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    const t = R.reduce(s, { type: 'WOLF_VOTE', targetId: 'e' }, ctx(s, 'b'));
    expect(t.state.phase).toBe('night-witch');
    expect(R.announce(s, t.state, t.events)).toEqual(['狼人请闭眼。女巫请睁眼。']);
    s = act(t.state, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(s.phase).toBe('night-seer');
    s = act(s, 'c', { type: 'SEER_PASS' });
    expect(s.phase).toBe('last-words'); // 首夜死者有遗言
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'night', round: 1, deaths: ['e'] });
  });

  it('T01 狼刀 A、女巫救 A：平安夜，解药消耗', () => {
    let s = night(confirmAll(fresh()), { kill: 'e', witch: { type: 'WITCH_ACTION', action: 'save' } });
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'night', round: 1, deaths: [] });
    expect(s.players.e!.alive).toBe(true);
    expect(s.witchInventory).toEqual({ antidote: false, poison: true });
    expect(s.phase).toBe('day-speech');
  });

  it('T02 同一夜只能用一种药', () => {
    let s = confirmAll(fresh());
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'save' });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' })).toBe('WRONG_PHASE');
  });

  it('T03 默认全程不可自救（含首夜），可改用毒药；自定义规则可首夜自救或全程自救', () => {
    const toWitch = (s: S): S => ['a', 'b'].reduce((x, w) => act(x, w, { type: 'WOLF_VOTE', targetId: 'd' }), confirmAll(s));
    let s = toWitch(fresh());
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBe('NO_SELF_SAVE');
    expect(projectView(s, 'd').witch).toMatchObject({ wolfTarget: 'd', canSave: false });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'd' })).toBe('BAD_TARGET');
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' })).toBeNull();

    s = toWitch(fresh(6, { witchSelfSave: 'first-night' }));
    expect(projectView(s, 'd').witch?.canSave).toBe(true);
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBeNull();
    // 第二夜不可自救
    let s2 = night(confirmAll(fresh(6, { witchSelfSave: 'first-night' })), { kill: null });
    s2 = voteAll(speakAll(s2));
    s2 = ['a', 'b'].reduce((x, w) => act(x, w, { type: 'WOLF_VOTE', targetId: 'd' }), s2);
    expect(code(s2, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBe('NO_SELF_SAVE');

    s = toWitch(fresh(6, { witchSelfSave: 'always' }));
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBeNull();
  });

  it('T04 狼刀女巫、女巫毒 B：女巫与 B 同时出局', () => {
    const s = night(confirmAll(fresh()), { kill: 'd', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'e' } });
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'night', round: 1, deaths: ['d', 'e'] });
    expect(s.deaths.d).toEqual({ round: 1, at: 'night', causes: ['wolf'] });
    expect(s.deaths.e).toEqual({ round: 1, at: 'night', causes: ['poison'] });
  });

  it('T05 狼刀与毒药命中同一玩家：只出局一次，保留两种死亡原因', () => {
    const s = night(confirmAll(fresh()), { kill: 'e', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'e' } });
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'night', round: 1, deaths: ['e'] });
    expect(s.deaths.e!.causes).toEqual(['wolf', 'poison']);
  });

  it('T06 解药用完后看不到刀口，剩余毒药仍可用', () => {
    let s = night(confirmAll(fresh()), { kill: 'e', witch: { type: 'WITCH_ACTION', action: 'save' } });
    s = voteAll(speakAll(s));
    s = ['a', 'b'].reduce((x, w) => act(x, w, { type: 'WOLF_VOTE', targetId: 'f' }), s);
    const w = projectView(s, 'd').witch!;
    expect(w).toMatchObject({ antidote: false, poison: true, wolfTarget: null, canSave: false });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBe('NO_ANTIDOTE');
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' })).toBeNull();
  });

  it('T07 狼刀最高票并列时在并列选项中重投一次，再次并列则空刀', () => {
    let s = confirmAll(fresh(9));
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'g' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'h' });
    s = act(s, 'c', { type: 'WOLF_VOTE', targetId: null });
    // 三方各一票：重投仍处于狼人阶段，phaseId 不变，计时进入重投步骤
    expect(s.phase).toBe('night-wolf');
    expect(s.wolfRevote).toEqual([null, 'g', 'h']);
    expect(R.timer(s)).toMatchObject({ step: 'revote', ms: R.defaultConfig.timers.wolfRevoteMs, hidden: true });
    expect(projectView(s, 'a').wolf?.revote).toEqual([null, 'g', 'h']);
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'i' })).toBe('BAD_TARGET');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'g' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'h' });
    s = timeout(s); // c 未提交视为弃权
    expect(s.phase).toBe('night-witch');
    expect(s.wolfTarget).toBeNull();
  });

  it('狼刀：最高票生效（空刀也是选项）；未提交视为弃权；无有效票则空刀', () => {
    let s = confirmAll(fresh(9));
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'g' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'g' });
    s = act(s, 'c', { type: 'WOLF_VOTE', targetId: 'h' });
    expect(s.wolfTarget).toBe('g');

    s = act(confirmAll(fresh(9)), 'a', { type: 'WOLF_VOTE', targetId: 'g' });
    s = timeout(s);
    expect(s.wolfTarget).toBe('g');

    s = timeout(confirmAll(fresh(9)));
    expect(s.wolfTarget).toBeNull();

    // 可自刀、刀队友
    s = act(confirmAll(fresh()), 'a', { type: 'WOLF_VOTE', targetId: 'a' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'a' });
    expect(s.wolfTarget).toBe('a');
  });

  it('自定义规则「全体一致」：意见不一致或有人未提交则空刀', () => {
    let s = confirmAll(fresh(6, { wolfKill: 'unanimous' }));
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'f' });
    expect(s.wolfTarget).toBeNull();
    expect(s.wolfRevote).toBeNull();
    s = timeout(act(confirmAll(fresh(6, { wolfKill: 'unanimous' })), 'a', { type: 'WOLF_VOTE', targetId: 'e' }));
    expect(s.wolfTarget).toBeNull();
  });

  it('狼人意向选择只同步给存活队友，确认后锁定，不参与结算', () => {
    let s = confirmAll(fresh());
    s = act(s, 'a', { type: 'WOLF_SELECT', targetId: 'e' });
    s = act(s, 'a', { type: 'WOLF_SELECT', targetId: 'f' });
    expect(projectView(s, 'b').wolf?.intents).toEqual({ a: 'f' });
    expect(projectView(s, 'e').wolf).toBeNull();
    expect(code(s, 'c', { type: 'WOLF_SELECT', targetId: 'e' })).toBe('FORBIDDEN');
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.phase).toBe('night-wolf');
    expect(code(s, 'b', { type: 'WOLF_SELECT', targetId: 'f' })).toBe('ALREADY_SUBMITTED');
  });

  it('预言家：可重复查验、可放弃、不可查自己；结果只有本人可见；当晚被刀仍可查验', () => {
    let s = confirmAll(fresh());
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'c' })).toBe('BAD_TARGET');
    const phaseId = s.phaseId;
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    // 结果展示期：phaseId 不变，计时步骤切换
    expect(s.phaseId).toBe(phaseId);
    expect(R.timer(s)).toMatchObject({ step: 'reveal', ms: R.defaultConfig.timers.seerRevealMs, hidden: true });
    expect(projectView(s, 'c').seer?.lastCheck).toEqual({ targetId: 'a', team: 'wolf' });
    expect(projectView(s, 'd').seer).toBeNull();
    s = timeout(s);
    expect(s.players.c!.alive).toBe(false);
    expect(s.nightLog[0]).toEqual({ round: 1, wolfTarget: 'c', witch: null, seer: { target: 'a', team: 'wolf' } });

    // 第二夜重复查验同一人
    let t = night(confirmAll(fresh()), { check: 'a' });
    t = voteAll(speakAll(t));
    t = ['a', 'b'].reduce((x, w) => act(x, w, { type: 'WOLF_VOTE', targetId: null }), t);
    t = act(t, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(code(t, 'c', { type: 'SEER_CHECK', targetId: 'a' })).toBeNull();
    expect(code(t, 'c', { type: 'SEER_PASS' })).toBeNull();
  });

  it('超时：女巫不用药、预言家不查验，不消耗药品', () => {
    let s = confirmAll(fresh());
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    s = timeout(timeout(s));
    expect(s.witchInventory).toEqual({ antidote: true, poison: true });
    expect(s.players.e!.alive).toBe(false);
    expect(s.nightLog[0]!.seer).toBeNull();
  });
});

describe('天亮与白天', () => {
  it('遗言：首夜死者按座位号发表遗言，第二夜起没有遗言', () => {
    let s = night(confirmAll(fresh()), { kill: 'f', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' } });
    expect(s.phase).toBe('last-words');
    expect(s.speech!.order).toEqual(['a', 'f']);
    expect(code(s, 'f', { type: 'END_SPEECH' })).toBe('NOT_YOUR_TURN');
    // 出局玩家只能发表自己的遗言
    expect(projectView(s, 'a').pendingAction).toBe('speak');
    s = act(s, 'a', { type: 'END_SPEECH' });
    s = act(s, 'f', { type: 'END_SPEECH' });
    expect(s.phase).toBe('day-speech');
    s = voteAll(speakAll(s));
    s = night(s, { kill: 'c' });
    expect(s.phase).toBe('day-speech');
  });

  it('发言顺序：以最小号夜间死者为锚点顺时针；平安夜从上一轮起点的下一位开始', () => {
    let s = night(confirmAll(fresh()), { kill: 'e' });
    s = speakAll(s); // 遗言 + 发言
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'night' });
    // 第一天发言从 6 号开始：6,1,2,3,4
    expect(s.phase).toBe('day-vote');
    let t = night(confirmAll(fresh()), { kill: 'e' });
    t = act(t, 'e', { type: 'END_SPEECH' });
    expect(t.speech!.order).toEqual(['f', 'a', 'b', 'c', 'd']);
    t = voteAll(speakAll(t));
    t = night(t, { kill: null });
    // 平安夜：上一轮起点 6 号的下一位存活玩家 1 号
    expect(t.speech!.order).toEqual(['a', 'b', 'c', 'd', 'f']);
    // 只有当前发言者能结束发言，超时自动结束
    expect(code(t, 'b', { type: 'END_SPEECH' })).toBe('NOT_YOUR_TURN');
    expect(R.timer(t)).toMatchObject({ ms: 60_000, hidden: false });
    const p1 = t.phaseId;
    t = timeout(t);
    expect(t.speech!.index).toBe(1);
    expect(t.phaseId).not.toBe(p1);
  });

  it('座位号不连续时按实际座位环轮转发言', () => {
    let s = R.createInitialState({
      matchId: 'm1',
      players: IDS6.map((playerId, i) => ({ playerId, seat: [2, 3, 5, 7, 8, 9][i]! })),
      config: R.defaultConfig,
      seed: new Uint8Array(32),
      fixture: { rolesBySeat: { 2: 'wolf', 3: 'wolf', 5: 'seer', 7: 'witch', 8: 'villager', 9: 'villager' } },
    });
    s = night(confirmAll(s), { kill: 'f' }); // 9 号死亡：从下一位（2 号）开始
    s = act(s, 'f', { type: 'END_SPEECH' });
    expect(s.speech!.order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('自定义发言时长生效', () => {
    const s = night(confirmAll(fresh(6, { speechSec: 120 })), { kill: null });
    expect(s.phase).toBe('day-speech');
    expect(R.timer(s)?.ms).toBe(120_000);
  });

  it('发言不计时：竞选发言、发言、PK 发言、遗言都没有倒计时；房主可跳过当前发言（公共控制）', () => {
    expect(R.isPublicControl({ type: 'SKIP_SPEECH' })).toBe(true);
    expect(R.isPublicControl({ type: 'END_SPEECH' })).toBe(false);
    // 首夜死者遗言
    let s = night(confirmAll(fresh(6, { speechSec: 0 })), { kill: 'e' });
    expect(s.phase).toBe('last-words');
    expect(R.timer(s)).toBeNull();
    expect(code(s, 'a', { type: 'SKIP_SPEECH' })).toBe('FORBIDDEN');
    expect(code(s, 'system', { type: 'PHASE_TIMEOUT' })).toBe('WRONG_PHASE');
    s = act(s, 'system', { type: 'SKIP_SPEECH' });
    expect(s.phase).toBe('day-speech');
    expect(R.timer(s)).toBeNull();
    const first = s.speech!.order[0];
    s = act(s, 'system', { type: 'SKIP_SPEECH' });
    expect(s.speech!.order[s.speech!.index]).not.toBe(first);
    s = voteAll(speakAll(s), { a: 'c', b: 'c', c: 'a', d: 'a' });
    expect(s.phase).toBe('pk-speech');
    expect(R.timer(s)).toBeNull();
    // 投票阶段仍按规则计时
    s = speakAll(s);
    expect(R.timer(s)).toMatchObject({ ms: 15_000, hidden: false });
    expect(code(s, 'system', { type: 'SKIP_SPEECH' })).toBe('WRONG_PHASE');
    // 计时模式下不能跳过发言
    const t = night(confirmAll(fresh()), { kill: null });
    expect(code(t, 'system', { type: 'SKIP_SPEECH' })).toBe('DISABLED');
    // 警长竞选发言同样不计时
    let u = night(confirmAll(fresh(6, { speechSec: 0, sheriff: true })), { kill: null });
    for (const id of IDS6) u = act(u, id, { type: 'SHERIFF_SIGNUP', join: id === 'a' || id === 'c' });
    expect(u.phase).toBe('sheriff-speech');
    expect(R.timer(u)).toBeNull();
  });

  it('放逐：唯一最高票出局（无需过半），不能自投，票型公开，放逐者有遗言', () => {
    let s = speakAll(night(confirmAll(fresh()), { kill: null }));
    expect(s.phase).toBe('day-vote');
    expect(code(s, 'c', { type: 'VOTE', targetId: 'c' })).toBe('BAD_TARGET');
    expect(projectView(s, 'e').progress).toEqual({ done: 0, total: 6 });
    s = voteAll(s, { c: 'a', d: 'a', e: 'b' });
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'vote', exiled: 'a', votes: { a: null, b: null, c: 'a', d: 'a', e: 'b', f: null } });
    expect(s.phase).toBe('last-words');
    expect(s.speech!.order).toEqual(['a']);
    s = act(s, 'a', { type: 'END_SPEECH' });
    expect(s.phase).toBe('night-wolf');
    expect(s.round).toBe(2);
  });

  it('T08 平票进入一次 PK：PK 玩家按座位号发言且没有投票权；再次平票无人出局', () => {
    let s = speakAll(night(confirmAll(fresh()), { kill: null }));
    s = voteAll(s, { a: 'e', b: 'e', c: 'a', d: 'a' });
    expect(s.phase).toBe('pk-speech');
    expect(s.speech!.order).toEqual(['a', 'e']);
    expect(projectView(s, 'c').candidates).toEqual(['a', 'e']);
    s = speakAll(s);
    expect(s.phase).toBe('pk-vote');
    expect(s.voters).toEqual(['b', 'c', 'd', 'f']);
    expect(code(s, 'a', { type: 'VOTE', targetId: 'e' })).toBe('FORBIDDEN');
    expect(code(s, 'b', { type: 'VOTE', targetId: 'c' })).toBe('BAD_TARGET');
    s = voteAll(s, { b: 'e', c: 'a' });
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'vote', pk: true, exiled: null });
    expect(s.phase).toBe('night-wolf');
    expect(aliveIds(s)).toHaveLength(6);
  });

  it('T09 全员弃票：无人出局，直接入夜', () => {
    let s = speakAll(night(confirmAll(fresh()), { kill: null }));
    s = voteAll(s);
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'vote', exiled: null, tied: [] });
    expect(s.phase).toBe('night-wolf');
  });

  it('投票超时视为弃票', () => {
    let s = speakAll(night(confirmAll(fresh()), { kill: null }));
    s = act(s, 'c', { type: 'VOTE', targetId: 'a' });
    expect(R.timer(s)).toMatchObject({ ms: 15_000, hidden: false });
    s = timeout(s);
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'vote', exiled: 'a' });
  });

  it('T10 狼人在发言阶段自爆：公开身份、无遗言、取消放逐并入夜；投票阶段不能自爆', () => {
    let s = night(confirmAll(fresh()), { kill: null });
    expect(projectView(s, 'b').canExplode).toBe(true);
    expect(projectView(s, 'c').canExplode).toBe(false);
    expect(code(s, 'c', { type: 'EXPLODE' })).toBe('FORBIDDEN');
    const t = R.reduce(s, { type: 'EXPLODE' }, ctx(s, 'b'));
    s = t.state;
    expect(R.announce(null, s, t.events)).toContain('2号 自爆，身份是狼人。');
    expect(s.players.b!.alive).toBe(false);
    expect(s.deaths.b!.causes).toEqual(['explode']);
    expect(s.phase).toBe('night-wolf');
    expect(s.publicHistory.some((e) => e.kind === 'vote')).toBe(false);
    s = speakAll(night(s, { kill: null }));
    expect(code(s, 'a', { type: 'EXPLODE' })).toBe('WRONG_PHASE');
  });

  it('自定义规则「禁止自爆」', () => {
    const s = night(confirmAll(fresh(6, { selfExplode: false })), { kill: null });
    expect(projectView(s, 'a').canExplode).toBe(false);
    expect(code(s, 'a', { type: 'EXPLODE' })).toBe('DISABLED');
  });

  it('T11 最后一名狼人自爆：好人胜利', () => {
    let s = night(confirmAll(fresh()), { kill: null });
    s = act(s, 'a', { type: 'EXPLODE' });
    s = night(s, { kill: null });
    s = act(s, 'b', { type: 'EXPLODE' });
    expect(s.result).toEqual({ winner: 'good' });
    expect(s.phase).toBe('finished');
    expect(code(s, 'c', { type: 'VOTE', targetId: 'd' })).toBe('GAME_OVER');
  });
});

describe('胜负', () => {
  it('T12 全部平民出局且仍有狼人：狼人胜利（屠边）', () => {
    let s = night(confirmAll(fresh()), { kill: 'e', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'f' } });
    expect(s.result).toEqual({ winner: 'wolf' });
    // 游戏已结束：不进入遗言
    expect(s.phase).toBe('finished');
    expect(projectView(s, 'e').result?.roles.a).toBe('wolf');
  });

  it('T13 全部神职出局且仍有狼人：狼人胜利', () => {
    const s = night(confirmAll(fresh()), { kill: 'd', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'c' } });
    expect(s.result).toEqual({ winner: 'wolf' });
  });

  it('狼人人数优势不直接获胜（9 人局 3 狼 1 民 1 神继续）', () => {
    let s = confirmAll(fresh(9));
    for (const id of ['d', 'e', 'g', 'h']) s.players[id]!.alive = false;
    s = night(s, { kill: null });
    expect(s.result).toBeNull();
  });

  it('T17 最后一狼刀最后一神女巫、女巫毒最后一狼：同批次结算后平局', () => {
    let s = night(confirmAll(fresh()), { kill: null });
    s = act(s, 'a', { type: 'EXPLODE' });
    s.players.c!.alive = false; // 预言家已出局
    s = night(s, { kill: 'd', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'b' } });
    expect(s.result).toEqual({ winner: 'draw' });
  });

  it('T20 连续三个完整昼夜无人死亡：无结果结束；任一死亡清零计数', () => {
    let s = confirmAll(fresh());
    for (let i = 0; i < 2; i++) s = voteAll(speakAll(night(s, { kill: null })));
    expect(s.quietCycles).toBe(2);
    expect(s.result).toBeNull();
    s = voteAll(speakAll(night(s, { kill: null })));
    expect(s.result).toEqual({ winner: 'none' });

    let t = confirmAll(fresh());
    t = voteAll(speakAll(night(t, { kill: null })));
    t = voteAll(speakAll(night(t, { kill: 'e' })));
    expect(t.quietCycles).toBe(0);
  });

  it('T18 出局玩家不能投票、查验或参与狼队行动', () => {
    let s = night(confirmAll(fresh()), { kill: null });
    s = act(s, 'a', { type: 'EXPLODE' });
    s.players.c!.alive = false;
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' })).toBe('DEAD');
    expect(code(s, 'a', { type: 'WOLF_SELECT', targetId: 'e' })).toBe('DEAD');
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: null });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'b' })).toBe('DEAD');
    s = speakAll(timeout(s));
    expect(code(s, 'a', { type: 'VOTE', targetId: 'b' })).toBe('DEAD');
    expect(projectView(s, 'a').pendingAction).toBeNull();
  });
});

describe('9 人局猎人', () => {
  it('T14 猎人被狼刀：可以开枪（公开），被带走者没有遗言', () => {
    let s = night(confirmAll(fresh(9)), { kill: 'f' });
    expect(s.phase).toBe('hunter');
    expect(projectView(s, 'f').pendingAction).toBe('hunter');
    expect(projectView(s, 'f').hunter).toEqual({ canShoot: true });
    expect(projectView(s, 'g').hunter).toBeNull();
    // 隐藏计时，不下发客户端
    expect(R.timer(s)).toMatchObject({ hidden: true, ms: R.defaultConfig.timers.hunterMs });
    expect(code(s, 'f', { type: 'HUNTER_SHOOT', targetId: 'f' })).toBe('BAD_TARGET');
    expect(code(s, 'g', { type: 'HUNTER_SHOOT', targetId: 'a' })).toBe('FORBIDDEN');
    const t = R.reduce(s, { type: 'HUNTER_SHOOT', targetId: 'a' }, ctx(s, 'f'));
    s = t.state;
    expect(R.announce(null, s, t.events)).toContain('猎人开枪，1号 被带走。');
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'shot', round: 1, shooter: 'f', target: 'a' });
    expect(s.deaths.a!.causes).toEqual(['shot']);
    // 首夜遗言只给夜间死者，枪杀目标不继承
    expect(s.phase).toBe('last-words');
    expect(s.speech!.order).toEqual(['f']);
  });

  it('猎人可以放弃开枪，超时视为放弃', () => {
    let s = night(confirmAll(fresh(9)), { kill: 'f' });
    s = act(s, 'f', { type: 'HUNTER_SHOOT', targetId: null });
    expect(s.phase).toBe('last-words');
    s = timeout(night(confirmAll(fresh(9)), { kill: 'f' }));
    expect(s.phase).toBe('last-words');
    expect(s.publicHistory.some((e) => e.kind === 'shot')).toBe(false);
  });

  it('T15 猎人同时被狼刀和毒杀：不能开枪', () => {
    const s = night(confirmAll(fresh(9)), { kill: 'f', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'f' } });
    expect(s.phase).toBe('hunter');
    expect(s.batch!.hunter).toBeNull();
    expect(projectView(s, 'f').hunter).toEqual({ canShoot: false });
    expect(projectView(s, 'f').pendingAction).toBeNull();
    expect(code(s, 'f', { type: 'HUNTER_SHOOT', targetId: 'a' })).toBe('FORBIDDEN');
  });

  it('有人死亡时总有技能阶段（不论猎人是否在本批次），停留时长随 Host 种子随机', () => {
    const delays = new Set<number>();
    for (let n = 0; n < 10; n++) {
      const s = night(confirmAll(fresh(9, {}, Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 11) & 255))), { kill: 'g' });
      expect(s.phase).toBe('hunter');
      const t = R.timer(s)!;
      expect(t.hidden).toBe(true);
      expect(t.ms).toBeGreaterThanOrEqual(3000);
      expect(t.ms).toBeLessThanOrEqual(8000);
      delays.add(t.ms);
      for (const id of IDS9) expect(projectView(s, id).pendingAction === 'hunter').toBe(false);
    }
    expect(delays.size).toBeGreaterThan(3);
    // 平安夜没有技能阶段
    expect(night(confirmAll(fresh(9)), { kill: null }).phase).toBe('day-speech');
  });

  it('T16 最后一名神职猎人被放逐并带走最后一狼：完成开枪后判定平局', () => {
    let s = confirmAll(fresh(9));
    for (const id of ['b', 'c', 'd', 'e']) s.players[id]!.alive = false; // 剩 a 狼、f 猎人、g h i 平民
    s = speakAll(night(s, { kill: null }));
    s = voteAll(s, { a: 'f', g: 'f', h: 'f' });
    expect(s.phase).toBe('hunter');
    expect(s.result).toBeNull(); // 中间状态不提前锁定胜者
    s = act(s, 'f', { type: 'HUNTER_SHOOT', targetId: 'a' });
    expect(s.result).toEqual({ winner: 'draw' });
  });
});

describe('警长模式（自定义规则）', () => {
  const sheriffGame = (board: 6 | 9 = 6): S => confirmAll(fresh(board, { sheriff: true }));

  it('首日先竞选警长再公布死讯；夜间死者可以竞选；当选后出局需移交警徽', () => {
    let s = night(sheriffGame(), { kill: 'e' });
    expect(s.phase).toBe('sheriff-signup');
    // 死讯尚未公布：e 仍可上警
    expect(s.players.e!.alive).toBe(true);
    expect(projectView(s, 'a').history).toEqual([]);
    for (const id of IDS6) s = act(s, id, { type: 'SHERIFF_SIGNUP', join: id === 'c' || id === 'e' });
    expect(s.phase).toBe('sheriff-speech');
    expect(projectView(s, 'a').candidates).toEqual(['c', 'e']);
    s = speakAll(s);
    expect(s.phase).toBe('sheriff-vote');
    // 上警玩家没有投票权
    expect(s.voters).toEqual(['a', 'b', 'd', 'f']);
    expect(code(s, 'c', { type: 'VOTE', targetId: 'e' })).toBe('FORBIDDEN');
    s = voteAll(s, { a: 'e', b: 'e', d: 'c' });
    expect(s.publicHistory[0]).toMatchObject({ kind: 'sheriff', elected: 'e', candidates: ['c', 'e'] });
    // 公布死讯：警长 e 出局，移交警徽
    expect(s.publicHistory[1]).toEqual({ kind: 'night', round: 1, deaths: ['e'] });
    expect(s.phase).toBe('badge');
    expect(projectView(s, 'e').pendingAction).toBe('badge');
    expect(code(s, 'a', { type: 'BADGE_PASS', targetId: 'b' })).toBe('FORBIDDEN');
    s = act(s, 'e', { type: 'BADGE_PASS', targetId: 'c' });
    expect(s.sheriff).toBe('c');
    expect(s.phase).toBe('last-words');
    s = act(s, 'e', { type: 'END_SPEECH' });
    // 警长决定发言顺序，自己最后发言
    expect(s.phase).toBe('sheriff-order');
    expect(code(s, 'a', { type: 'SHERIFF_ORDER', dir: 'cw' })).toBe('FORBIDDEN');
    s = act(s, 'c', { type: 'SHERIFF_ORDER', dir: 'ccw' });
    expect(s.speech!.order).toEqual(['b', 'a', 'f', 'd', 'c']);
  });

  it('警长放逐投票计 1.5 票', () => {
    let s = night(sheriffGame(), { kill: null });
    for (const id of IDS6) s = act(s, id, { type: 'SHERIFF_SIGNUP', join: id === 'c' });
    expect(s.sheriff).toBe('c'); // 只有一人上警直接当选
    s = act(s, 'c', { type: 'SHERIFF_ORDER', dir: 'cw' });
    expect(s.speech!.order).toEqual(['d', 'e', 'f', 'a', 'b', 'c']);
    s = speakAll(s);
    s = voteAll(s, { c: 'a', d: 'a', e: 'b', f: 'b' });
    expect(s.publicHistory.at(-1)).toMatchObject({ kind: 'vote', exiled: 'a', sheriff: 'c' });
  });

  it('退水：只剩一名候选人时直接当选；无人上警或全员上警则警徽流失', () => {
    let s = night(sheriffGame(), { kill: null });
    for (const id of IDS6) s = act(s, id, { type: 'SHERIFF_SIGNUP', join: ['a', 'c', 'd'].includes(id) });
    expect(projectView(s, 'd').canWithdraw).toBe(true);
    s = act(s, 'd', { type: 'SHERIFF_WITHDRAW' });
    expect(s.candidates).toEqual(['a', 'c']);
    s = act(s, 'a', { type: 'SHERIFF_WITHDRAW' }); // 当前发言者退水
    expect(s.sheriff).toBe('c');

    let t = night(sheriffGame(), { kill: null });
    t = timeout(t); // 无人上警
    expect(t.sheriff).toBeNull();
    expect(t.sheriffElectionDone).toBe(true);
    expect(t.phase).toBe('day-speech');

    let u = night(sheriffGame(), { kill: null });
    for (const id of IDS6) u = act(u, id, { type: 'SHERIFF_SIGNUP', join: true });
    expect(u.sheriff).toBeNull();
  });

  it('警长竞选平票进入 PK，再次平票警徽流失', () => {
    let s = night(sheriffGame(), { kill: null });
    for (const id of IDS6) s = act(s, id, { type: 'SHERIFF_SIGNUP', join: id === 'a' || id === 'b' });
    s = voteAll(speakAll(s), { c: 'a', d: 'b' });
    expect(s.phase).toBe('sheriff-pk-speech');
    s = speakAll(s);
    expect(s.voters).toEqual(['c', 'd', 'e', 'f']);
    s = voteAll(s, { c: 'a', d: 'b' });
    expect(s.sheriff).toBeNull();
    expect(s.phase).toBe('day-speech');
  });

  it('竞选发言中自爆：警徽流失，公布死讯后直接入夜', () => {
    let s = night(sheriffGame(), { kill: 'e' });
    for (const id of IDS6) s = act(s, id, { type: 'SHERIFF_SIGNUP', join: id === 'a' || id === 'c' });
    s = act(s, 'b', { type: 'EXPLODE' });
    expect(s.sheriff).toBeNull();
    expect(s.players.b!.alive).toBe(false);
    expect(s.players.e!.alive).toBe(false);
    // 首夜死者仍有遗言，然后跳过发言与投票入夜
    expect(s.phase).toBe('last-words');
    s = act(s, 'e', { type: 'END_SPEECH' });
    expect(s.phase).toBe('night-wolf');
  });

  it('警长被放逐时移交警徽；警长自爆时警徽被撕毁', () => {
    const elected = (id: string): S => {
      let s = night(sheriffGame(), { kill: null });
      for (const p of IDS6) s = act(s, p, { type: 'SHERIFF_SIGNUP', join: p === id });
      expect(s.sheriff).toBe(id);
      expect(code(s, 'a', { type: 'EXPLODE' })).toBe('WRONG_PHASE'); // 选择发言顺序时不能自爆
      return act(s, id, { type: 'SHERIFF_ORDER', dir: 'cw' });
    };
    let s = speakAll(elected('c'));
    s = voteAll(s, { a: 'c', b: 'c' });
    expect(s.phase).toBe('badge');
    s = act(s, 'c', { type: 'BADGE_PASS', targetId: null });
    expect(s.sheriff).toBeNull();
    expect(s.publicHistory.at(-1)).toEqual({ kind: 'badge', round: 1, from: 'c', to: null });
    expect(s.phase).toBe('last-words');

    let t = elected('a');
    t = act(t, 'a', { type: 'EXPLODE' });
    expect(t.sheriff).toBeNull();
    expect(t.publicHistory.at(-1)).toEqual({ kind: 'badge', round: 1, from: 'a', to: null });
    expect(t.phase).toBe('night-wolf');
  });
});

describe('投影白名单与计时', () => {
  it('平民视图不含他人身份与夜间私密信息；狼人看到队友', () => {
    let s = confirmAll(fresh());
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    const v = projectView(s, 'e');
    expect(v.me?.role).toBe('villager');
    expect(v.wolf).toBeNull();
    expect(v.seer).toBeNull();
    expect(v.witch).toBeNull();
    // 不出现任何角色值（键名 wolf/seer/witch 为 null 占位）
    expect(JSON.stringify({ ...v, me: null })).not.toMatch(/:"(wolf|seer|witch|hunter|villager)"/);
    expect(projectView(s, 'b').wolf).toEqual({ teammates: ['a'], votes: { a: 'e' }, intents: { a: 'e' }, revote: null, target: null });
  });

  it('暗牌：公开历史不含死亡原因与身份；死亡玩家只收到公开信息；结束后公开复盘', () => {
    let s = night(confirmAll(fresh()), { kill: 'c', check: 'a', witch: { type: 'WITCH_ACTION', action: 'poison', targetId: 'e' } });
    for (const id of ['c', 'e']) {
      const dead = projectView(s, id);
      expect(dead.seer).toBeNull();
      expect(dead.result).toBeNull();
      expect(JSON.stringify({ ...dead, me: null })).not.toMatch(/:"(wolf|seer|witch|villager|good|poison)"/);
    }
    s = speakAll(s);
    s = voteAll(s, { a: 'd', b: 'd', f: 'd' });
    // 神职全部出局：狼人屠边胜利，不再安排遗言
    expect(s.result).toEqual({ winner: 'wolf' });
    const r = projectView(s, 'e').result!;
    expect(r.deaths.e).toEqual({ round: 1, at: 'night', causes: ['poison'] });
    expect(r.nights[0]).toEqual({ round: 1, wolfTarget: 'c', witch: { kind: 'poison', target: 'e' }, seer: { target: 'a', team: 'wolf' } });
  });

  it('夜间与技能阶段为隐藏计时；预言家出局后其阶段照常播报并随机停留', () => {
    let s = confirmAll(fresh());
    expect(R.timer(s)).toMatchObject({ hidden: true, ms: 40_000 });
    expect(projectView(s, 'a').actionLimitMs).toBe(40_000);
    expect(projectView(s, 'e').actionLimitMs).toBeNull();
    s = night(s, { kill: 'c' });
    s = voteAll(speakAll(s));
    s = ['a', 'b'].reduce((x, w) => act(x, w, { type: 'WOLF_VOTE', targetId: null }), s);
    const t = R.reduce(s, { type: 'WITCH_ACTION', action: 'pass' }, ctx(s, 'd'));
    expect(t.state.phase).toBe('night-seer');
    expect(R.announce(s, t.state, t.events)).toEqual(['女巫请闭眼。预言家请睁眼，请选择要查验的玩家。']);
    const timer = R.timer(t.state)!;
    expect(timer.hidden).toBe(true);
    expect(timer.ms).toBeGreaterThanOrEqual(3000);
    expect(timer.ms).toBeLessThanOrEqual(8000);
    expect(R.reduce(t.state, { type: 'PHASE_TIMEOUT' }, ctx(t.state, 'system')).state.phase).toBe('day-speech');
  });

  it('网络命令 schema：拒绝 PHASE_TIMEOUT 与非法字段', () => {
    expect(R.parseCommand({ type: 'PHASE_TIMEOUT' })).toBeNull();
    expect(R.parseCommand({ type: 'SEER_CHECK' })).toBeNull();
    expect(R.parseCommand({ type: 'WITCH_ACTION', action: 'poison' })).toBeNull();
    expect(R.parseCommand({ type: 'SHERIFF_ORDER', dir: 'up' })).toBeNull();
    expect(R.parseCommand({ type: 'SHERIFF_SIGNUP', join: 'yes' })).toBeNull();
    expect(R.parseCommand({ type: 'VOTE', targetId: null })).toEqual({ type: 'VOTE', targetId: null });
    expect(R.parseCommand({ type: 'SKIP_SPEECH' })).toEqual({ type: 'SKIP_SPEECH' });
    expect(R.parseCommand({ type: 'HUNTER_SHOOT', targetId: 'x'.repeat(65) })).toBeNull();
    expect(R.parseCommand('CONFIRM_ROLE')).toBeNull();
  });
});

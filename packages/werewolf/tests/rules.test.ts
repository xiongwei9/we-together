import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@we/multiplayer';
import { ROLE_DECK, projectView, shuffle, werewolfRules as R, type Role, type WerewolfAction, type WerewolfState } from '../src/rules';

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
// a,b 狼；c 预言家；d 女巫；e,f 平民
const ROLES: Record<number, Role> = { 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' };

function fresh(): WerewolfState {
  return R.createInitialState({
    matchId: 'm1',
    players: IDS.map((playerId, i) => ({ playerId, seat: i + 1 })),
    config: R.defaultConfig,
    seed: new Uint8Array(32),
    fixture: { rolesBySeat: ROLES },
  });
}

const ctx = (s: WerewolfState, actorId: string): CommandContext => ({ actorId, now: 0, phaseId: s.phaseId });

function act(s: WerewolfState, actorId: string, a: WerewolfAction): WerewolfState {
  const v = R.validate(s, a, ctx(s, actorId));
  if (!v.ok) throw new Error(`${actorId} ${a.type} rejected: ${v.code}`);
  return R.reduce(s, a, ctx(s, actorId)).state;
}

function code(s: WerewolfState, actorId: string, a: WerewolfAction): string | null {
  const v = R.validate(s, a, ctx(s, actorId));
  return v.ok ? null : v.code;
}

const toNight = (): WerewolfState => IDS.reduce((s, id) => act(s, id, { type: 'CONFIRM_ROLE' }), fresh());

describe('发牌', () => {
  it('Fisher–Yates：角色数量固定、相同种子可重现、不同种子分布均匀', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    expect(shuffle(ROLE_DECK, seed)).toEqual(shuffle(ROLE_DECK, seed));
    const counts = new Map<string, number>();
    for (let n = 0; n < 6000; n++) {
      const s = Uint8Array.from({ length: 32 }, (_, i) => (n * 131 + i * 17 + ((n >> 3) ^ i)) & 255);
      const deck = shuffle(ROLE_DECK, s);
      expect([...deck].sort()).toEqual([...ROLE_DECK].sort());
      counts.set(deck[0]!, (counts.get(deck[0]!) ?? 0) + 1);
    }
    // 座位 1 拿到狼的概率约 2/6
    expect(counts.get('wolf')! / 6000).toBeGreaterThan(0.28);
    expect(counts.get('wolf')! / 6000).toBeLessThan(0.39);
  });
});

describe('夜间', () => {
  it('全员确认后进入狼人阶段；两狼一致击杀生效', () => {
    let s = toNight();
    expect(s.phase).toBe('night-wolf');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.phase).toBe('night-wolf');
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.phase).toBe('night-seer');
    expect(s.wolfTarget).toBe('e');
  });

  it('两狼意见不一致则空刀；狼不能刀狼；非狼不能投狼票', () => {
    let s = toNight();
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'b' })).toBe('BAD_TARGET');
    expect(code(s, 'c', { type: 'WOLF_VOTE', targetId: 'e' })).toBe('FORBIDDEN');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'f' })).toBe('ALREADY_SUBMITTED');
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'f' });
    expect(s.wolfTarget).toBeNull();
  });

  it('预言家查验结果仅本人可见；女巫解药抵消狼刀，毒药独立结算', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'c' })).toBe('BAD_TARGET');
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    expect(projectView(s, 'c').seer?.checks).toEqual({ a: 'wolf' });
    expect(projectView(s, 'd').seer).toBeNull();
    expect(s.phase).toBe('night-witch');
    expect(projectView(s, 'd').witch?.wolfTarget).toBe('e');
    expect(projectView(s, 'c').witch).toBeNull();
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'save' });
    expect(s.phase).toBe('day-discuss');
    expect(s.players.e!.alive).toBe(true);
    expect(s.publicHistory.at(-1)).toEqual({ round: 1, kind: 'night', deaths: [] });
    expect(s.witchInventory).toEqual({ antidote: false, poison: true });
  });

  it('女巫仅首夜可自救；同夜只能用一种药；毒药不能毒自己', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'd' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'd' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'e' });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBeNull();
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'd' })).toBe('BAD_TARGET');
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).not.toBeNull();
    // 狼刀女巫 + 毒狼 a：两人同时死亡
    expect(s.players.d!.alive).toBe(false);
    expect(s.players.a!.alive).toBe(false);
    expect(s.publicHistory.at(-1)?.deaths).toEqual(['a', 'd']);
  });

  it('超时：未提交视为弃权 / 放弃；死者不再行动', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(s.wolfTarget).toBeNull(); // b 未投 → 意见不一致 → 空刀
    expect(code(s, 'c', { type: 'PHASE_TIMEOUT' })).toBe('FORBIDDEN');
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(s.phase).toBe('day-discuss');
    expect(R.timer(s)).toEqual({ phaseId: s.phaseId, ms: R.defaultConfig.discussMs });
  });
});

describe('白天', () => {
  function toVote(): WerewolfState {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'f' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'f' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(s.players.f!.alive).toBe(false);
    expect(code(s, 'a', { type: 'END_DISCUSSION' })).toBe('FORBIDDEN');
    expect(R.isPublicControl({ type: 'END_DISCUSSION' })).toBe(true);
    return act(s, 'system', { type: 'END_DISCUSSION' });
  }

  it('唯一最高票放逐；禁止自投；死者不能投票', () => {
    let s = toVote();
    expect(code(s, 'c', { type: 'DAY_VOTE', targetId: 'c' })).toBe('BAD_TARGET');
    expect(code(s, 'f', { type: 'DAY_VOTE', targetId: 'a' })).toBe('DEAD');
    s = act(s, 'c', { type: 'DAY_VOTE', targetId: 'a' });
    s = act(s, 'd', { type: 'DAY_VOTE', targetId: 'a' });
    s = act(s, 'e', { type: 'DAY_VOTE', targetId: 'a' });
    s = act(s, 'a', { type: 'DAY_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'DAY_VOTE', targetId: null });
    expect(s.players.a!.alive).toBe(false);
    expect(s.publicHistory.at(-1)?.exiled).toBe('a');
    expect(s.phase).toBe('night-wolf');
    expect(s.round).toBe(2);
    // 死狼人不再收到夜间私密行动信息
    expect(projectView(s, 'a').wolf?.votes).toBeNull();
    expect(projectView(s, 'a').pendingAction).toBeNull();
  });

  it('平票无人放逐，不进行二次投票', () => {
    let s = toVote();
    s = act(s, 'a', { type: 'DAY_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'DAY_VOTE', targetId: 'c' });
    s = act(s, 'c', { type: 'DAY_VOTE', targetId: 'a' });
    s = act(s, 'd', { type: 'DAY_VOTE', targetId: 'a' });
    s = act(s, 'e', { type: 'DAY_VOTE', targetId: null });
    expect(s.publicHistory.at(-1)?.exiled).toBeNull();
    expect(IDS.filter((id) => s.players[id]!.alive)).toHaveLength(5);
  });

  it('胜负：狼人数 ≥ 好人数时狼人胜，终局不可继续操作并公开身份', () => {
    let s = toVote(); // f 已死：2 狼 3 好
    for (const id of ['a', 'b', 'c']) s = act(s, id, { type: 'DAY_VOTE', targetId: id === 'c' ? 'e' : 'e' });
    s = act(s, 'd', { type: 'DAY_VOTE', targetId: null });
    s = act(s, 'e', { type: 'DAY_VOTE', targetId: null });
    expect(s.players.e!.alive).toBe(false); // 2 狼 2 好
    expect(s.result).toEqual({ winner: 'wolf' });
    expect(s.phase).toBe('finished');
    expect(code(s, 'c', { type: 'DAY_VOTE', targetId: 'a' })).toBe('GAME_OVER');
    expect(projectView(s, 'e').result?.roles.a).toBe('wolf');
  });
});

describe('投影白名单', () => {
  it('平民视图不含任何他人身份与夜间私密信息', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    const v = projectView(s, 'e');
    const json = JSON.stringify(v);
    expect(v.me?.role).toBe('villager');
    expect(v.wolf).toBeNull();
    expect(v.seer).toBeNull();
    expect(v.witch).toBeNull();
    // 不出现任何角色值（键名 wolf/seer/witch 为空对象占位）
    expect(json).not.toMatch(/:"(wolf|seer|witch)"/);
    // 狼人能看到队友与队友票
    expect(projectView(s, 'b').wolf).toEqual({ teammates: ['a'], votes: { a: 'e' }, target: null });
  });

  it('网络命令 schema：拒绝 PHASE_TIMEOUT 与非法字段', () => {
    expect(R.parseCommand({ type: 'PHASE_TIMEOUT' })).toBeNull();
    expect(R.parseCommand({ type: 'SEER_CHECK' })).toBeNull();
    expect(R.parseCommand({ type: 'WITCH_ACTION', action: 'poison' })).toBeNull();
    expect(R.parseCommand({ type: 'DAY_VOTE', targetId: null })).toEqual({ type: 'DAY_VOTE', targetId: null });
    expect(R.parseCommand('CONFIRM_ROLE')).toBeNull();
  });
});

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

  it('狼人意向选择：只同步给存活队友，可反复修改，确认后锁定，不参与结算', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_SELECT', targetId: 'e' });
    s = act(s, 'a', { type: 'WOLF_SELECT', targetId: 'f' });
    expect(projectView(s, 'b').wolf?.intents).toEqual({ a: 'f' });
    expect(projectView(s, 'a').wolf?.votes).toEqual({});
    // 非狼人看不到任何意向
    for (const id of ['c', 'd', 'e', 'f']) expect(JSON.stringify(projectView(s, id))).not.toContain('"f"}');
    expect(projectView(s, 'e').wolf).toBeNull();
    // 非狼 / 选狼队友 / 选死人 被拒绝
    expect(code(s, 'c', { type: 'WOLF_SELECT', targetId: 'e' })).toBe('FORBIDDEN');
    expect(code(s, 'a', { type: 'WOLF_SELECT', targetId: 'b' })).toBeNull(); // 可选队友
    // 意向不会让狼刀生效：b 确认 e，a 只有意向 f
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.phase).toBe('night-wolf');
    expect(projectView(s, 'a').wolf?.intents).toEqual({ a: 'f', b: 'e' });
    expect(projectView(s, 'a').wolf?.votes).toEqual({ b: 'e' });
    expect(code(s, 'b', { type: 'WOLF_SELECT', targetId: 'f' })).toBe('ALREADY_SUBMITTED');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.wolfTarget).toBe('e');
    // 下一阶段不再下发意向
    expect(projectView(s, 'a').wolf?.intents).toBeNull();
  });

  it('两狼意见不一致则空刀；非狼不能投狼票', () => {
    let s = toNight();
    expect(code(s, 'c', { type: 'WOLF_VOTE', targetId: 'e' })).toBe('FORBIDDEN');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'f' })).toBe('ALREADY_SUBMITTED');
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'f' });
    expect(s.wolfTarget).toBeNull();
  });

  it('狼人可以自刀或刀队友：两狼一致即生效', () => {
    let s = toNight();
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'a' })).toBeNull();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'b' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'b' });
    expect(s.wolfTarget).toBe('b');
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'e' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    // 女巫看到的狼刀目标是 b，不救则 b 死亡
    expect(projectView(s, 'd').witch?.wolfTarget).toBe('b');
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(s.players.b!.alive).toBe(false);
    expect(s.publicHistory.at(-1)?.deaths).toEqual(['b']);
  });

  it('只剩一狼时可以自刀', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'b' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'b' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'e' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    s = act(s, 'system', { type: 'END_DISCUSSION' });
    for (const id of ['a', 'c', 'd', 'e', 'f']) s = act(s, id, { type: 'DAY_VOTE', targetId: null });
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'a' });
    expect(s.wolfTarget).toBe('a');
  });

  it('预言家查验结果仅本人可见；女巫解药抵消狼刀，毒药独立结算', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'c' })).toBe('BAD_TARGET');
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    expect(projectView(s, 'c').seer?.checks).toEqual({ a: 'wolf' });
    expect(projectView(s, 'd').seer).toBeNull();
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' }); // 查验结果展示结束
    expect(s.phase).toBe('night-witch');
    expect(projectView(s, 'd').witch?.wolfTarget).toBe('e');
    expect(projectView(s, 'c').witch).toBeNull();
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'save' });
    expect(s.phase).toBe('day-discuss');
    expect(s.players.e!.alive).toBe(true);
    expect(s.publicHistory.at(-1)).toEqual({ round: 1, kind: 'night', deaths: [] });
    expect(s.witchInventory).toEqual({ antidote: false, poison: true });
  });

  it('预言家：已查验过的人不可再查；查验后停留在预言家阶段展示结果，到时才进入女巫阶段', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: null });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: null });
    const phaseId = s.phaseId;
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    expect(s.phase).toBe('night-seer');
    expect(s.phaseId).toBe(phaseId); // 不产生新的阶段播报
    expect(projectView(s, 'c').seer?.lastCheck).toEqual({ targetId: 'a', team: 'wolf' });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'b' })).toBe('ALREADY_SUBMITTED');
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(s.phase).toBe('night-witch');
    expect(projectView(s, 'c').seer?.lastCheck).toBeNull();
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    s = act(s, 'system', { type: 'END_DISCUSSION' });
    for (const id of IDS) s = act(s, id, { type: 'DAY_VOTE', targetId: null });
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: null });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: null });
    // 第二夜：a 已查验过
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'a' })).toBe('ALREADY_CHECKED');
    expect(code(s, 'c', { type: 'SEER_PASS' })).toBe('HAS_TARGET');
  });

  it('其他存活玩家都已查验过时，预言家可以放弃本夜查验', () => {
    let s = toNight();
    s = { ...s, seerChecks: { a: 'wolf', b: 'wolf', d: 'good', e: 'good', f: 'good' } };
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: null });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: null });
    expect(code(s, 'c', { type: 'SEER_CHECK', targetId: 'e' })).toBe('ALREADY_CHECKED');
    s = act(s, 'c', { type: 'SEER_PASS' });
    expect(projectView(s, 'c').seer?.lastCheck).toBeNull();
    expect(R.timer(s)?.ms).toBe(R.defaultConfig.seerRevealMs);
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(s.phase).toBe('night-witch');
  });

  it('女巫仅首夜可自救；同夜只能用一种药；毒药不能毒自己', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'd' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'd' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'e' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).toBeNull();
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'd' })).toBe('BAD_TARGET');
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'a' });
    expect(code(s, 'd', { type: 'WITCH_ACTION', action: 'save' })).not.toBeNull();
    // 狼刀女巫 + 毒狼 a：两人同时死亡
    expect(s.players.d!.alive).toBe(false);
    expect(s.players.a!.alive).toBe(false);
    expect(s.publicHistory.at(-1)?.deaths).toEqual(['a', 'd']);
  });

  it('回合内无倒计时：存活角色阶段、讨论与投票都没有计时，必须由玩家操作推进', () => {
    let s = toNight();
    expect(R.timer(s)).toBeNull();
    expect(code(s, 'system', { type: 'PHASE_TIMEOUT' })).toBe('WRONG_PHASE');
    expect(code(s, 'c', { type: 'PHASE_TIMEOUT' })).toBe('FORBIDDEN');
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'c' });
    expect(R.timer(s)).toBeNull(); // 预言家存活
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    // 查验后展示结果：隐藏计时 seerRevealMs
    expect(R.timer(s)).toEqual({ phaseId: s.phaseId, ms: R.defaultConfig.seerRevealMs, hidden: true });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(R.timer(s)).toBeNull(); // 女巫存活
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(s.phase).toBe('day-discuss');
    expect(R.timer(s)).toBeNull();
    s = act(s, 'system', { type: 'END_DISCUSSION' });
    expect(R.timer(s)).toBeNull();
  });

  it('已死亡角色的夜间阶段：隐藏延时（不下发）后推进，不立即跳过', () => {
    let s = toNight();
    // 第一夜刀死预言家 c
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
    expect(s.players.c!.alive).toBe(false);
    s = act(s, 'system', { type: 'END_DISCUSSION' });
    for (const id of ['a', 'b', 'd', 'e', 'f']) s = act(s, id, { type: 'DAY_VOTE', targetId: null });
    // 第二夜：预言家阶段仍然出现，并带隐藏计时
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'e' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'e' });
    expect(s.phase).toBe('night-seer');
    const t = R.timer(s)!;
    expect(t.hidden).toBe(true);
    expect(t.ms).toBeGreaterThanOrEqual(R.defaultConfig.deadRoleDelayMs.min);
    expect(t.ms).toBeLessThanOrEqual(R.defaultConfig.deadRoleDelayMs.max);
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    expect(s.phase).toBe('night-witch');
    expect(R.timer(s)).toBeNull(); // 女巫存活：等待操作
  });
});

describe('白天', () => {
  function toVote(): WerewolfState {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'f' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'f' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
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
    // 出局的狼人不再收到任何狼人私密信息，也没有可执行操作
    expect(projectView(s, 'a').wolf).toBeNull();
    expect(projectView(s, 'a').pendingAction).toBeNull();
    expect(code(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' })).toBe('DEAD');
    expect(code(s, 'a', { type: 'WOLF_SELECT', targetId: 'c' })).toBe('DEAD');
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
    expect(projectView(s, 'b').wolf).toEqual({ teammates: ['a'], votes: { a: 'e' }, intents: { a: 'e' }, target: null });
  });

  it('出局玩家只收到公开信息：预言家 / 女巫出局后不再下发查验记录与药品', () => {
    let s = toNight();
    s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'c' });
    s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
    s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
    s = act(s, 'd', { type: 'WITCH_ACTION', action: 'poison', targetId: 'b' });
    expect(s.result).toBeNull(); // 1 狼 3 好人，游戏继续
    expect(s.players.c!.alive).toBe(false);
    for (const id of ['b', 'c']) {
      const dead = projectView(s, id);
      expect(dead.me).toMatchObject({ alive: false });
      expect(dead.wolf).toBeNull();
      expect(dead.seer).toBeNull();
      expect(dead.witch).toBeNull();
      expect(dead.pendingAction).toBeNull();
      // 除自己的身份外，不含任何角色值或查验结果
      expect(JSON.stringify({ ...dead, me: null })).not.toMatch(/:"(wolf|seer|witch|good)"/);
      // 公开信息仍然下发
      expect(dead.history.at(-1)?.deaths).toEqual(['b', 'c']);
    }
  });

  it('神职出局后仍播报其夜间阶段，随机停留 3–8 秒（由 Host 私有种子决定）', () => {
    /** 首夜刀死预言家、毒死女巫以外的平民，次夜进入预言家阶段 */
    const toDeadSeerPhase = (seed: Uint8Array): { s: WerewolfState; texts: string[] } => {
      let s = R.createInitialState({
        matchId: 'm1',
        players: IDS.map((playerId, i) => ({ playerId, seat: i + 1 })),
        config: R.defaultConfig,
        seed,
        fixture: { rolesBySeat: ROLES },
      });
      for (const id of IDS) s = act(s, id, { type: 'CONFIRM_ROLE' });
      s = act(s, 'a', { type: 'WOLF_VOTE', targetId: 'c' });
      s = act(s, 'b', { type: 'WOLF_VOTE', targetId: 'c' });
      s = act(s, 'c', { type: 'SEER_CHECK', targetId: 'a' });
      s = act(s, 'system', { type: 'PHASE_TIMEOUT' });
      s = act(s, 'd', { type: 'WITCH_ACTION', action: 'pass' });
      s = act(s, 'system', { type: 'END_DISCUSSION' });
      for (const id of ['a', 'b', 'd', 'e', 'f']) s = act(s, id, { type: 'DAY_VOTE', targetId: null });
      s = act(s, 'a', { type: 'WOLF_VOTE', targetId: null });
      const c = ctx(s, 'b');
      const t = R.reduce(s, { type: 'WOLF_VOTE', targetId: null }, c);
      return { s: t.state, texts: [...R.announce(s, t.state, t.events)] };
    };
    const delays = new Set<number>();
    for (let n = 0; n < 12; n++) {
      const { s, texts } = toDeadSeerPhase(Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 11) & 255));
      expect(s.players.c!.alive).toBe(false);
      expect(s.phase).toBe('night-seer');
      // 照常播报，与预言家存活时一致
      expect(texts).toContain('狼人请闭眼。预言家请睁眼，选择要查验的玩家。');
      const t = R.timer(s)!;
      expect(t.hidden).toBe(true);
      expect(t.ms).toBeGreaterThanOrEqual(3000);
      expect(t.ms).toBeLessThanOrEqual(8000);
      delays.add(t.ms);
      // 停留结束后照常播报下一阶段
      const next = R.reduce(s, { type: 'PHASE_TIMEOUT' }, ctx(s, 'system'));
      expect(R.announce(s, next.state, next.events)).toContain('预言家请闭眼。女巫请睁眼。');
    }
    // 不同的 Host 种子得到不同的停留时长（客户端无法从 phaseId 推算）
    expect(delays.size).toBeGreaterThan(3);
  });

  it('网络命令 schema：拒绝 PHASE_TIMEOUT 与非法字段', () => {
    expect(R.parseCommand({ type: 'PHASE_TIMEOUT' })).toBeNull();
    expect(R.parseCommand({ type: 'SEER_CHECK' })).toBeNull();
    expect(R.parseCommand({ type: 'WITCH_ACTION', action: 'poison' })).toBeNull();
    expect(R.parseCommand({ type: 'DAY_VOTE', targetId: null })).toEqual({ type: 'DAY_VOTE', targetId: null });
    expect(R.parseCommand('CONFIRM_ROLE')).toBeNull();
  });
});

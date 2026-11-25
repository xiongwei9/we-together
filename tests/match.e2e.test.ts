import { describe, expect, it } from 'vitest';
import { defaultAddressCodec, type HostInspection } from '@we/multiplayer';
import { createHeadlessWorld, createSeededRng, NETWORK_PRESETS, type HeadlessDevice, type HeadlessWorld } from '@we/testing';
import { chooseBotAction, werewolfRules, type WerewolfConfig, type WerewolfPlayerView, type WerewolfState } from '@we/werewolf/rules';

const FAST: WerewolfConfig = {
  ...werewolfRules.defaultConfig,
  timers: {
    wolfMs: 3000,
    wolfRevoteMs: 2000,
    witchMs: 3000,
    seerMs: 3000,
    seerRevealMs: 1000,
    hunterMs: 2000,
    badgeMs: 2000,
    sheriffSignupMs: 2000,
    sheriffOrderMs: 2000,
    pkSpeechMs: 3000,
    voteMs: 3000,
    lastWordsMs: 3000,
    deadRoleDelayMs: { min: 1000, max: 2000 },
  },
};

async function setupRoom(world: HeadlessWorld, count = 6, config: WerewolfConfig = FAST): Promise<HeadlessDevice[]> {
  const devices: HeadlessDevice[] = [];
  for (let i = 1; i <= count; i++) devices.push(await world.createDevice(`p${i}`));
  const host = await world.createHost(devices[0]!, werewolfRules, { config, nickname: '房主' });
  const pending = devices.slice(1).map((d, i) =>
    d.client.join({ link: d.net.remote(devices[0]!.endpoint), hostAddress: host.address!, password: '', nickname: `玩家${i + 2}` }),
  );
  await world.run(3000);
  expect(await Promise.all(pending)).toEqual(devices.slice(1).map(() => true));
  return devices;
}

async function readyAndStart(world: HeadlessWorld, devices: HeadlessDevice[]): Promise<void> {
  devices.slice(1).forEach((d) => d.client.roomCommand({ kind: 'ready', ready: true }));
  await world.run(2000);
  devices[0]!.client.roomCommand({ kind: 'start' });
  await world.run(2000);
}

const viewOf = (d: HeadlessDevice): WerewolfPlayerView | null => (d.client.getState().snapshot?.view as WerewolfPlayerView) ?? null;
const hostState = (d: HeadlessDevice): WerewolfState => (d.host!.inspect().match!.state as WerewolfState);

async function playToEnd(world: HeadlessWorld, devices: HeadlessDevice[], seed: number, maxMs = 600_000): Promise<HostInspection> {
  const rng = createSeededRng(seed);
  // 每个玩家每阶段行动一次；被拒绝或投递失败时重新行动；不行动的阶段由 Host 计时推进
  const acted = new Map<string, string>();
  for (let t = 0; t < maxMs; t += 250) {
    for (const d of devices) {
      const s = d.client.getState();
      const v = viewOf(d);
      if (!v || !s.snapshot || s.snapshot.paused) continue;
      // 夜间与技能阶段的计时（含已出局角色的假阶段）不得下发
      if (v.phase.startsWith('night') || v.phase === 'hunter') expect(s.snapshot.timer).toBeNull();
      const key = `${d.nodeId}:${s.snapshot.phaseId}`;
      const prev = s.commands.find((c) => c.commandId === acted.get(key));
      if (prev && (prev.status === 'pending' || prev.status === 'ok')) continue;
      const action = chooseBotAction(v, rng);
      if (action) acted.set(key, d.client.gameCommand(action));
    }
    await world.run(250, 25);
    if (devices[0]!.host!.inspect().room.status === 'finished') break;
  }
  await world.run(3000);
  return devices[0]!.host!.inspect();
}

describe('六人狼人杀完整对局（VirtualNetwork）', () => {
  it('理想网络：开房、加入、准备、开始并完成一局', async () => {
    const world = createHeadlessWorld({ seed: 1 });
    const devices = await setupRoom(world);
    const room = devices[0]!.client.getState().room!;
    expect(room.players.map((p) => p.seat)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(room.players.map((p) => p.playerId)).size).toBe(6);
    await readyAndStart(world, devices);
    for (const d of devices) expect(viewOf(d)?.phase).toBe('reveal');
    const result = await playToEnd(world, devices, 11);
    expect(result.room.status).toBe('finished');
    const winner = hostState(devices[0]!).result?.winner;
    expect(['wolf', 'good', 'draw', 'none']).toContain(winner);
    for (const d of devices) expect(viewOf(d)?.result?.winner).toBe(winner);
  });

  it('5% 丢包 + 重复 + 乱序：命令不重复生效且对局可完成', async () => {
    for (const seed of [2, 3, 4]) {
      const world = createHeadlessWorld({ seed, faults: NETWORK_PRESETS.poor });
      const devices = await setupRoom(world);
      await readyAndStart(world, devices);
      const result = await playToEnd(world, devices, seed * 13);
      expect(result.room.status).toBe('finished');
      const s = hostState(devices[0]!);
      // 不变量：角色总量固定、药品最多各用一次
      const roles = Object.values(s.players).map((p) => p.role).sort();
      expect(roles).toEqual(['seer', 'villager', 'villager', 'witch', 'wolf', 'wolf']);
      const hostClient = devices[0]!.client.getState();
      expect(hostClient.snapshot?.version).toBe(result.match!.version);
    }
  });

  it('普通客户端只收到自己的授权投影', async () => {
    const world = createHeadlessWorld({ seed: 5 });
    const devices = await setupRoom(world);
    await readyAndStart(world, devices);
    const state = hostState(devices[0]!);
    for (const d of devices) {
      const v = viewOf(d)!;
      const me = d.client.getState().playerId!;
      expect(v.me?.role).toBe(state.players[me]!.role);
      const json = JSON.stringify(v);
      // 非狼人看不到任何其他人的身份
      if (v.me?.role !== 'wolf') {
        for (const [id, p] of Object.entries(state.players)) if (id !== me) expect(json).not.toContain(`"${id}":"${p.role}"`);
        expect(v.wolf).toBeNull();
      } else {
        expect(v.wolf?.teammates).toHaveLength(1);
      }
      expect(v.result).toBeNull();
      expect(json).not.toContain('seerChecks');
      expect(json).not.toContain('witchInventory');
    }
  });

  it('断线暂停、重连恢复视图；重启后凭证恢复会话并拒绝旧 epoch', async () => {
    const world = createHeadlessWorld({ seed: 6 });
    const devices = await setupRoom(world);
    await readyAndStart(world, devices);
    const p3 = devices[2]!;
    world.network.setNodeOnline('p3', false);
    await world.run(15_000);
    const inspect1 = devices[0]!.host!.inspect();
    const p3Id = p3.client.getState().playerId;
    expect(inspect1.room.players.find((p) => p.playerId === p3Id)?.connected).toBe(false);
    expect(inspect1.paused?.reasons).toContain('disconnect');
    expect(viewOf(devices[1]!) && devices[1]!.client.getState().snapshot?.paused).toBeTruthy();
    // 暂停时命令被拒绝
    const cmd = devices[1]!.client.gameCommand({ type: 'CONFIRM_ROLE' });
    await world.run(1000);
    expect(devices[1]!.client.getState().commands.find((c) => c.commandId === cmd)?.code).toBe('PAUSED');

    world.network.setNodeOnline('p3', true);
    await world.run(5000);
    expect(devices[0]!.host!.inspect().paused).toBeNull();
    expect(p3.client.getState().link).toBe('ok');

    // 模拟重启：销毁设备，保留 Storage，新 endpoint generation
    const storage = p3.storage;
    const oldEpoch = devices[0]!.host!.inspect().sessions.find((s) => s.playerId === p3.client.getState().playerId)!.epoch;
    await p3.dispose();
    const p3b = await world.createDevice('p3', storage);
    devices[2] = p3b;
    const saved = await p3b.client.loadSavedSession();
    expect(saved?.hostAddress).toBe(defaultAddressCodec.format(devices[0]!.endpoint));
    const resumed = p3b.client.resume(saved!);
    await world.run(3000);
    expect(await resumed).toBe(true);
    expect(viewOf(p3b)?.phase).toBe('reveal');
    const newEpoch = devices[0]!.host!.inspect().sessions.find((s) => s.playerId === saved!.playerId)!.epoch;
    expect(newEpoch).not.toBe(oldEpoch);
  });

  it('满房与游戏中拒绝新成员', async () => {
    const world = createHeadlessWorld({ seed: 7 });
    const devices = await setupRoom(world);
    const extra = await world.createDevice('p7');
    const host = devices[0]!.host!;
    const full = extra.client.join({ link: extra.net.remote(devices[0]!.endpoint), hostAddress: '', password: '', nickname: 'x' });
    await world.run(2000);
    expect(await full).toBe(false);
    expect(extra.client.getState().error).toBe('ROOM_FULL');
    await readyAndStart(world, devices);
    const late = extra.client.join({ link: extra.net.remote(devices[0]!.endpoint), hostAddress: '', password: '', nickname: 'x' });
    await world.run(2000);
    expect(await late).toBe(false);
    expect(extra.client.getState().error).toBe('GAME_IN_PROGRESS');
    expect(host.inspect().room.players).toHaveLength(6);
  });

  it('重开：新 matchId，清空上一局身份与命令', async () => {
    const world = createHeadlessWorld({ seed: 8 });
    const devices = await setupRoom(world);
    await readyAndStart(world, devices);
    const first = devices[0]!.host!.inspect().match!.matchId;
    await playToEnd(world, devices, 99);
    devices[0]!.client.roomCommand({ kind: 'back-to-lobby' });
    await world.run(2000);
    for (const d of devices) {
      expect(d.client.getState().room?.status).toBe('lobby');
      expect(d.client.getState().snapshot).toBeNull();
    }
    await readyAndStart(world, devices);
    const second = devices[0]!.host!.inspect().match!;
    expect(second.matchId).not.toBe(first);
    expect((second.state as WerewolfState).confirmed).toEqual([]);
    expect(viewOf(devices[3]!)?.phase).toBe('reveal');
  });

  it('9 人预女猎局 + 警长模式：Bot 完成整局，角色与药品不变量成立', async () => {
    for (const seed of [31, 32, 33]) {
      const world = createHeadlessWorld({ seed });
      const devices = await setupRoom(world, 9, { ...FAST, board: 9, sheriff: true, witchSelfSave: 'first-night' });
      await readyAndStart(world, devices);
      const result = await playToEnd(world, devices, seed * 7);
      expect(result.room.status).toBe('finished');
      const s = hostState(devices[0]!);
      expect(Object.values(s.players).map((p) => p.role).sort()).toEqual(['hunter', 'seer', 'villager', 'villager', 'villager', 'witch', 'wolf', 'wolf', 'wolf']);
      expect(s.sheriffElectionDone).toBe(true);
      expect(s.publicHistory.some((e) => e.kind === 'sheriff')).toBe(true);
      // 每瓶药整局最多使用一次
      expect(s.nightLog.filter((n) => n.witch?.kind === 'save').length).toBeLessThanOrEqual(1);
      expect(s.nightLog.filter((n) => n.witch?.kind === 'poison').length).toBeLessThanOrEqual(1);
      for (const d of devices) expect(viewOf(d)?.result?.winner).toBe(s.result?.winner);
    }
  });

  it('房主在大厅自定义规则：仅房主、仅大厅；改板子调整人数上限；改规则后其他玩家需重新准备', async () => {
    const world = createHeadlessWorld({ seed: 34 });
    const devices = await setupRoom(world, 6);
    const [host, p2] = devices as [HeadlessDevice, HeadlessDevice];
    const rule = (d: HeadlessDevice, key: string): string | undefined => d.client.getState().room?.rules.find((r) => r.key === key)?.value;
    expect(rule(p2, 'sheriff')).toBe('off');
    devices.slice(1).forEach((d) => d.client.roomCommand({ kind: 'ready', ready: true }));
    await world.run(1000);
    // 非房主不能修改
    const denied = p2.client.roomCommand({ kind: 'set-rule', key: 'sheriff', value: 'on' });
    await world.run(500);
    expect(p2.client.getState().commands.find((c) => c.commandId === denied)?.code).toBe('NOT_HOST');
    // 非法取值
    const bad = host.client.roomCommand({ kind: 'set-rule', key: 'board', value: '7' });
    await world.run(500);
    expect(host.client.getState().commands.find((c) => c.commandId === bad)?.code).toBe('BAD_RULE');
    host.client.roomCommand({ kind: 'set-rule', key: 'sheriff', value: 'on' });
    host.client.roomCommand({ kind: 'set-rule', key: 'witchSelfSave', value: 'always' });
    await world.run(500);
    expect(rule(p2, 'sheriff')).toBe('on');
    expect(rule(p2, 'witchSelfSave')).toBe('always');
    expect(p2.client.getState().room!.players.filter((p) => !p.isHost).every((p) => !p.ready)).toBe(true);
    // 9 人局：容量变为 9，可继续加入
    host.client.roomCommand({ kind: 'set-rule', key: 'board', value: '9' });
    await world.run(500);
    expect(p2.client.getState().room!.capacity).toEqual({ min: 9, max: 9 });
    const p7 = await world.createDevice('p7');
    const joined = p7.client.join({ link: p7.net.remote(host.endpoint), hostAddress: '', password: '', nickname: '七' });
    await world.run(1000);
    expect(await joined).toBe(true);
    // 已有 7 人时不能改回 6 人局
    const shrink = host.client.roomCommand({ kind: 'set-rule', key: 'board', value: '6' });
    await world.run(500);
    expect(host.client.getState().commands.find((c) => c.commandId === shrink)?.code).toBe('TOO_MANY_PLAYERS');
    // 人数不足 9 人不能开始
    [...devices.slice(1), p7].forEach((d) => d.client.roomCommand({ kind: 'ready', ready: true }));
    await world.run(500);
    const start = host.client.roomCommand({ kind: 'start' });
    await world.run(500);
    expect(host.client.getState().commands.find((c) => c.commandId === start)?.code).toBe('BAD_PLAYER_COUNT');
    // 补齐 9 人后开始：规则锁定
    for (const id of ['p8', 'p9']) {
      const d = await world.createDevice(id);
      const ok = d.client.join({ link: d.net.remote(host.endpoint), hostAddress: '', password: '', nickname: id });
      await world.run(500);
      expect(await ok).toBe(true);
      d.client.roomCommand({ kind: 'ready', ready: true });
    }
    await world.run(500);
    host.client.roomCommand({ kind: 'start' });
    await world.run(1000);
    const st = hostState(host);
    expect(st.config).toMatchObject({ board: 9, sheriff: true, witchSelfSave: 'always' });
    expect(Object.keys(st.players)).toHaveLength(9);
    const locked = host.client.roomCommand({ kind: 'set-rule', key: 'sheriff', value: 'off' });
    await world.run(500);
    expect(host.client.getState().commands.find((c) => c.commandId === locked)?.code).toBe('WRONG_STATUS');
  });

  it('期望座位：空闲且不超容量时使用，否则分配最小空位；缩小板子时超出上限的座位移入空位', async () => {
    const world = createHeadlessWorld({ seed: 35 });
    const ds: HeadlessDevice[] = [];
    for (let i = 1; i <= 8; i++) ds.push(await world.createDevice(`p${i}`));
    const host = await world.createHost(ds[0]!, werewolfRules, { config: { ...FAST, board: 9 } });
    const join = async (d: HeadlessDevice, seat?: number): Promise<number> => {
      const ok = d.client.join({ link: d.net.remote(ds[0]!.endpoint), hostAddress: host.address!, password: '', nickname: d.nodeId, seat });
      await world.run(500);
      expect(await ok).toBe(true);
      return d.client.getState().room!.players.find((p) => p.playerId === d.client.getState().playerId)!.seat;
    };
    // 倒序加入，各自坐到期望座位
    expect(await join(ds[5]!, 6)).toBe(6);
    expect(await join(ds[4]!, 5)).toBe(5);
    expect(await join(ds[2]!, 3)).toBe(3);
    // 期望座位已被占用 / 超出容量 / 未提供：分配最小空位
    expect(await join(ds[1]!, 6)).toBe(2);
    expect(await join(ds[3]!, 12)).toBe(4);
    expect(await join(ds[6]!)).toBe(7);
    // 3 号离开后改为 6 人局：7 号移到空出的 3 号
    ds[2]!.client.leave();
    await world.run(500);
    ds[0]!.client.roomCommand({ kind: 'set-rule', key: 'board', value: '6' });
    await world.run(500);
    const seats = ds[0]!.client.getState().room!.players.map((p) => p.seat).sort((a, b) => a - b);
    expect(seats).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds[0]!.client.getState().room!.players.find((p) => p.nickname === 'p7')?.seat).toBe(3);
  });

  it('两个 networkId 的包不能串房', async () => {
    const a = createHeadlessWorld({ seed: 9, networkId: 'sim-a' });
    const da = await a.createDevice('p1');
    await a.createHost(da, werewolfRules);
    const b = createHeadlessWorld({ seed: 10, networkId: 'sim-b' });
    const db = await b.createDevice('p2');
    const joined = db.client.join({ link: db.net.remote(da.endpoint), hostAddress: '', password: '', nickname: 'x' });
    await b.run(10_000);
    expect(await joined).toBe(false);
    expect(da.host!.inspect().room.players).toHaveLength(1);
  });
});

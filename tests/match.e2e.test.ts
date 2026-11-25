import { describe, expect, it } from 'vitest';
import { defaultAddressCodec, type HostInspection } from '@we/multiplayer';
import { createHeadlessWorld, createSeededRng, NETWORK_PRESETS, type HeadlessDevice, type HeadlessWorld } from '@we/testing';
import { chooseBotAction, werewolfRules, type WerewolfPlayerView, type WerewolfState } from '@we/werewolf/rules';

const FAST = { deadRoleDelayMs: { min: 1000, max: 2000 }, seerRevealMs: 1000 };

async function setupRoom(world: HeadlessWorld, count = 6): Promise<HeadlessDevice[]> {
  const devices: HeadlessDevice[] = [];
  for (let i = 1; i <= count; i++) devices.push(await world.createDevice(`p${i}`));
  const host = await world.createHost(devices[0]!, werewolfRules, { config: FAST, nickname: '房主' });
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
  // 回合内没有超时：每个玩家每阶段行动一次；被拒绝或投递失败时重新行动
  const acted = new Map<string, string>();
  for (let t = 0; t < maxMs; t += 250) {
    for (const d of devices) {
      const s = d.client.getState();
      const v = viewOf(d);
      if (!v || !s.snapshot || s.snapshot.paused) continue;
      // 回合内无倒计时；已死亡角色阶段的隐藏延时也不得下发
      expect(s.snapshot.timer).toBeNull();
      const key = `${d.nodeId}:${s.snapshot.phaseId}`;
      const prev = s.commands.find((c) => c.commandId === acted.get(key));
      if (prev && (prev.status === 'pending' || prev.status === 'ok')) continue;
      const action = chooseBotAction(v, rng);
      if (action) acted.set(key, d.client.gameCommand(action));
    }
    // Host 结束讨论（公共控制）
    const hv = viewOf(devices[0]!);
    if (hv?.phase === 'day-discuss' && rng() < 0.3) devices[0]!.client.gameCommand({ type: 'END_DISCUSSION' });
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
    expect(['wolf', 'good', 'draw']).toContain(winner);
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

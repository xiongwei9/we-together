import { describe, expect, it } from 'vitest';
import type { Envelope, PlayerSnapshot } from '@we/multiplayer';
import { createHeadlessWorld, createSeededRng, type HeadlessDevice, type HeadlessWorld } from '@we/testing';
import { chooseBotAction, werewolfRules, type WerewolfPlayerView, type WerewolfState } from '@we/werewolf/rules';

async function started(world: HeadlessWorld): Promise<HeadlessDevice[]> {
  const ds: HeadlessDevice[] = [];
  for (let i = 1; i <= 6; i++) ds.push(await world.createDevice(`p${i}`));
  const host = await world.createHost(ds[0]!, werewolfRules);
  // 依次加入，座位与节点一致
  for (const d of ds.slice(1)) {
    const p = d.client.join({ link: d.net.remote(ds[0]!.endpoint), hostAddress: host.address!, password: '', nickname: d.nodeId });
    await world.run(300);
    expect(await p).toBe(true);
  }
  ds.slice(1).forEach((d) => d.client.roomCommand({ kind: 'ready', ready: true }));
  await world.run(500);
  ds[0]!.client.roomCommand({ kind: 'start' });
  await world.run(500);
  return ds;
}

/** 以 d 的会话身份直接发送原始 envelope（模拟重发 / 篡改） */
function raw(d: HeadlessDevice, host: HeadlessDevice, patch: Partial<Envelope> & { type: string; payload: unknown }): void {
  const s = d.client.getState();
  const env: Envelope = {
    v: 1,
    roomId: s.room!.roomId,
    matchId: s.snapshot?.matchId ?? null,
    from: s.playerId!,
    to: 'host',
    sessionEpoch: (host.host!.inspect().sessions.find((x) => x.playerId === s.playerId)?.epoch ?? ''),
    messageId: `raw${Math.random().toString(36).slice(2)}`,
    ...patch,
  };
  d.net.remote(host.endpoint).send(env, { reliable: true });
}

const state = (h: HeadlessDevice): WerewolfState => h.host!.inspect().match!.state as WerewolfState;

describe('命令语义', () => {
  it('同 commandId 重发返回同一结果且只生效一次；同 ID 不同 payload 被拒绝', async () => {
    const world = createHeadlessWorld({ seed: 21 });
    const [h, p2] = await started(world);
    const snap = p2!.client.getState().snapshot as PlayerSnapshot;
    const cmd = { commandId: 'cmdfixed1', phaseId: snap.phaseId, expectedVersion: snap.version, action: { type: 'CONFIRM_ROLE' } };
    raw(p2!, h!, { type: 'GAME_COMMAND', payload: cmd });
    await world.run(300);
    const v1 = h!.host!.inspect().match!.version;
    raw(p2!, h!, { type: 'GAME_COMMAND', payload: cmd });
    await world.run(300);
    expect(h!.host!.inspect().match!.version).toBe(v1);
    expect(state(h!).confirmed.filter((id) => id === p2!.client.getState().playerId)).toHaveLength(1);
    // 同 ID、不同 payload
    raw(p2!, h!, { type: 'GAME_COMMAND', payload: { ...cmd, action: { type: 'VOTE', targetId: null } } });
    await world.run(300);
    expect(h!.host!.inspect().match!.version).toBe(v1);
  });

  it('旧 phaseId 被拒绝；客户端重试保持同一 commandId', async () => {
    const world = createHeadlessWorld({ seed: 22 });
    const ds = await started(world);
    const [h, p2] = ds;
    const stale = p2!.client.getState().snapshot!.phaseId;
    ds.forEach((d) => d.client.gameCommand({ type: 'CONFIRM_ROLE' }));
    await world.run(1000);
    expect(state(h!).phase).toBe('night-wolf');
    raw(p2!, h!, { type: 'GAME_COMMAND', payload: { commandId: 'cmdstale', phaseId: stale, expectedVersion: 0, action: { type: 'VOTE', targetId: null } } });
    await world.run(300);
    // 结果回到客户端前，客户端不知道这个原始命令；直接检查 Host 状态未变
    expect(state(h!).phase).toBe('night-wolf');
    // 客户端已拿到新阶段：规则层拒绝；重试同一 commandId 得到同一缓存结果
    const id = p2!.client.gameCommand({ type: 'CONFIRM_ROLE' });
    await world.run(300);
    expect(p2!.client.getState().commands.find((c) => c.commandId === id)?.code).toBe('WRONG_PHASE');
    const v = h!.host!.inspect().match!.version;
    p2!.client.retry(id);
    await world.run(300);
    expect(p2!.client.getState().commands.find((c) => c.commandId === id)?.code).toBe('WRONG_PHASE');
    expect(h!.host!.inspect().match!.version).toBe(v);
  });

  it('多人并发投票都被顺序处理；只有当前发言者能结束发言；伪造会话被拒绝', async () => {
    const world = createHeadlessWorld({ seed: 23 });
    const ds = await started(world);
    const [h] = ds;
    const idOf = (d: HeadlessDevice): string => d.client.getState().playerId!;
    ds.forEach((d) => d.client.gameCommand({ type: 'CONFIRM_ROLE' }));
    await world.run(1000);
    // 夜间各角色由 Bot 行动；狼人空刀、女巫不用药，保证首夜是平安夜
    const rng = createSeededRng(5);
    for (let i = 0; i < 20 && state(h!).phase !== 'day-speech'; i++) {
      for (const d of ds) {
        const a = chooseBotAction(d.client.getState().snapshot!.view as WerewolfPlayerView, rng);
        if (!a) continue;
        if (a.type === 'WITCH_ACTION') d.client.gameCommand({ type: 'WITCH_ACTION', action: 'pass' });
        else if (a.type === 'WOLF_VOTE') d.client.gameCommand({ type: 'WOLF_VOTE', targetId: null });
        else d.client.gameCommand(a);
      }
      await world.run(500);
    }
    expect(state(h!).phase).toBe('day-speech');
    const speaker = (): HeadlessDevice => ds.find((d) => idOf(d) === state(h!).speech!.order[state(h!).speech!.index])!;
    const other = ds.find((d) => d !== speaker())!;
    const id = other.client.gameCommand({ type: 'END_SPEECH' });
    await world.run(300);
    expect(other.client.getState().commands.find((c) => c.commandId === id)?.code).toBe('NOT_YOUR_TURN');
    // 跳过发言是房主公共控制：非房主被拒绝；房主在计时模式下被规则拒绝
    const nonHost = ds.find((d) => d !== h && d !== speaker())!;
    const skip = nonHost.client.gameCommand({ type: 'SKIP_SPEECH' });
    const hostSkip = h!.client.gameCommand({ type: 'SKIP_SPEECH' });
    await world.run(300);
    expect(nonHost.client.getState().commands.find((c) => c.commandId === skip)?.code).toBe('NOT_HOST');
    expect(h!.client.getState().commands.find((c) => c.commandId === hostSkip)?.code).toBe('DISABLED');
    // 伪造：用当前发言者的 playerId 但另一台设备的地址与错误 epoch
    const before = state(h!).phaseId;
    raw(other, h!, {
      type: 'GAME_COMMAND',
      from: idOf(speaker()),
      sessionEpoch: 'forged',
      payload: { commandId: 'cmdforge', phaseId: before, expectedVersion: 0, action: { type: 'END_SPEECH' } },
    });
    await world.run(300);
    expect(state(h!).phaseId).toBe(before);
    for (let i = 0; i < 10 && state(h!).phase === 'day-speech'; i++) {
      speaker().client.gameCommand({ type: 'END_SPEECH' });
      await world.run(300);
    }
    expect(state(h!).phase).toBe('day-vote');
    ds.forEach((d) => d.client.gameCommand({ type: 'VOTE', targetId: null }));
    await world.run(1000);
    for (const d of ds) expect(d.client.getState().commands.at(-1)?.status).toBe('ok');
    expect(state(h!).publicHistory.at(-1)).toMatchObject({ kind: 'vote', exiled: null });
  });

  it('Host 关闭房间：客户端收到 ROOM_CLOSED 并清除恢复凭证', async () => {
    const world = createHeadlessWorld({ seed: 24 });
    const ds = await started(world);
    expect(await ds[2]!.storage.get('session')).not.toBeNull();
    ds[0]!.client.roomCommand({ kind: 'close-room' });
    await world.run(1000);
    for (const d of ds.slice(1)) expect(d.client.getState().phase).toBe('closed');
    expect(await ds[2]!.storage.get('session')).toBeNull();
  });
});

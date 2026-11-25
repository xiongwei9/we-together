import { describe, expect, it } from 'vitest';
import { createGameInstance, type GameInstance } from '@we/game-app';
import { createManualClock, createSeededRandom, createSeededRng, createVirtualNetwork, NETWORK_PRESETS } from '@we/testing';
import { werewolfGame } from '@we/werewolf';
import type { WerewolfPlayerView } from '@we/werewolf/rules';
import { createFakePlatform, type FakePlatform } from './fake-platform';

const FAST = { deadRoleDelayMs: { min: 1000, max: 2000 }, seerRevealMs: 1000 };

async function setup(seed: number, preset: keyof typeof NETWORK_PRESETS = 'ideal') {
  const clock = createManualClock(1000);
  const network = createVirtualNetwork({ networkId: 'ui-net', clock, seed, faults: NETWORK_PRESETS[preset] });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };
  const run = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 16) {
      clock.advance(16);
      await flush();
    }
  };
  const devices: { inst: GameInstance; platform: FakePlatform }[] = [];
  for (let i = 1; i <= 6; i++) {
    const platform = createFakePlatform({ clock, random: createSeededRandom(seed * 100 + i) });
    const inst = createGameInstance({
      instanceId: `p${i}`,
      platform,
      transport: network.createTransport(`p${i}`),
      games: [werewolfGame],
      gameConfig: FAST,
      debug: true,
      defaultNickname: `玩家${i}`,
    });
    devices.push({ inst, platform });
  }
  const starting = Promise.all(devices.map((d) => d.inst.start()));
  await run(100);
  await starting;
  return { clock, network, devices, run, flush };
}

/** 在最近一次布局中找到标签匹配的可点击区域并点击其中心 */
function click(d: { inst: GameInstance; platform: FakePlatform }, label: string | RegExp): void {
  const items = d.inst.debug!.ui()!.pressables();
  const match = items.filter((p) => !p.disabled && (typeof label === 'string' ? p.label.includes(label) : label.test(p.label)));
  const target = match[match.length - 1];
  if (!target) throw new Error(`no pressable "${String(label)}" on ${d.inst.instanceId}: ${items.map((p) => `[${p.label}${p.disabled ? '×' : ''}]`).join(' ')}`);
  d.platform.tap(target.x + target.w / 2, target.y + target.h / 2);
}

const view = (d: { inst: GameInstance }): WerewolfPlayerView | null => (d.inst.getStatus().client.snapshot?.view as WerewolfPlayerView) ?? null;

describe('单页面六个独立游戏实例（共享 Canvas UI）', () => {
  it('通过点击 Canvas 按钮完成开房、加入、准备、开始与身份确认，并由 Bot 走完整局', async () => {
    const { devices, run, clock, network } = await setup(3);
    const [host, p2] = devices as [(typeof devices)[0], (typeof devices)[0]];

    // 创建房间时可选密码：留空表示不设密码
    host.platform.prompts.push('');
    click(host, '创建房间');
    await run(300);
    const info = host.inst.getStatus().hostInfo!;
    expect(info.address).toBe('mem:ui-net/p1');
    expect(info.password).toBeNull();

    // 玩家 2 完全通过 UI 加入：无需输入地址，房间列表由局域网广播发现
    click(p2, '加入房间');
    await run(500);
    expect(p2.inst.getStatus().rooms.map((r) => r.hostName)).toEqual(['玩家1']);
    click(p2, '玩家1 的房间');
    await run(500);
    expect(p2.inst.getStatus().client.phase).toBe('in-room');

    for (const d of devices.slice(2)) d.inst.actions.searchRooms();
    await run(1200);
    for (const d of devices.slice(2)) void d.inst.actions.joinDiscovered(d.inst.getStatus().rooms[0]!.key);
    await run(1000);
    for (const d of devices.slice(1)) {
      click(d, /^准备$/);
    }
    await run(500);
    click(host, '开始游戏');
    await run(500);
    for (const d of devices) expect(view(d)?.phase).toBe('reveal');

    // 翻牌查看身份，然后确认
    for (const d of devices) {
      click(d, '点击翻看身份');
      await run(20);
      click(d, '我已记住身份');
    }
    await run(500);
    expect(view(host)?.phase).toBe('night-wolf');

    // 狼人选择目标：可选任意存活玩家（含自刀）；队友的意向选择实时显示
    const wolves = devices.filter((d) => view(d)?.me?.role === 'wolf');
    expect(wolves).toHaveLength(2);
    const [wa, wb] = wolves as [(typeof devices)[0], (typeof devices)[0]];
    const room = host.inst.getStatus().client.room!;
    const nameOf = (id: string): string => {
      const p = room.players.find((x) => x.playerId === id)!;
      return `${p.seat}号 ${p.nickname}`;
    };
    const idOf = (d: (typeof devices)[0]): string => d.inst.getStatus().client.playerId!;
    const victimId = view(wa)!.players.find((p) => p.playerId !== idOf(wa) && p.playerId !== idOf(wb))!.playerId;
    const tile = (d: (typeof devices)[0], id: string) => d.inst.debug!.ui()!.pressables().find((x) => x.label.startsWith(nameOf(id)));
    await run(100);
    const selectable = (d: (typeof devices)[0], id: string): boolean => !!tile(d, id) && !tile(d, id)!.disabled;
    // 狼人可以刀自己或队友：都可选
    expect(selectable(wb, idOf(wb))).toBe(true);
    expect(selectable(wb, idOf(wa))).toBe(true);
    expect(selectable(wb, victimId)).toBe(true);
    click(wa, nameOf(victimId));
    await run(300);
    expect(tile(wb, victimId)?.label).toContain(`${nameOf(idOf(wa)).split(' ')[0]}想刀`);
    // 确认后显示为「已确认」
    click(wa, '确认击杀');
    await run(300);
    expect(tile(wb, victimId)?.label).toContain('已确认');
    expect(host.platform.announcements.some((a) => a.includes('天黑请闭眼'))).toBe(true);
    // 非 Host 不播放公共音频
    expect(p2.platform.announcements).toHaveLength(0);

    const rng = createSeededRng(7);
    for (let i = 0; i < 400 && host.inst.getStatus().client.room?.status !== 'finished'; i++) {
      for (const d of devices) {
        const v = view(d);
        if (!v) continue;
        const a = werewolfGame.bot!(v, rng);
        if (a && !d.inst.getStatus().client.commands.some((c) => c.status === 'pending')) d.inst.actions.sendGameAction(a);
      }
      // 回合内无倒计时：讨论阶段由房主点击按钮结束
      if (view(host)?.phase === 'day-discuss') click(host, '结束讨论');
      await run(400);
    }
    expect(host.inst.getStatus().client.room?.status).toBe('finished');
    await run(300);
    for (const d of devices) expect(view(d)?.result).not.toBeNull();

    // 结果页 → 房主返回房间
    click(host, '返回房间');
    await run(500);
    for (const d of devices) expect(d.inst.getStatus().client.room?.status).toBe('lobby');

    // 销毁全部实例后不残留定时器 / 待投递包
    for (const d of devices) await d.inst.dispose();
    await run(3000);
    network.dispose();
    expect(clock.pending()).toBe(0);
  });

  it('实例隔离：Storage 独立、切后台不影响其他实例、Host 切后台暂停并需手动继续', async () => {
    const { devices, run } = await setup(5);
    const [host] = devices;
    await Promise.all([host!.inst.actions.createRoom({ password: '' }), run(200)]);
    const info = host!.inst.getStatus().hostInfo!;
    // 兜底路径：按地址手动加入
    await Promise.all([run(500), ...devices.slice(1).map((d) => d.inst.actions.joinRoom(info.address!))]);
    await run(1000);
    devices.slice(1).forEach((d) => d.inst.actions.setReady(true));
    await run(500);
    host!.inst.actions.startMatch();
    await run(500);

    // 每个实例的 Storage 只包含自己的会话
    const ids = new Set<string>();
    for (const d of devices.slice(1)) {
      const s = JSON.parse((await d.platform.storage.get('session'))!) as { playerId: string };
      expect(s.playerId).toBe(d.inst.getStatus().client.playerId);
      ids.add(s.playerId);
    }
    expect(ids.size).toBe(5);

    // 普通实例切后台：其他实例不受影响
    devices[3]!.inst.setVisible(false);
    await run(2000);
    expect(view(devices[2]!)?.phase).toBe('reveal');
    expect(devices[2]!.inst.getStatus().client.snapshot?.paused).toBeNull();
    devices[3]!.inst.setVisible(true);
    await run(1000);

    // Host 切后台：暂停；回前台后仍暂停，房主点击“继续游戏”后恢复
    host!.platform.visibility(false);
    await run(1000);
    expect(devices[1]!.inst.getStatus().client.snapshot?.paused?.reasons).toContain('host-hidden');
    host!.platform.visibility(true);
    await run(1000);
    expect(devices[1]!.inst.getStatus().client.snapshot?.paused).not.toBeNull();
    click(host!, '继续游戏');
    await run(500);
    expect(devices[1]!.inst.getStatus().client.snapshot?.paused).toBeNull();
  });
  it('有密码的房间：列表显示锁标记，点击后输入密码，错误提示后可重试', async () => {
    const { devices, run } = await setup(9);
    const [host, p2] = devices as [(typeof devices)[0], (typeof devices)[0]];
    host.platform.prompts.push('2468');
    click(host, '创建房间');
    await run(300);
    expect(host.inst.getStatus().hostInfo?.password).toBe('2468');

    click(p2, '加入房间');
    await run(500);
    expect(p2.inst.getStatus().rooms[0]?.hasPassword).toBe(true);
    p2.platform.prompts.push('0000');
    click(p2, '需密码');
    await run(500);
    expect(p2.inst.getStatus().client.phase).toBe('idle');
    expect(p2.inst.getStatus().client.error).toBe('BAD_PASSWORD');
    p2.platform.prompts.push('2468');
    click(p2, '需密码');
    await run(500);
    expect(p2.inst.getStatus().client.phase).toBe('in-room');
    // 进入大厅，房间列表不再显示
    expect(p2.inst.debug!.ui()!.pressables().some((x) => x.label.includes('需密码'))).toBe(false);
  });
  it('预言家：查验后停留展示结果（本地倒计时），到时进入女巫阶段；已查验的人下一夜不可选', async () => {
    const { devices, run } = await setup(11);
    const [host] = devices as [(typeof devices)[0]];
    await Promise.all([host.inst.actions.createRoom({ password: '' }), run(200)]);
    for (const d of devices.slice(1)) {
      d.inst.actions.searchRooms();
    }
    await run(1200);
    for (const d of devices.slice(1)) void d.inst.actions.joinDiscovered(d.inst.getStatus().rooms[0]!.key);
    await run(1000);
    devices.slice(1).forEach((d) => d.inst.actions.setReady(true));
    await run(500);
    host.inst.actions.startMatch();
    await run(500);
    devices.forEach((d) => d.inst.actions.sendGameAction({ type: 'CONFIRM_ROLE' }));
    await run(500);
    const byRole = (r: string) => devices.find((d) => view(d)?.me?.role === r)!;
    const seer = byRole('seer');
    const room = host.inst.getStatus().client.room!;
    const nameOf = (id: string): string => {
      const p = room.players.find((x) => x.playerId === id)!;
      return `${p.seat}号 ${p.nickname}`;
    };
    const wolves = devices.filter((d) => view(d)?.me?.role === 'wolf');
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: null }));
    await run(500);
    expect(view(seer)?.phase).toBe('night-seer');
    const targetId = wolves[0]!.inst.getStatus().client.playerId!;
    click(seer, nameOf(targetId));
    await run(50);
    click(seer, /^查验$/);
    await run(300);
    // 停留在预言家阶段展示结果，其他玩家看不到任何计时
    expect(view(seer)?.phase).toBe('night-seer');
    expect(view(seer)?.seer?.lastCheck).toEqual({ targetId, team: 'wolf' });
    expect(seer.inst.getStatus().client.snapshot?.timer).toBeNull();
    await run(1000); // seerRevealMs = 1000
    expect(view(seer)?.phase).toBe('night-witch');
    // 走到第二夜预言家阶段：已查验的人不可选
    byRole('witch').inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(500);
    host.inst.actions.sendGameAction({ type: 'END_DISCUSSION' });
    await run(500);
    devices.filter((d) => view(d)?.me?.alive).forEach((d) => d.inst.actions.sendGameAction({ type: 'DAY_VOTE', targetId: null }));
    await run(500);
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: null }));
    await run(500);
    expect(view(seer)?.phase).toBe('night-seer');
    const tile = seer.inst.debug!.ui()!.pressables().find((x) => x.label.startsWith(nameOf(targetId)));
    expect(!tile || tile.disabled).toBe(true);
  });
  it('出局玩家：不可操作，只显示出局信息与公开战况；出局的房主仍可结束讨论', async () => {
    const { devices, run } = await setup(13);
    const [host] = devices as [(typeof devices)[0]];
    await Promise.all([host.inst.actions.createRoom({ password: '' }), run(200)]);
    for (const d of devices.slice(1)) d.inst.actions.searchRooms();
    await run(1200);
    for (const d of devices.slice(1)) void d.inst.actions.joinDiscovered(d.inst.getStatus().rooms[0]!.key);
    await run(1000);
    devices.slice(1).forEach((d) => d.inst.actions.setReady(true));
    await run(500);
    host.inst.actions.startMatch();
    await run(500);
    devices.forEach((d) => d.inst.actions.sendGameAction({ type: 'CONFIRM_ROLE' }));
    await run(500);
    const id = (d: (typeof devices)[0]) => d.inst.getStatus().client.playerId!;
    const role = (d: (typeof devices)[0]) => view(d)!.me!.role;
    const wolves = devices.filter((d) => role(d) === 'wolf');
    // 刀房主（房主若是狼人则自刀），女巫不救
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: id(host) }));
    await run(500);
    const seer = devices.find((d) => role(d) === 'seer')!;
    if (view(seer)?.me?.alive && view(seer)?.phase === 'night-seer') {
      seer.inst.actions.sendGameAction({ type: 'SEER_CHECK', targetId: id(devices.find((d) => d !== seer)!) });
    }
    await run(2000);
    const witch = devices.find((d) => role(d) === 'witch')!;
    witch.inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(500);
    expect(view(host)?.phase).toBe('day-discuss');
    expect(view(host)?.me?.alive).toBe(false);
    // 出局房主：没有「我的身份」或任何游戏操作，只保留主持用的「结束讨论」
    const labels = host.inst.debug!.ui()!.pressables().filter((p) => !p.disabled).map((p) => p.label);
    expect(labels).toEqual(['结束讨论，开始投票（房主）']);
    click(host, '结束讨论');
    await run(500);
    expect(view(host)?.phase).toBe('day-vote');
    // 投票阶段：出局房主没有任何可点击项；其他存活玩家可以投票
    expect(host.inst.debug!.ui()!.pressables().filter((p) => !p.disabled)).toHaveLength(0);
    expect(view(host)?.pendingAction).toBeNull();
  });
});

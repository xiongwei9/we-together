import { describe, expect, it } from 'vitest';
import { createGameInstance, type GameInstance } from '@we/game-app';
import { createManualClock, createSeededRandom, createSeededRng, createVirtualNetwork, NETWORK_PRESETS } from '@we/testing';
import { werewolfGame } from '@we/werewolf';
import type { WerewolfPlayerView } from '@we/werewolf/rules';
import { createFakePlatform, type FakePlatform } from './fake-platform';

const FAST = { nightPhaseMs: 3000, discussMs: 3000, voteMs: 3000, deadRolePhaseMs: 2000 };

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

    click(host, '创建房间');
    await run(300);
    const info = host.inst.getStatus().hostInfo!;
    expect(info.address).toBe('mem:ui-net/p1');
    expect(info.invite).toMatch(/^\d{6}$/);

    // 玩家 2 完全通过 UI 加入：地址 / 邀请码经由平台文本输入
    click(p2, '加入房间');
    await run(50);
    p2.platform.prompts.push(info.address!);
    click(p2, '房间地址');
    await run(50);
    p2.platform.prompts.push(info.invite);
    click(p2, '邀请码');
    await run(50);
    click(p2, /^连接$/);
    await run(500);
    expect(p2.inst.getStatus().client.phase).toBe('in-room');

    for (const d of devices.slice(2)) void d.inst.actions.joinRoom(info.address!, info.invite);
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
    await Promise.all([host!.inst.actions.createRoom(), run(200)]);
    const info = host!.inst.getStatus().hostInfo!;
    await Promise.all([run(50), ...devices.slice(1).map((d) => d.inst.actions.joinRoom(info.address!, info.invite))]);
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
});

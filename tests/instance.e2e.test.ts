import { describe, expect, it } from 'vitest';
import { createGameInstance, type GameInstance } from '@we/game-app';
import { createManualClock, createSeededRandom, createSeededRng, createVirtualNetwork, NETWORK_PRESETS } from '@we/testing';
import { werewolfGame } from '@we/werewolf';
import { werewolfRules, type WerewolfConfig, type WerewolfPlayerView } from '@we/werewolf/rules';
import { createFakePlatform, type FakePlatform } from './fake-platform';

const FAST: WerewolfConfig = {
  ...werewolfRules.defaultConfig,
  timers: {
    ...werewolfRules.defaultConfig.timers,
    wolfMs: 5000,
    witchMs: 5000,
    seerMs: 5000,
    seerRevealMs: 1000,
    hunterMs: 3000,
    badgeMs: 3000,
    sheriffSignupMs: 3000,
    sheriffOrderMs: 3000,
    voteMs: 5000,
    deadRoleDelayMs: { min: 1000, max: 2000 },
  },
};

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

/** 走完当天：轮到发言就结束发言，投票全部弃票，直到入夜 */
async function finishDay(devices: { inst: GameInstance }[], run: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < 40 && !view(devices[0]!)?.phase.startsWith('night'); i++) {
    for (const d of devices) {
      const v = view(d);
      if (v?.pendingAction === 'speak') d.inst.actions.sendGameAction({ type: 'END_SPEECH' });
      if (v?.pendingAction === 'vote' && !v.submitted) d.inst.actions.sendGameAction({ type: 'VOTE', targetId: null });
    }
    await run(300);
  }
}

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

    // 开房后先进入房间规则页：点击切换「警长」为首日竞选
    expect(host.inst.debug!.ui()!.texts()).toContain('房间规则');
    click(host, /^警长 /);
    await run(300);
    expect(host.inst.getStatus().client.room!.rules.find((r) => r.key === 'sheriff')?.value).toBe('on');
    click(host, '完成');
    await run(100);

    // 玩家 2 完全通过 UI 加入：无需输入地址，房间列表由局域网广播发现
    click(p2, '加入房间');
    await run(500);
    expect(p2.inst.getStatus().rooms.map((r) => r.hostName)).toEqual(['玩家1']);
    click(p2, '玩家1 的房间');
    await run(500);
    expect(p2.inst.getStatus().client.phase).toBe('in-room');
    // 加入者在大厅看到房间规则摘要
    expect(p2.inst.debug!.ui()!.texts().some((t) => t.includes('首日竞选警长'))).toBe(true);

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
    click(wa, '确认袭击');
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
  it('预言家：查验后停留展示结果，到时天亮；下一夜可以重复查验同一玩家', async () => {
    const { devices, run } = await setup(11);
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
    const byRole = (r: string) => devices.find((d) => view(d)?.me?.role === r)!;
    const seer = byRole('seer');
    const room = host.inst.getStatus().client.room!;
    const nameOf = (id: string): string => {
      const p = room.players.find((x) => x.playerId === id)!;
      return `${p.seat}号 ${p.nickname}`;
    };
    const wolves = devices.filter((d) => view(d)?.me?.role === 'wolf');
    const toSeer = async (): Promise<void> => {
      wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: null }));
      await run(500);
      byRole('witch').inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
      await run(500);
      expect(view(seer)?.phase).toBe('night-seer');
    };
    await toSeer();
    const targetId = wolves[0]!.inst.getStatus().client.playerId!;
    click(seer, nameOf(targetId));
    await run(50);
    click(seer, /^查验$/);
    await run(300);
    // 停留在预言家阶段展示结果，任何玩家都收不到计时
    expect(view(seer)?.phase).toBe('night-seer');
    expect(view(seer)?.seer?.lastCheck).toEqual({ targetId, team: 'wolf' });
    expect(seer.inst.getStatus().client.snapshot?.timer).toBeNull();
    await run(1000); // seerRevealMs = 1000
    expect(view(seer)?.phase).toBe('day-speech');
    // 白天发言有公开倒计时
    expect(seer.inst.getStatus().client.snapshot?.timer).not.toBeNull();
    await finishDay(devices, run);
    await toSeer();
    const tile = seer.inst.debug!.ui()!.pressables().find((x) => x.label.startsWith(nameOf(targetId)));
    expect(tile && !tile.disabled).toBe(true);
  });
  it('出局玩家：首夜出局可发表遗言，之后不可操作，只显示出局信息与公开战况', async () => {
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
    // 刀房主（房主若是狼人则自刀），女巫不救，预言家不查验
    devices.filter((d) => role(d) === 'wolf').forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: id(host) }));
    await run(500);
    devices.find((d) => role(d) === 'witch')!.inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(500);
    devices.find((d) => role(d) === 'seer')!.inst.actions.sendGameAction({ type: 'SEER_PASS' });
    await run(500);
    expect(view(host)?.phase).toBe('last-words');
    expect(view(host)?.me?.alive).toBe(false);
    const enabled = () => host.inst.debug!.ui()!.pressables().filter((p) => !p.disabled).map((p) => p.label);
    expect(enabled()).toContain('结束遗言');
    click(host, '结束遗言');
    await run(500);
    expect(view(host)?.phase).toBe('day-speech');
    // 遗言结束后：出局房主没有任何可点击项
    expect(enabled()).toHaveLength(0);
    expect(view(host)?.pendingAction).toBeNull();
    expect(host.inst.debug!.ui()!.texts()).toContain('你已出局');
  });
  it('神职出局后的假播报阶段：其他玩家的界面与神职在场时完全一致（闭眼等待）', async () => {
    const { devices, run } = await setup(17);
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
    const role = (d: (typeof devices)[0]) => view(d)!.me!.role;
    const id = (d: (typeof devices)[0]) => d.inst.getStatus().client.playerId!;
    const wolves = devices.filter((d) => role(d) === 'wolf');
    const seer = devices.find((d) => role(d) === 'seer')!;
    const witch = devices.find((d) => role(d) === 'witch')!;
    const others = devices.filter((d) => d !== seer);
    /** 去掉轮次后的屏幕文本，用于比较真假阶段 */
    const screen = (d: (typeof devices)[0]) => d.inst.debug!.ui()!.texts().filter((t) => !/^第 \d+ 轮/.test(t));

    // 第一夜：刀预言家；女巫不救；预言家在场，等待其查验时记录其他玩家的界面
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: id(seer) }));
    await run(500);
    witch.inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(500);
    expect(view(host)?.phase).toBe('night-seer');
    const real = new Map(others.map((d) => [d, screen(d)]));
    for (const d of others) expect(real.get(d)).toContain('天黑请闭眼');
    seer.inst.actions.sendGameAction({ type: 'SEER_CHECK', targetId: id(witch) });
    await run(1500);
    expect(view(seer)?.me?.alive).toBe(false);
    await finishDay(devices, run);

    // 第二夜：预言家已出局，进入假播报阶段
    host.platform.announcements.length = 0;
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: null }));
    await run(300);
    witch.inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(300);
    expect(view(host)?.phase).toBe('night-seer');
    expect(host.platform.announcements).toContain('女巫请闭眼。预言家请睁眼，请选择要查验的玩家。');
    for (const d of others) {
      expect(view(d)?.pendingAction).toBeNull();
      expect(d.inst.getStatus().client.snapshot?.timer).toBeNull();
      expect(screen(d)).toEqual(real.get(d));
    }
    // 随机停留结束后照常天亮
    await run(2500);
    expect(view(host)?.phase).toBe('day-speech');
    expect(host.platform.announcements).toContain('天亮了。昨晚是平安夜。');
  });
  it('狼人自爆按钮只在身份卡中：主界面没有，展开「我的身份」后两步确认自爆', async () => {
    const { devices, run } = await setup(19);
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
    const role = (d: (typeof devices)[0]) => view(d)!.me!.role;
    const wolves = devices.filter((d) => role(d) === 'wolf');
    wolves.forEach((w) => w.inst.actions.sendGameAction({ type: 'WOLF_VOTE', targetId: null }));
    await run(500);
    devices.find((d) => role(d) === 'witch')!.inst.actions.sendGameAction({ type: 'WITCH_ACTION', action: 'pass' });
    await run(500);
    devices.find((d) => role(d) === 'seer')!.inst.actions.sendGameAction({ type: 'SEER_PASS' });
    await run(500);
    expect(view(host)?.phase).toBe('day-speech');
    // 选一只当前不在发言的狼，避免与「结束发言」混淆
    const wolf = wolves.find((w) => view(w)?.pendingAction !== 'speak')!;
    const labels = (d: (typeof devices)[0]) => d.inst.debug!.ui()!.pressables().filter((p) => !p.disabled).map((p) => p.label);
    expect(view(wolf)?.canExplode).toBe(true);
    // 主界面：狼人与好人的可点击项一致，没有自爆
    const villager = devices.find((d) => role(d) === 'villager' && view(d)?.pendingAction !== 'speak')!;
    expect(labels(wolf)).toEqual(labels(villager));
    expect(labels(wolf).some((l) => l.includes('自爆'))).toBe(false);
    click(wolf, '我的身份');
    await run(50);
    expect(labels(wolf)).toContain('自爆');
    click(wolf, /^自爆$/);
    await run(50);
    click(wolf, '确认自爆');
    await run(500);
    expect(view(wolf)?.me?.alive).toBe(false);
    expect(view(host)?.phase).toBe('night-wolf');
    expect(host.platform.announcements.some((a) => a.includes('自爆，身份是狼人'))).toBe(true);
  });
  it('随机昵称：首次启动从昵称池分配并保存，可「换一个」；期望座位让实例 pN 坐 N 号', async () => {
    const clock = createManualClock(1000);
    const network = createVirtualNetwork({ networkId: 'nick-net', clock, seed: 23 });
    const run = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 16) {
        clock.advance(16);
        for (let i = 0; i < 60; i++) await Promise.resolve();
      }
    };
    const devices: { inst: GameInstance; platform: FakePlatform }[] = [];
    for (let i = 1; i <= 6; i++) {
      const platform = createFakePlatform({ clock, random: createSeededRandom(2300 + i) });
      devices.push({ inst: createGameInstance({ instanceId: `p${i}`, platform, transport: network.createTransport(`p${i}`), games: [werewolfGame], debug: true, seatHint: i }), platform });
    }
    const starting = Promise.all(devices.map((d) => d.inst.start()));
    await run(100);
    await starting;
    const nick = (d: (typeof devices)[0]): string => d.inst.debug!.ui()!.texts().find((t, i, all) => all[i - 1] === '我的昵称') ?? '';
    for (const d of devices) {
      expect(nick(d)).not.toBe('');
      expect(nick(d)).not.toBe('点击设置昵称');
      expect(await d.platform.storage.get('nickname')).toBe(nick(d));
    }
    const host = devices[0]!;
    const before = nick(host);
    click(host, '换一个');
    await run(100);
    expect(nick(host)).not.toBe(before);
    expect(await host.platform.storage.get('nickname')).toBe(nick(host));

    await Promise.all([host.inst.actions.createRoom({ password: '' }), run(200)]);
    // 倒序、并发加入：座位仍与实例编号一致
    const rest = devices.slice(1).reverse();
    for (const d of rest) d.inst.actions.searchRooms();
    await run(1200);
    for (const d of rest) void d.inst.actions.joinDiscovered(d.inst.getStatus().rooms[0]!.key);
    await run(1500);
    const room = host.inst.getStatus().client.room!;
    for (const [i, d] of devices.entries()) {
      expect(room.players.find((p) => p.playerId === d.inst.getStatus().client.playerId)?.seat).toBe(i + 1);
    }
  });
});

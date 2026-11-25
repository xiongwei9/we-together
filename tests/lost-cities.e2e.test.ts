import { describe, expect, it } from 'vitest';
import { createGameInstance, type GameInstance } from '@we/game-app';
import { lostCitiesGame } from '@we/lost-cities';
import { chooseBotAction, lostCitiesRules, type LostCitiesPlayerView, type LostCitiesState } from '@we/lost-cities/rules';
import { createHeadlessWorld, createManualClock, createSeededRandom, createSeededRng, createVirtualNetwork, NETWORK_PRESETS, type HeadlessDevice, type HeadlessWorld } from '@we/testing';
import { werewolfGame } from '@we/werewolf';
import { createFakePlatform, type FakePlatform } from './fake-platform';

// ---- VirtualNetwork 完整比赛 -----------------------------------------------------

async function setupRoom(world: HeadlessWorld): Promise<HeadlessDevice[]> {
  const devices = [await world.createDevice('p1'), await world.createDevice('p2')];
  const host = await world.createHost(devices[0]!, lostCitiesRules, { nickname: '房主' });
  const joined = devices[1]!.client.join({
    link: devices[1]!.net.remote(devices[0]!.endpoint),
    hostAddress: host.address!,
    password: '',
    nickname: '玩家2',
    gameId: lostCitiesRules.id,
  });
  await world.run(2000);
  expect(await joined).toBe(true);
  devices[1]!.client.roomCommand({ kind: 'ready', ready: true });
  await world.run(1000);
  devices[0]!.client.roomCommand({ kind: 'start' });
  await world.run(1000);
  return devices;
}

const viewOf = (d: HeadlessDevice): LostCitiesPlayerView | null => (d.client.getState().snapshot?.view as LostCitiesPlayerView) ?? null;
const hostState = (d: HeadlessDevice): LostCitiesState => d.host!.inspect().match!.state as LostCitiesState;

async function playToEnd(world: HeadlessWorld, devices: HeadlessDevice[], seed: number): Promise<void> {
  const rng = createSeededRng(seed);
  const acted = new Map<string, string>();
  for (let t = 0; t < 1_200_000 && devices[0]!.host!.inspect().room.status !== 'finished'; t += 200) {
    for (const d of devices) {
      const s = d.client.getState();
      const v = viewOf(d);
      if (!v || !s.snapshot || s.snapshot.paused) continue;
      // 同一回合打牌与抽牌共享 phaseId：按视图版本区分步骤，被拒绝或投递失败时重新行动
      const key = `${s.snapshot.phaseId}:${v.phase}:${v.pendingAction}`;
      const prev = s.commands.find((c) => c.commandId === acted.get(`${d.nodeId}:${key}`));
      if (prev && (prev.status === 'pending' || prev.status === 'ok')) continue;
      const action = chooseBotAction(v, rng);
      if (action) acted.set(`${d.nodeId}:${key}`, d.client.gameCommand(action));
    }
    await world.run(200, 20);
  }
  await world.run(2000);
}

describe('失落的城市：两台设备完整比赛（VirtualNetwork）', () => {
  it('理想网络：3 轮比赛完成，双方看到相同结果，投影不泄露对手手牌', async () => {
    const world = createHeadlessWorld({ seed: 21 });
    const devices = await setupRoom(world);
    const state = hostState(devices[0]!);
    for (const d of devices) {
      const v = viewOf(d)!;
      const me = d.client.getState().playerId!;
      const opp = state.order.find((id) => id !== me)!;
      expect(v.me?.hand).toHaveLength(8);
      expect(v.deckCount).toBe(44);
      const json = JSON.stringify(v);
      for (const c of state.players[opp]!.hand) expect(json).not.toContain(`"${c.id}"`);
      expect(json).not.toContain('"seed"');
    }
    await playToEnd(world, devices, 5);
    const s = hostState(devices[0]!);
    expect(devices[0]!.host!.inspect().room.status).toBe('finished');
    expect(s.history).toHaveLength(3);
    for (const d of devices) expect(viewOf(d)?.result).toEqual(s.result);
  });

  it('5% 丢包 + 重复 + 乱序：命令不重复生效，每轮只计分一次', async () => {
    const world = createHeadlessWorld({ seed: 22, faults: NETWORK_PRESETS.poor });
    const devices = await setupRoom(world);
    await playToEnd(world, devices, 9);
    const s = hostState(devices[0]!);
    expect(s.result).not.toBeNull();
    expect(s.history.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(s.result!.totals).toEqual(Object.fromEntries(s.order.map((id) => [id, s.history.reduce((t, r) => t + r.scores[id]!, 0)])));
  });

  it('无人操作时按回合计时自动弃牌并抽牌', async () => {
    const world = createHeadlessWorld({ seed: 23 });
    const devices = await setupRoom(world);
    const before = hostState(devices[0]!);
    await world.run(31_000, 50);
    const after = hostState(devices[0]!);
    expect(after.current).not.toBe(before.current);
    expect(after.deck).toHaveLength(43);
    expect(after.moves[0]).toMatchObject({ kind: 'discard', draw: 'deck', auto: true });
    // 回合计时公开下发
    expect(devices[1]!.client.getState().snapshot?.timer?.totalMs).toBe(30_000);
  });
});

// ---- 多游戏实例与 Canvas UI ----------------------------------------------------------

type Device = { inst: GameInstance; platform: FakePlatform };

function click(d: Device, label: string | RegExp): void {
  const items = d.inst.debug!.ui()!.pressables();
  const match = items.filter((p) => !p.disabled && (typeof label === 'string' ? p.label.includes(label) : label.test(p.label)));
  const target = match[match.length - 1];
  if (!target) throw new Error(`no pressable "${String(label)}" on ${d.inst.instanceId}: ${items.map((p) => `[${p.label}${p.disabled ? '×' : ''}]`).join(' ')}`);
  d.platform.tap(target.x + target.w / 2, target.y + target.h / 2);
}

describe('多游戏 app：app 首页选择失落的城市并通过 Canvas UI 对局', () => {
  it('app 首页选游戏、开房、发现加入、出牌抽牌、本轮结算与认输', async () => {
    const clock = createManualClock(1000);
    const network = createVirtualNetwork({ networkId: 'lc-net', clock, seed: 31 });
    const run = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 16) {
        clock.advance(16);
        for (let i = 0; i < 60; i++) await Promise.resolve();
      }
    };
    const devices: Device[] = [1, 2].map((i) => {
      const platform = createFakePlatform({ clock, random: createSeededRandom(3100 + i) });
      const inst = createGameInstance({
        instanceId: `p${i}`,
        platform,
        transport: network.createTransport(`p${i}`),
        games: [werewolfGame, lostCitiesGame],
        debug: true,
        defaultNickname: `玩家${i}`,
      });
      return { inst, platform };
    });
    const starting = Promise.all(devices.map((d) => d.inst.start()));
    await run(100);
    await starting;
    const [host, guest] = devices as [Device, Device];
    const texts = (d: Device): string[] => d.inst.debug!.ui()!.texts();
    const view = (d: Device): LostCitiesPlayerView => d.inst.getStatus().client.snapshot!.view as LostCitiesPlayerView;

    // 启动进入 app 首页：主题 + 游戏列表
    for (const d of devices) {
      expect(texts(d)).toEqual(expect.arrayContaining(['We Together', '选择游戏', '狼人杀', '失落的城市']));
      expect(d.inst.getStatus().gameId).toBeNull();
    }
    // 进入游戏首页后可以返回 app 首页
    click(host, '失落的城市');
    await run(50);
    expect(host.inst.getStatus().gameId).toBe('lost-cities');
    expect(texts(host)).toContain('创建房间');
    click(host, '全部游戏');
    await run(50);
    expect(texts(host)).toContain('选择游戏');
    click(host, '失落的城市');
    await run(50);
    host.platform.prompts.push('');
    click(host, '创建房间');
    await run(300);
    expect(host.inst.getStatus().client.room?.gameId).toBe('lost-cities');
    // 房间规则：回合时间切换为 60 秒（比赛保持标准 3 轮）
    click(host, /^回合时间 /);
    await run(300);
    expect(host.inst.getStatus().client.room!.rules.find((r) => r.key === 'turnSec')?.value).toBe('60');
    click(host, '完成');
    await run(100);

    // 加入页只列出当前游戏的房间：在狼人杀里搜不到，回到 app 首页改选失落的城市
    click(guest, '狼人杀');
    await run(50);
    click(guest, '加入房间');
    await run(1500);
    expect(guest.inst.getStatus().rooms).toEqual([]);
    click(guest, /^返回$/);
    await run(50);
    click(guest, '全部游戏');
    await run(50);
    click(guest, '失落的城市');
    await run(50);
    click(guest, '加入房间');
    await run(500);
    expect(guest.inst.getStatus().rooms.map((r) => r.gameTitle)).toEqual(['失落的城市']);
    click(guest, '玩家1 的房间');
    await run(500);
    expect(guest.inst.getStatus().client.room?.gameId).toBe('lost-cities');
    click(guest, /^准备$/);
    await run(300);
    click(host, '开始游戏');
    await run(500);
    expect(view(host).phase).toBe('play');

    // 当前玩家点选一张手牌，弃到同色弃牌堆，再点抽牌堆
    const current = [host, guest].find((d) => view(d).pendingAction === 'play')!;
    const other = current === host ? guest : host;
    expect(texts(other)).toContain('对手回合');
    // 手牌按数字显示：选一张数字在手牌中唯一的牌
    const labelOf = (c: { value: number | null }): string => (c.value === null ? '握' : String(c.value));
    const hand = view(current).me!.hand;
    const handCard = hand.find((c) => hand.filter((x) => labelOf(x) === labelOf(c)).length === 1)!;
    const label = labelOf(handCard);
    click(current, new RegExp(`^${label}$`));
    await run(50);
    click(current, '弃牌堆');
    await run(300);
    expect(view(current).pendingAction).toBe('draw');
    // 弃牌暗置：对手只看到该色弃牌堆多了一张，看不到牌面
    expect(view(other).discardCounts[handCard.color]).toBe(1);
    expect(view(other).pendingMove).toMatchObject({ kind: 'discard', color: handCard.color, card: null });
    expect(JSON.stringify(view(other))).not.toContain(`"${handCard.id}"`);
    expect(view(current).pendingMove?.card?.id).toBe(handCard.id);
    click(current, /^抽牌堆$/);
    await run(300);
    expect(view(current).me!.hand).toHaveLength(8);
    expect(view(other).pendingAction).toBe('play');
    expect(view(other).deckCount).toBe(43);

    // Bot 打完第 1 轮，停在结算页
    const rng = createSeededRng(17);
    for (let i = 0; i < 600 && view(host).phase !== 'round-end'; i++) {
      for (const d of devices) {
        const a = lostCitiesGame.bot!(view(d), rng);
        if (a && !d.inst.getStatus().client.commands.some((c) => c.status === 'pending')) d.inst.actions.sendGameAction(a);
      }
      await run(200);
    }
    expect(view(host).phase).toBe('round-end');
    for (const d of devices) {
      expect(texts(d)).toContain('第 1 轮结算');
      expect(view(d).history).toHaveLength(1);
    }
    // 双方点「开始第 2 轮」后重新发牌
    click(host, '开始第 2 轮');
    await run(300);
    expect(texts(host)).toContain('等待对手确认');
    click(guest, '开始第 2 轮');
    await run(300);
    expect(view(host).round).toBe(2);
    expect(view(host).deckCount).toBe(44);
    expect(view(guest).me!.hand).toHaveLength(8);

    // 认输：两步确认，对手获胜
    click(guest, /^认输$/);
    await run(50);
    click(guest, '确认认输');
    await run(500);
    expect(host.inst.getStatus().client.room?.status).toBe('finished');
    expect(view(host).result?.resigned).toBe(guest.inst.getStatus().client.playerId);
    expect(texts(host)).toContain('你赢了！');
    expect(texts(guest)).toContain('你输了');
    for (const d of devices) await d.inst.dispose();
    await run(3000);
    network.dispose();
    expect(clock.pending()).toBe(0);
  });
});

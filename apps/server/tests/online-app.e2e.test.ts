import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGameInstance, type GameInstance } from '@we/game-app';
import { lostCitiesGame } from '@we/lost-cities';
import type { LostCitiesPlayerView } from '@we/lost-cities/rules';
import { createRelayTransport, type RelayConnect } from '@we/multiplayer';
import type { Clock } from '@we/platform';
import { createSeededRandom, createSeededRng } from '@we/testing';
import { createFakePlatform, type FakePlatform } from '../../../tests/fake-platform';
import { buildServer } from '../src/server.js';

/** 联网需要真实 I/O：使用真实时钟 */
const clock: Clock = {
  now: () => performance.now(),
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

const nodeConnect: RelayConnect = (url, h) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => h.open();
  ws.onmessage = (ev) => h.message(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
  ws.onclose = () => h.close();
  return { send: (d) => ws.send(d), close: () => ws.close() };
};

type Device = { inst: GameInstance; platform: FakePlatform };

function click(d: Device, label: string | RegExp): void {
  const items = d.inst.debug!.ui()!.pressables();
  const match = items.filter((p) => !p.disabled && (typeof label === 'string' ? p.label.includes(label) : label.test(p.label)));
  const target = match[match.length - 1];
  if (!target) throw new Error(`no pressable "${String(label)}" on ${d.inst.instanceId}: ${items.map((p) => `[${p.label}${p.disabled ? '×' : ''}]`).join(' ')}`);
  d.platform.tap(target.x + target.w / 2, target.y + target.h / 2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 等待条件成立，再等几帧让 Canvas UI 按新状态重新布局 */
const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(10);
  }
  await sleep(50);
};

let app: FastifyInstance | null = null;
const devices: Device[] = [];

afterEach(async () => {
  for (const d of devices.splice(0)) await d.inst.dispose();
  await app?.close();
  app = null;
});

describe('app 联网模式（Web 入口：Canvas UI + 真实中继服务器）', () => {
  it('房主开房得到房间号，另一台输入房间号加入并完成一局；启动时不连接服务器', async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const url = `ws://127.0.0.1:${address.port}/relay`;
    for (const i of [1, 2]) {
      const platform = createFakePlatform({ clock, random: createSeededRandom(500 + i) });
      const inst = createGameInstance({
        instanceId: `p${i}`,
        platform,
        network: 'online',
        transport: createRelayTransport({ url, connect: nodeConnect, clock }),
        games: [lostCitiesGame],
        debug: true,
        defaultNickname: `玩家${i}`,
      });
      devices.push({ inst, platform });
    }
    await Promise.all(devices.map((d) => d.inst.start()));
    const [host, guest] = devices as [Device, Device];
    const texts = (d: Device): string[] => d.inst.debug!.ui()!.texts();
    const view = (d: Device): LostCitiesPlayerView | null => (d.inst.getStatus().client.snapshot?.view as LostCitiesPlayerView) ?? null;
    await sleep(50);
    const health = async (): Promise<{ online: number }> => (await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()) as { online: number };
    // 第一次开房 / 加入时才连接服务器
    expect((await health()).online).toBe(0);
    expect(host.inst.getStatus().network).toBe('online');

    // 房主：创建房间（不设密码）→ 大厅显示 6 位房间号
    host.platform.prompts.push('');
    click(host, '创建房间');
    await waitFor(() => host.inst.getStatus().client.phase === 'in-room');
    const info = host.inst.getStatus().hostInfo!;
    expect(info.address).toMatch(/^\d{6}$/);
    click(host, '完成');
    await sleep(50);
    expect(texts(host)).toContain(info.address!);

    // 玩家：输入房间号加入
    click(guest, '输入房间号加入');
    await sleep(50);
    expect(texts(guest)).toContain('输入房间号');
    guest.platform.prompts.push(info.address!);
    click(guest, /^房间号/);
    await sleep(50);
    click(guest, /^加入$/);
    await waitFor(() => guest.inst.getStatus().client.phase === 'in-room');
    expect(texts(guest).some((t) => t.includes(`联网房间号 ${info.address}`))).toBe(true);

    click(guest, /^准备$/);
    await waitFor(() => !!host.inst.getStatus().client.room?.players.every((p) => p.ready || p.isHost));
    await sleep(50);
    click(host, '开始游戏');
    await waitFor(() => view(host)?.phase === 'play');

    const rng = createSeededRng(9);
    await waitFor(() => {
      for (const d of devices) {
        const v = view(d);
        if (!v || d.inst.getStatus().client.commands.some((c) => c.status === 'pending')) continue;
        const a = lostCitiesGame.bot!(v, rng);
        if (a) d.inst.actions.sendGameAction(a);
      }
      return view(host)?.phase === 'round-end';
    }, 30_000);
    expect(view(guest)?.history).toHaveLength(1);
  }, 40_000);

  it('服务器不可达时照常进入 app，开房失败并提示', async () => {
    const platform = createFakePlatform({ clock, random: createSeededRandom(7) });
    const inst = createGameInstance({
      instanceId: 'p1',
      platform,
      network: 'online',
      transport: createRelayTransport({ url: 'ws://127.0.0.1:1/relay', connect: nodeConnect, clock, connectTimeoutMs: 2000 }),
      games: [lostCitiesGame],
      debug: true,
      defaultNickname: '玩家',
    });
    const d: Device = { inst, platform };
    devices.push(d);
    await inst.start();
    expect(inst.getStatus().bootError).toBeNull();
    expect(await inst.actions.createRoom({ password: '' })).toBe(false);
    expect(inst.getStatus().client.phase).toBe('idle');
    await sleep(50);
    expect(inst.debug!.ui()!.texts().some((t) => t.startsWith('无法连接联网服务器'))).toBe(true);
    // 仍可再次尝试（不会卡在 busy）
    expect(await inst.actions.createRoom({ password: '' })).toBe(false);
  }, 20_000);
});

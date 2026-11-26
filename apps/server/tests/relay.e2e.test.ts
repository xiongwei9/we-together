import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chooseBotAction, lostCitiesRules, type LostCitiesPlayerView } from '@we/lost-cities/rules';
import {
  createDeviceNet,
  createHostAuthority,
  createIdFactory,
  createPlayerClient,
  createRelayTransport,
  createReliableNode,
  defaultAddressCodec,
  type DeviceNet,
  type Endpoint,
  type HostAuthority,
  type IdFactory,
  type PlayerClient,
  type RelayConnect,
  type Transport,
} from '@we/multiplayer';
import { createMemoryStorage, type Clock, type RandomSource } from '@we/platform';
import { createSeededRandom, createSeededRng } from '@we/testing';
import { buildServer } from '../src/server.js';

const clock: Clock = {
  now: () => performance.now(),
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** Node 全局 WebSocket → RelayConnect；记录底层连接以便测试强制断线 */
function nodeConnect(sockets: WebSocket[]): RelayConnect {
  return (url, h) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    ws.onopen = () => h.open();
    ws.onmessage = (ev) => h.message(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => h.close();
    return { send: (d) => ws.send(d), close: () => ws.close() };
  };
}

interface Device {
  transport: Transport;
  endpoint: Endpoint;
  net: DeviceNet;
  ids: IdFactory;
  random: RandomSource;
  client: PlayerClient;
  host: HostAuthority | null;
  sockets: WebSocket[];
  dispose(): Promise<void>;
}

async function createDevice(url: string, seed: number): Promise<Device> {
  const sockets: WebSocket[] = [];
  const transport = createRelayTransport({ url, connect: nodeConnect(sockets), clock, retryMs: 100 });
  const endpoint = await transport.start();
  const random = createSeededRandom(seed);
  const ids = await createIdFactory(random);
  const reliable = createReliableNode({ transport, clock, nextMessageId: () => ids.next('m') });
  const net = createDeviceNet({ reliable, clock });
  const client = createPlayerClient({ net, clock, ids, storage: createMemoryStorage(), gameId: lostCitiesRules.id });
  const device: Device = {
    transport,
    endpoint,
    net,
    ids,
    random,
    client,
    host: null,
    sockets,
    async dispose() {
      device.host?.dispose();
      client.dispose();
      net.dispose();
      reliable.dispose();
      await transport.stop();
    },
  };
  return device;
}

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let app: FastifyInstance | null = null;
const devices: Device[] = [];

afterEach(async () => {
  for (const d of devices.splice(0)) await d.dispose();
  await app?.close();
  app = null;
});

async function startServer(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${address.port}/relay`;
}

describe('联网模式：经中继服务器对局', () => {
  it('房主的中继编号即房间号；另一台设备凭房间号加入并完成一局，断线重连后房间号不变', async () => {
    const url = await startServer();
    const [hostDev, guest] = [await createDevice(url, 1), await createDevice(url, 2)];
    devices.push(hostDev, guest);

    const roomCode = defaultAddressCodec.format(hostDev.endpoint);
    expect(roomCode).toMatch(/^\d{6}$/);
    const host = await createHostAuthority({
      net: hostDev.net,
      clock,
      random: hostDev.random,
      ids: hostDev.ids,
      plugin: lostCitiesRules,
      config: { ...lostCitiesRules.defaultConfig, rounds: 1 },
      address: roomCode,
      password: '',
      debug: true,
    });
    hostDev.host = host;
    expect(await hostDev.client.join({ link: hostDev.net.loopbackToHost, hostAddress: roomCode, password: '', nickname: '房主' })).toBe(true);

    // 玩家只输入房间号
    const target = defaultAddressCodec.parse(roomCode)!;
    expect(target).toEqual({ kind: 'relay', peer: roomCode });
    expect(await guest.client.join({ link: guest.net.remote(target), hostAddress: roomCode, password: '', nickname: '玩家2' })).toBe(true);
    guest.client.roomCommand({ kind: 'ready', ready: true });
    await waitFor(() => !!host.inspect().room.players.find((p) => !p.isHost)?.ready);
    hostDev.client.roomCommand({ kind: 'start' });
    await waitFor(() => host.inspect().room.status === 'playing');

    // 房主的 WebSocket 断开：中继 Transport 凭令牌重连，编号（房间号）保持不变
    const transportErrors: string[] = [];
    hostDev.transport.onError((e) => transportErrors.push(e.message));
    hostDev.sockets[0]!.close();
    await waitFor(() => hostDev.sockets.length === 2 && hostDev.sockets[1]!.readyState === WebSocket.OPEN);
    await new Promise((r) => setTimeout(r, 50));

    const rng = createSeededRng(3);
    const all = [hostDev, guest];
    const view = (d: Device): LostCitiesPlayerView | null => (d.client.getState().snapshot?.view as LostCitiesPlayerView) ?? null;
    await waitFor(() => {
      for (const d of all) {
        const v = view(d);
        const s = d.client.getState();
        if (!v || s.snapshot?.paused || s.commands.some((c) => c.status === 'pending')) continue;
        const action = chooseBotAction(v, rng);
        if (action) d.client.gameCommand(action);
      }
      return host.inspect().room.status === 'finished';
    }, 30_000);

    await waitFor(() => all.every((d) => view(d)?.result !== null));
    expect(transportErrors).toEqual([]);
    expect(view(guest)?.result).toEqual(view(hostDev)?.result);
    const health = (await (await fetch(url.replace('ws://', 'http://').replace('/relay', '/health'))).json()) as { online: number; forwarded: number };
    expect(health.online).toBe(2);
    expect(health.forwarded).toBeGreaterThan(50);
  }, 40_000);

  it('房间号不存在时加入超时失败', async () => {
    const url = await startServer();
    const guest = await createDevice(url, 3);
    devices.push(guest);
    const code = guest.endpoint.kind === 'relay' && guest.endpoint.peer === '123456' ? '654321' : '123456';
    const ok = await guest.client.join({ link: guest.net.remote({ kind: 'relay', peer: code }), hostAddress: code, password: '', nickname: '玩家' });
    expect(ok).toBe(false);
  }, 20_000);
});

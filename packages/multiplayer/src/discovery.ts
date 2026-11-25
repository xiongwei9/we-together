import type { Clock, Unsubscribe } from '@we/platform';
import type { DeviceNet } from './device-net';
import type { IdFactory } from './ids';
import { PROTOCOL_VERSION, parseHostEnvelope, type RoomAdvert } from './protocol';
import { endpointKey, type Endpoint } from './transport';

/**
 * 局域网房间发现（设计 F11）：Client 周期性广播 DISCOVER，Host 单播回复 ROOM_INFO。
 * 只有 Host 需要监听固定发现端口；回复地址取自数据报来源，而非消息自报。
 */

export interface DiscoveredRoom {
  /** endpoint + roomId，列表内唯一 */
  key: string;
  endpoint: Endpoint;
  roomId: string;
  gameId: string;
  gameTitle: string;
  hostName: string;
  players: number;
  capacity: number;
  status: RoomAdvert['status'];
  hasPassword: boolean;
  lastSeen: number;
}

export interface RoomBrowser {
  /** 开始搜索：立即广播一次，之后按间隔重复 */
  start(): void;
  stop(): void;
  readonly searching: boolean;
  rooms(): readonly DiscoveredRoom[];
  subscribe(fn: () => void): Unsubscribe;
  dispose(): void;
}

const RECENT_NONCES = 8;

export function createRoomBrowser(options: {
  net: DeviceNet;
  clock: Clock;
  ids: IdFactory;
  gameId: string;
  intervalMs?: number;
  /** 超过该时间未再收到回复的房间从列表移除 */
  ttlMs?: number;
}): RoomBrowser {
  const { net, clock, ids, gameId } = options;
  const intervalMs = options.intervalMs ?? 1000;
  const ttlMs = options.ttlMs ?? 3500;
  const rooms = new Map<string, DiscoveredRoom>();
  const nonces: string[] = [];
  const listeners = new Set<() => void>();
  let timer: Unsubscribe | null = null;
  let disposed = false;

  const notify = (): void => listeners.forEach((fn) => fn());

  const prune = (): boolean => {
    const now = clock.now();
    let changed = false;
    for (const [k, r] of rooms)
      if (now - r.lastSeen > ttlMs) {
        rooms.delete(k);
        changed = true;
      }
    return changed;
  };

  const tick = (): void => {
    timer = null;
    if (disposed) return;
    const nonce = ids.next('d');
    nonces.push(nonce);
    if (nonces.length > RECENT_NONCES) nonces.shift();
    net.broadcast({
      v: 1,
      roomId: '',
      matchId: null,
      from: '',
      to: '*',
      sessionEpoch: '',
      messageId: ids.next('c'),
      type: 'DISCOVER',
      payload: { nonce, protocol: PROTOCOL_VERSION, gameId },
    });
    if (prune()) notify();
    timer = clock.setTimeout(tick, intervalMs);
  };

  const off = net.onClientInbound((raw, from) => {
    if (disposed || !from.endpoint) return;
    const env = parseHostEnvelope(raw);
    if (!env || env.type !== 'ROOM_INFO') return;
    const a = env.payload;
    // 只接受对本机最近几次 DISCOVER 的回复
    if (!nonces.includes(a.nonce) || a.protocol !== PROTOCOL_VERSION || a.gameId !== gameId) return;
    const key = `${endpointKey(from.endpoint)}|${a.roomId}`;
    rooms.set(key, {
      key,
      endpoint: from.endpoint,
      roomId: a.roomId,
      gameId: a.gameId,
      gameTitle: a.gameTitle,
      hostName: a.hostName,
      players: a.players,
      capacity: a.capacity,
      status: a.status,
      hasPassword: a.hasPassword,
      lastSeen: clock.now(),
    });
    notify();
  });

  return {
    start() {
      if (disposed || timer) return;
      tick();
      notify();
    },
    stop() {
      timer?.();
      timer = null;
      notify();
    },
    get searching() {
      return timer !== null;
    },
    rooms: () =>
      [...rooms.values()].sort((a, b) => Number(a.status !== 'lobby') - Number(b.status !== 'lobby') || a.hostName.localeCompare(b.hostName)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      timer?.();
      timer = null;
      off();
      listeners.clear();
      rooms.clear();
    },
  };
}

import type { Clock, Unsubscribe } from '@we/platform';
import type { Endpoint, Packet, Transport } from './transport';

/**
 * 联网模式的中继 Transport：经 WebSocket 连接中继服务器（apps/server）。
 * 服务器为每条连接分配 6 位编号，只按编号转发数据包，不解析内容；房主的编号即房间号。
 * 与 UDP 相同的语义：send 只表示交给网络，丢包由可靠层重发；未连接时直接丢弃。
 *
 * 线格式（与 apps/server 一致）：
 * - 服务器 → 客户端文本帧：`{"type":"welcome","id":"123456","token":"…"}`
 * - 二进制帧：`[1 字节编号长度][编号 ASCII][数据]`；客户端发出时为目标编号，收到时为来源编号
 * - 断线重连：`<url>?id=<原编号>&token=<令牌>`，在服务器保留期内可找回原编号
 */

/** 平台注入的 WebSocket 连接（浏览器 WebSocket、wx.connectSocket 等），核心不依赖 DOM */
export interface RelaySocket {
  send(data: Uint8Array | string): void;
  close(): void;
}

interface RelaySocketHandlers {
  open(): void;
  message(data: Uint8Array | string): void;
  close(): void;
}

export type RelayConnect = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

const MAX_PEER_LENGTH = 32;

function encodeRelayFrame(peer: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + peer.length + payload.length);
  out[0] = peer.length;
  for (let i = 0; i < peer.length; i++) out[1 + i] = peer.charCodeAt(i) & 0x7f;
  out.set(payload, 1 + peer.length);
  return out;
}

function decodeRelayFrame(frame: Uint8Array): { peer: string; payload: Uint8Array } | null {
  const len = frame[0];
  if (len === undefined || len === 0 || len > MAX_PEER_LENGTH || frame.length < 1 + len) return null;
  let peer = '';
  for (let i = 0; i < len; i++) peer += String.fromCharCode(frame[1 + i]!);
  if (!/^\w+$/.test(peer)) return null;
  return { peer, payload: frame.slice(1 + len) };
}

function parseWelcome(text: string): { id: string; token: string } | null {
  try {
    const m = JSON.parse(text) as { type?: unknown; id?: unknown; token?: unknown };
    if (m.type === 'welcome' && typeof m.id === 'string' && /^\w{1,32}$/.test(m.id) && typeof m.token === 'string' && m.token.length <= 128) {
      return { id: m.id, token: m.token };
    }
  } catch {
    /* 非控制帧 */
  }
  return null;
}

export function createRelayTransport(options: {
  url: string;
  connect: RelayConnect;
  clock: Clock;
  connectTimeoutMs?: number;
  /** 断线后的重连间隔（逐次翻倍，封顶 maxRetryMs） */
  retryMs?: number;
  maxRetryMs?: number;
}): Transport {
  const { url, connect, clock } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? 8000;
  const retryMs = options.retryMs ?? 500;
  const maxRetryMs = options.maxRetryMs ?? 5000;
  const packetHandlers = new Set<(p: Packet) => void>();
  const errorHandlers = new Set<(e: Error) => void>();
  let socket: RelaySocket | null = null;
  let open = false;
  let identity: { id: string; token: string } | null = null;
  let starting: Promise<Endpoint> | null = null;
  let stopped = false;
  let retryCancel: Unsubscribe | null = null;
  let retryDelay = retryMs;

  const emitError = (e: Error): void => errorHandlers.forEach((h) => h(e));

  /** 建立一次连接；收到 welcome 后 resolve 分配到的编号 */
  const openSocket = (): Promise<{ id: string; token: string }> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const target = identity ? `${url}${url.includes('?') ? '&' : '?'}id=${encodeURIComponent(identity.id)}&token=${encodeURIComponent(identity.token)}` : url;
      const cancelTimeout = clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        s.close();
        reject(new Error('连接联网服务器超时'));
      }, connectTimeoutMs);
      const s = connect(target, {
        open: () => undefined,
        message(data) {
          if (typeof data === 'string') {
            const welcome = parseWelcome(data);
            if (welcome && !settled) {
              settled = true;
              cancelTimeout();
              socket = s;
              open = true;
              resolve(welcome);
            }
            return;
          }
          const frame = decodeRelayFrame(data);
          if (!frame || !open) return;
          const packet: Packet = { from: { kind: 'relay', peer: frame.peer }, payload: frame.payload };
          packetHandlers.forEach((h) => h(packet));
        },
        close() {
          if (!settled) {
            settled = true;
            cancelTimeout();
            reject(new Error('无法连接联网服务器'));
            return;
          }
          if (socket !== s) return;
          socket = null;
          open = false;
          scheduleReconnect();
        },
      });
    });

  const scheduleReconnect = (): void => {
    if (stopped || retryCancel) return;
    retryCancel = clock.setTimeout(() => {
      retryCancel = null;
      if (stopped) return;
      const before = identity?.id;
      openSocket().then(
        (next) => {
          retryDelay = retryMs;
          if (before && next.id !== before) emitError(new Error('联网连接已重置，房间号已变化'));
          identity = next;
        },
        () => {
          retryDelay = Math.min(retryDelay * 2, maxRetryMs);
          scheduleReconnect();
        },
      );
    }, retryDelay);
  };

  return {
    start() {
      if (starting) return starting;
      stopped = false;
      starting = openSocket().then(
        (welcome) => {
          identity = welcome;
          return { kind: 'relay', peer: welcome.id } as Endpoint;
        },
        (e: unknown) => {
          starting = null;
          throw e;
        },
      );
      return starting;
    },
    async stop() {
      stopped = true;
      starting = null;
      retryCancel?.();
      retryCancel = null;
      open = false;
      const s = socket;
      socket = null;
      s?.close();
    },
    async send(to, bytes) {
      if (to.kind !== 'relay') throw new Error('中继 Transport 只能发送到联网地址');
      // 与 UDP 相同：断线期间直接丢弃，由可靠层重发
      if (!socket || !open) return;
      socket.send(encodeRelayFrame(to.peer, bytes));
    },
    async broadcast() {
      /* 联网模式没有局域网广播；房间通过房间号加入 */
    },
    onPacket(handler) {
      packetHandlers.add(handler);
      return () => packetHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

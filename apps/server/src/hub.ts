import { randomBytes, randomInt } from 'node:crypto';

/**
 * 中继核心：为每条连接分配 6 位编号，按编号转发二进制帧，不解析数据内容。
 * 房主的编号即联网房间号。断线后编号保留 reserveMs，客户端凭令牌重连可找回原编号。
 *
 * 线格式（与 packages/multiplayer/src/relay-transport.ts 一致）：
 * - 文本帧（服务器 → 客户端）：`{"type":"welcome","id":"123456","token":"…"}`
 * - 二进制帧：`[1 字节编号长度][编号 ASCII][数据]`；客户端发出时为目标编号，转发时改写为来源编号
 */

export interface PeerSocket {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface HubOptions {
  now(): number;
  /** 断线后编号的保留时间 */
  reserveMs: number;
  maxPeers: number;
  /** 每条连接的转发速率（令牌桶） */
  ratePerSecond: number;
  rateBurst: number;
  /** 测试注入：编号与令牌生成 */
  newId?: () => string;
}

interface Peer {
  id: string;
  token: string;
  socket: PeerSocket | null;
  /** 断线时刻；在线为 null */
  leftAt: number | null;
  tokens: number;
  refilledAt: number;
}

export interface HubStats {
  online: number;
  reserved: number;
  forwarded: number;
  dropped: number;
}

export interface RelayHub {
  /** 新连接；claim 为重连时的原编号与令牌。返回 null 表示人数已满 */
  connect(socket: PeerSocket, claim?: { id: string; token: string }): { id: string; token: string } | null;
  receive(id: string, frame: Uint8Array): void;
  disconnect(id: string, socket: PeerSocket): void;
  /** 清理过期的保留编号 */
  sweep(): void;
  stats(): HubStats;
}

const ID_PATTERN = /^\d{6}$/;

const defaultId = (): string => String(randomInt(100_000, 1_000_000));

function encodeFrame(peer: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + peer.length + payload.length);
  out[0] = peer.length;
  for (let i = 0; i < peer.length; i++) out[1 + i] = peer.charCodeAt(i);
  out.set(payload, 1 + peer.length);
  return out;
}

function decodeTarget(frame: Uint8Array): { peer: string; payload: Uint8Array } | null {
  const len = frame[0];
  if (len !== 6 || frame.length <= 1 + len) return null;
  let peer = '';
  for (let i = 0; i < len; i++) peer += String.fromCharCode(frame[1 + i]!);
  return ID_PATTERN.test(peer) ? { peer, payload: frame.subarray(1 + len) } : null;
}

export function createRelayHub(options: HubOptions): RelayHub {
  const peers = new Map<string, Peer>();
  const newId = options.newId ?? defaultId;
  let forwarded = 0;
  let dropped = 0;

  const expired = (p: Peer): boolean => p.leftAt !== null && options.now() - p.leftAt > options.reserveMs;

  const allocate = (): string | null => {
    for (let i = 0; i < 50; i++) {
      const id = newId();
      const existing = peers.get(id);
      if (!existing) return id;
      if (expired(existing)) {
        peers.delete(id);
        return id;
      }
    }
    return null;
  };

  /** 令牌桶限速：超出时丢弃 */
  const allow = (p: Peer): boolean => {
    const now = options.now();
    p.tokens = Math.min(options.rateBurst, p.tokens + ((now - p.refilledAt) / 1000) * options.ratePerSecond);
    p.refilledAt = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;
    return true;
  };

  return {
    connect(socket, claim) {
      const now = options.now();
      const old = claim && ID_PATTERN.test(claim.id) ? peers.get(claim.id) : undefined;
      if (old && old.token === claim!.token && !expired(old)) {
        // 重连找回原编号；若旧连接仍挂着（半开），替换它
        const prev = old.socket;
        old.socket = socket;
        old.leftAt = null;
        if (prev && prev !== socket) prev.close(4000, 'replaced');
        socket.sendText(JSON.stringify({ type: 'welcome', id: old.id, token: old.token }));
        return { id: old.id, token: old.token };
      }
      const online = [...peers.values()].filter((p) => p.socket).length;
      if (online >= options.maxPeers) return null;
      const id = allocate();
      if (!id) return null;
      const token = randomBytes(16).toString('hex');
      peers.set(id, { id, token, socket, leftAt: null, tokens: options.rateBurst, refilledAt: now });
      socket.sendText(JSON.stringify({ type: 'welcome', id, token }));
      return { id, token };
    },
    receive(id, frame) {
      const from = peers.get(id);
      if (!from?.socket || !allow(from)) {
        dropped++;
        return;
      }
      const target = decodeTarget(frame);
      const to = target ? peers.get(target.peer) : undefined;
      // 与 UDP 相同：目标不存在或离线时静默丢弃，由可靠层重发
      if (!target || !to?.socket) {
        dropped++;
        return;
      }
      to.socket.sendBinary(encodeFrame(id, target.payload));
      forwarded++;
    },
    disconnect(id, socket) {
      const p = peers.get(id);
      if (!p || p.socket !== socket) return;
      p.socket = null;
      p.leftAt = options.now();
    },
    sweep() {
      for (const [id, p] of peers) if (expired(p)) peers.delete(id);
    },
    stats() {
      const all = [...peers.values()];
      const online = all.filter((p) => p.socket).length;
      return { online, reserved: all.length - online, forwarded, dropped };
    },
  };
}

import type { Clock, Unsubscribe } from '@we/platform';
import { utf8Decode, utf8Encode } from './codec';
import { endpointKey, type Endpoint, type Transport } from './transport';

/**
 * 可靠消息与应用层分片（设计 §8.4 / §9.1）。
 *
 * 数据报格式（大端）：
 *   [kind u8][idLen u8][messageId ascii]
 *   DATA:  [partIndex u16][partCount u16][totalLen u32][chunk...]
 *   ACK:   [partIndex u16]
 * kind: 1 = 可靠 DATA（需要 ACK），2 = ACK，3 = 不可靠 DATA（心跳等）
 */

interface ReliableConfig {
  maxDatagram: number;
  maxMessageBytes: number;
  maxReassemblyPerPeer: number;
  reassemblyTimeoutMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  maxTotalReassemblyBytes: number;
}

const DEFAULT_CONFIG: ReliableConfig = {
  maxDatagram: 1200,
  maxMessageBytes: 32 * 1024,
  maxReassemblyPerPeer: 8,
  reassemblyTimeoutMs: 5000,
  retryInitialMs: 300,
  retryMaxMs: 2000,
  maxAttempts: 5,
  maxTotalReassemblyBytes: 256 * 1024,
};

const KIND_DATA = 1;
const KIND_ACK = 2;
const KIND_DATA_UNRELIABLE = 3;
const DATA_FIXED_HEADER = 2 + 8;
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_PER_PEER = 2048;

interface SendOptions {
  reliable: boolean;
  /** 重发耗尽仍未全部确认 */
  onFailed?: () => void;
}

interface ReliableStats {
  sentDatagrams: number;
  retransmits: number;
  delivered: number;
  duplicatesDropped: number;
  invalidDropped: number;
  failedMessages: number;
  pendingParts: number;
  reassembling: number;
}

export interface ReliableNode {
  send(to: Endpoint, bytes: Uint8Array, options: SendOptions): string;
  onMessage(handler: (bytes: Uint8Array, from: Endpoint) => void): Unsubscribe;
  stats(): ReliableStats;
  dispose(): void;
}

interface DecodedDatagram {
  kind: number;
  messageId: string;
  partIndex: number;
  partCount: number;
  totalLen: number;
  chunk: Uint8Array;
}

function decodeDatagram(bytes: Uint8Array): DecodedDatagram | null {
  if (bytes.length < 2) return null;
  const kind = bytes[0]!;
  const idLen = bytes[1]!;
  if (idLen === 0 || idLen > 64 || bytes.length < 2 + idLen + 2) return null;
  const messageId = utf8Decode(bytes.subarray(2, 2 + idLen));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 2 + idLen;
  if (kind === KIND_ACK) {
    if (bytes.length !== o + 2) return null;
    return { kind, messageId, partIndex: view.getUint16(o), partCount: 0, totalLen: 0, chunk: new Uint8Array(0) };
  }
  if (kind !== KIND_DATA && kind !== KIND_DATA_UNRELIABLE) return null;
  if (bytes.length < o + 8) return null;
  const partIndex = view.getUint16(o);
  const partCount = view.getUint16(o + 2);
  const totalLen = view.getUint32(o + 4);
  o += 8;
  return { kind, messageId, partIndex, partCount, totalLen, chunk: bytes.subarray(o) };
}

function encodeHeader(kind: number, messageId: string, extra: number): { buf: Uint8Array; view: DataView; offset: number } {
  const id = utf8Encode(messageId);
  const buf = new Uint8Array(2 + id.length + extra);
  buf[0] = kind;
  buf[1] = id.length;
  buf.set(id, 2);
  return { buf, view: new DataView(buf.buffer), offset: 2 + id.length };
}

/** Inspector 用：只解析头部与消息类型，不解析私密 payload */
export function describeDatagram(bytes: Uint8Array): {
  kind: 'data' | 'ack' | 'data-unreliable' | 'invalid';
  messageId?: string;
  part?: string;
  type?: string;
} {
  const d = decodeDatagram(bytes);
  if (!d) return { kind: 'invalid' };
  if (d.kind === KIND_ACK) return { kind: 'ack', messageId: d.messageId, part: String(d.partIndex) };
  const kind = d.kind === KIND_DATA ? 'data' : 'data-unreliable';
  let type: string | undefined;
  if (d.partIndex === 0) {
    // 第一片包含 envelope 开头，`"type":"XXX"` 在 envelope 前部
    const head = utf8Decode(d.chunk.subarray(0, Math.min(d.chunk.length, 400)));
    type = /"type":"([A-Z_]+)"/.exec(head)?.[1];
  }
  return { kind, messageId: d.messageId, part: `${d.partIndex + 1}/${d.partCount}`, type };
}

export function createReliableNode(options: {
  transport: Transport;
  clock: Clock;
  nextMessageId: () => string;
  config?: Partial<ReliableConfig>;
}): ReliableNode {
  const { transport, clock, nextMessageId } = options;
  const cfg: ReliableConfig = { ...DEFAULT_CONFIG, ...options.config };
  const handlers = new Set<(bytes: Uint8Array, from: Endpoint) => void>();
  const stats: ReliableStats = {
    sentDatagrams: 0,
    retransmits: 0,
    delivered: 0,
    duplicatesDropped: 0,
    invalidDropped: 0,
    failedMessages: 0,
    pendingParts: 0,
    reassembling: 0,
  };

  interface OutMessage {
    to: Endpoint;
    remaining: Set<number>;
    failed: boolean;
    onFailed?: () => void;
    timers: Map<number, Unsubscribe>;
  }
  const outgoing = new Map<string, OutMessage>(); // key: peer|msgId

  interface Reassembly {
    parts: (Uint8Array | undefined)[];
    received: number;
    totalLen: number;
    bytes: number;
    cancelTimeout: Unsubscribe;
  }
  interface PeerIn {
    reassembly: Map<string, Reassembly>;
    delivered: Map<string, number>;
  }
  const peers = new Map<string, PeerIn>();
  let totalReassemblyBytes = 0;
  let disposed = false;

  function rawSend(to: Endpoint, bytes: Uint8Array): void {
    if (disposed) return;
    stats.sentDatagrams++;
    transport.send(to, bytes).catch(() => {
      /* 交给重发处理 */
    });
  }

  function peerIn(key: string): PeerIn {
    let p = peers.get(key);
    if (!p) {
      p = { reassembly: new Map(), delivered: new Map() };
      peers.set(key, p);
    }
    return p;
  }

  function sendAck(to: Endpoint, messageId: string, partIndex: number): void {
    const { buf, view, offset } = encodeHeader(KIND_ACK, messageId, 2);
    view.setUint16(offset, partIndex);
    rawSend(to, buf);
  }

  function send(to: Endpoint, bytes: Uint8Array, opts: SendOptions): string {
    const messageId = nextMessageId();
    if (bytes.length > cfg.maxMessageBytes) throw new Error(`message too large: ${bytes.length}`);
    const idLen = utf8Encode(messageId).length;
    const chunkSize = cfg.maxDatagram - DATA_FIXED_HEADER - idLen;
    const partCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const kind = opts.reliable ? KIND_DATA : KIND_DATA_UNRELIABLE;
    const datagrams: Uint8Array[] = [];
    for (let i = 0; i < partCount; i++) {
      const chunk = bytes.subarray(i * chunkSize, Math.min(bytes.length, (i + 1) * chunkSize));
      const { buf, view, offset } = encodeHeader(kind, messageId, 8 + chunk.length);
      view.setUint16(offset, i);
      view.setUint16(offset + 2, partCount);
      view.setUint32(offset + 4, bytes.length);
      buf.set(chunk, offset + 8);
      datagrams.push(buf);
    }
    if (!opts.reliable) {
      datagrams.forEach((d) => rawSend(to, d));
      return messageId;
    }
    const key = `${endpointKey(to)}|${messageId}`;
    const msg: OutMessage = {
      to,
      remaining: new Set(datagrams.map((_, i) => i)),
      failed: false,
      onFailed: opts.onFailed,
      timers: new Map(),
    };
    outgoing.set(key, msg);
    datagrams.forEach((d, i) => {
      stats.pendingParts++;
      let attempts = 0;
      let delay = cfg.retryInitialMs;
      const attempt = (): void => {
        if (disposed || msg.failed || !msg.remaining.has(i)) return;
        if (attempts >= cfg.maxAttempts) {
          failMessage(key, msg);
          return;
        }
        if (attempts > 0) stats.retransmits++;
        attempts++;
        rawSend(to, d);
        msg.timers.set(i, clock.setTimeout(attempt, delay));
        delay = Math.min(cfg.retryMaxMs, delay * 2);
      };
      attempt();
    });
    return messageId;
  }

  function failMessage(key: string, msg: OutMessage): void {
    msg.failed = true;
    msg.timers.forEach((cancel) => cancel());
    stats.pendingParts -= msg.remaining.size;
    msg.remaining.clear();
    outgoing.delete(key);
    stats.failedMessages++;
    msg.onFailed?.();
  }

  function handleAck(fromKey: string, d: DecodedDatagram): void {
    const key = `${fromKey}|${d.messageId}`;
    const msg = outgoing.get(key);
    if (!msg || !msg.remaining.has(d.partIndex)) return;
    msg.remaining.delete(d.partIndex);
    msg.timers.get(d.partIndex)?.();
    msg.timers.delete(d.partIndex);
    stats.pendingParts--;
    if (msg.remaining.size === 0) outgoing.delete(key);
  }

  function pruneDelivered(p: PeerIn, now: number): void {
    if (p.delivered.size < DEDUPE_MAX_PER_PEER) return;
    for (const [id, at] of p.delivered) {
      if (now - at > DEDUPE_WINDOW_MS || p.delivered.size >= DEDUPE_MAX_PER_PEER) p.delivered.delete(id);
      else break;
    }
  }

  function dropReassembly(p: PeerIn, id: string): void {
    const r = p.reassembly.get(id);
    if (!r) return;
    r.cancelTimeout();
    totalReassemblyBytes -= r.bytes;
    p.reassembly.delete(id);
    stats.reassembling--;
  }

  function deliver(bytes: Uint8Array, from: Endpoint): void {
    stats.delivered++;
    handlers.forEach((h) => h(bytes, from));
  }

  function handleData(from: Endpoint, fromKey: string, d: DecodedDatagram): void {
    const valid =
      d.partCount >= 1 &&
      d.partIndex < d.partCount &&
      d.totalLen <= cfg.maxMessageBytes &&
      d.chunk.length <= d.totalLen &&
      (d.partCount > 1 || d.chunk.length === d.totalLen);
    if (!valid) {
      stats.invalidDropped++;
      return;
    }
    const reliable = d.kind === KIND_DATA;
    const p = peerIn(fromKey);
    if (p.delivered.has(d.messageId)) {
      if (reliable) sendAck(from, d.messageId, d.partIndex);
      stats.duplicatesDropped++;
      return;
    }
    const now = clock.now();
    if (d.partCount === 1) {
      if (reliable) sendAck(from, d.messageId, 0);
      pruneDelivered(p, now);
      p.delivered.set(d.messageId, now);
      deliver(d.chunk.slice(), from);
      return;
    }
    let r = p.reassembly.get(d.messageId);
    if (!r) {
      if (p.reassembly.size >= cfg.maxReassemblyPerPeer || totalReassemblyBytes + d.totalLen > cfg.maxTotalReassemblyBytes) {
        stats.invalidDropped++;
        return; // 不 ACK：发送方会重发
      }
      const id = d.messageId;
      r = {
        parts: new Array<Uint8Array | undefined>(d.partCount),
        received: 0,
        totalLen: d.totalLen,
        bytes: d.totalLen,
        cancelTimeout: clock.setTimeout(() => dropReassembly(p, id), cfg.reassemblyTimeoutMs),
      };
      totalReassemblyBytes += d.totalLen;
      stats.reassembling++;
      p.reassembly.set(d.messageId, r);
    }
    if (r.parts.length !== d.partCount || r.totalLen !== d.totalLen) {
      stats.invalidDropped++;
      return;
    }
    if (reliable) sendAck(from, d.messageId, d.partIndex);
    if (r.parts[d.partIndex]) {
      stats.duplicatesDropped++;
      return;
    }
    r.parts[d.partIndex] = d.chunk.slice();
    r.received++;
    if (r.received < d.partCount) return;
    const sum = r.parts.reduce((n, part) => n + (part?.length ?? 0), 0);
    const parts = r.parts;
    dropReassembly(p, d.messageId);
    if (sum !== d.totalLen) {
      stats.invalidDropped++;
      return;
    }
    const full = new Uint8Array(sum);
    let o = 0;
    for (const part of parts) {
      full.set(part!, o);
      o += part!.length;
    }
    pruneDelivered(p, now);
    p.delivered.set(d.messageId, now);
    deliver(full, from);
  }

  const offPacket = transport.onPacket((packet) => {
    if (disposed) return;
    if (packet.payload.length > cfg.maxDatagram) {
      stats.invalidDropped++;
      return;
    }
    const d = decodeDatagram(packet.payload);
    if (!d) {
      stats.invalidDropped++;
      return;
    }
    const fromKey = endpointKey(packet.from);
    if (d.kind === KIND_ACK) handleAck(fromKey, d);
    else handleData(packet.from, fromKey, d);
  });

  return {
    send,
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    stats: () => ({ ...stats }),
    dispose() {
      disposed = true;
      offPacket();
      outgoing.forEach((m) => m.timers.forEach((cancel) => cancel()));
      outgoing.clear();
      peers.forEach((p) => p.reassembly.forEach((r) => r.cancelTimeout()));
      peers.clear();
      handlers.clear();
    },
  };
}

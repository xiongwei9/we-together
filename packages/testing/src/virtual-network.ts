import type { Clock, Unsubscribe } from '@we/platform';
import { describeDatagram, type Endpoint, type Packet, type Transport } from '@we/multiplayer';
import { createSeededRng } from './clock';

/**
 * VirtualNetwork（设计 §13.4）：进程内虚拟网络，只认识 endpoint、字节包、链路状态与投递时间。
 * 不认识游戏规则，也不是 Host 或共享状态 Store。
 */

type MemoryEndpoint = Extract<Endpoint, { kind: 'memory' }>;

export interface NetworkFaultConfig {
  latencyMs: { min: number; max: number };
  packetLoss: number;
  duplicateRate: number;
  reorderRate: number;
}

export const NETWORK_PRESETS: Record<string, NetworkFaultConfig> = {
  ideal: { latencyMs: { min: 1, max: 3 }, packetLoss: 0, duplicateRate: 0, reorderRate: 0 },
  wifi: { latencyMs: { min: 5, max: 30 }, packetLoss: 0.01, duplicateRate: 0.005, reorderRate: 0.02 },
  poor: { latencyMs: { min: 30, max: 150 }, packetLoss: 0.05, duplicateRate: 0.05, reorderRate: 0.1 },
  terrible: { latencyMs: { min: 80, max: 400 }, packetLoss: 0.2, duplicateRate: 0.1, reorderRate: 0.2 },
};

export interface PacketTraceEvent {
  id: number;
  time: number;
  from: string;
  to: string;
  size: number;
  status: 'queued' | 'delivered' | 'dropped' | 'duplicated';
  reason?: string;
  kind: string;
  type?: string;
  messageId?: string;
  part?: string;
}

export interface VirtualNetwork {
  readonly networkId: string;
  createTransport(nodeId: string): Transport;
  setNodeOnline(nodeId: string, online: boolean): void;
  isNodeOnline(nodeId: string): boolean;
  setGlobalFaults(config: NetworkFaultConfig): void;
  setLinkFaults(from: string, to: string, config: NetworkFaultConfig | null): void;
  subscribePackets(listener: (event: PacketTraceEvent) => void): Unsubscribe;
  stats(): { queued: number; delivered: number; dropped: number };
  dispose(): void;
}

const MAX_DATAGRAM = 1200;
const MAX_QUEUE = 20_000;
const REORDER_EXTRA_MS = 40;

export function createVirtualNetwork(options: {
  networkId: string;
  clock: Clock;
  seed: number;
  faults?: NetworkFaultConfig;
}): VirtualNetwork {
  const { networkId, clock } = options;
  const rng = createSeededRng(options.seed);
  let globalFaults: NetworkFaultConfig = options.faults ?? NETWORK_PRESETS.ideal!;
  const linkFaults = new Map<string, NetworkFaultConfig>();
  const offline = new Set<string>();
  const nodes = new Map<string, { generation: number; deliver: (p: Packet) => void }>();
  const generations = new Map<string, number>();
  const queue = new Map<number, { cancel: Unsubscribe; from: string; to: string }>();
  const listeners = new Set<(e: PacketTraceEvent) => void>();
  const counters = { queued: 0, delivered: 0, dropped: 0 };
  let traceId = 0;
  let disposed = false;

  const trace = (e: Omit<PacketTraceEvent, 'id' | 'time'>): void => {
    if (listeners.size === 0) return;
    const event = { id: ++traceId, time: clock.now(), ...e };
    listeners.forEach((l) => l(event));
  };

  const dropQueued = (nodeId: string): void => {
    for (const [id, q] of queue)
      if (q.from === nodeId || q.to === nodeId) {
        q.cancel();
        queue.delete(id);
        counters.dropped++;
      }
  };

  let queueSeq = 0;
  const schedule = (
    fromId: string,
    toId: string,
    bytes: Uint8Array,
    delay: number,
    targetGeneration: number,
    meta: ReturnType<typeof describeDatagram>,
  ): void => {
    const qid = ++queueSeq;
    const fromEndpoint: MemoryEndpoint = { kind: 'memory', networkId, nodeId: fromId };
    const cancel = clock.setTimeout(() => {
      queue.delete(qid);
      const node = nodes.get(toId);
      const base = { from: fromId, to: toId, size: bytes.length, kind: meta.kind, type: meta.type, messageId: meta.messageId, part: meta.part };
      if (!node || node.generation !== targetGeneration) {
        counters.dropped++;
        trace({ ...base, status: 'dropped', reason: 'stale-endpoint' });
        return;
      }
      if (offline.has(toId) || offline.has(fromId)) {
        counters.dropped++;
        trace({ ...base, status: 'dropped', reason: 'offline' });
        return;
      }
      counters.delivered++;
      trace({ ...base, status: 'delivered' });
      // 每次投递一个独立副本，接收方不能修改发送方缓冲区
      node.deliver({ from: fromEndpoint, payload: bytes.slice() });
    }, delay);
    queue.set(qid, { cancel, from: fromId, to: toId });
  };

  const route = (fromId: string, to: Endpoint, original: Uint8Array): void => {
    const bytes = original.slice();
    const meta = describeDatagram(bytes);
    const toId = to.kind === 'memory' ? to.nodeId : `${to.host}:${to.port}`;
    const base = { from: fromId, to: toId, size: bytes.length, kind: meta.kind, type: meta.type, messageId: meta.messageId, part: meta.part };
    const drop = (reason: string): void => {
      counters.dropped++;
      trace({ ...base, status: 'dropped', reason });
    };
    if (disposed) return;
    if (to.kind !== 'memory' || to.networkId !== networkId) return drop('wrong-network');
    if (bytes.length > MAX_DATAGRAM) return drop('too-large');
    if (offline.has(fromId) || offline.has(toId)) return drop('offline');
    const target = nodes.get(toId);
    if (!target) return drop('no-route');
    if (queue.size >= MAX_QUEUE) return drop('queue-full');
    const f = linkFaults.get(`${fromId}>${toId}`) ?? globalFaults;
    if (rng() < f.packetLoss) return drop('loss');
    const latency = (): number => f.latencyMs.min + rng() * Math.max(0, f.latencyMs.max - f.latencyMs.min);
    const reorder = (): number => (rng() < f.reorderRate ? rng() * REORDER_EXTRA_MS + f.latencyMs.max : 0);
    counters.queued++;
    trace({ ...base, status: 'queued' });
    schedule(fromId, toId, bytes, latency() + reorder(), target.generation, meta);
    if (rng() < f.duplicateRate) {
      trace({ ...base, status: 'duplicated' });
      schedule(fromId, toId, bytes, latency() + reorder(), target.generation, meta);
    }
  };

  return {
    networkId,
    createTransport(nodeId) {
      const packetHandlers = new Set<(p: Packet) => void>();
      const errorHandlers = new Set<(e: Error) => void>();
      let generation = 0;
      let started = false;
      return {
        async start() {
          if (disposed) throw new Error('network disposed');
          const existing = nodes.get(nodeId);
          if (existing && started) return { kind: 'memory', networkId, nodeId };
          if (existing) throw new Error(`node ${nodeId} already bound`);
          // 新 endpoint generation：旧实例的待投递包不会误投给新实例
          generation = (generations.get(nodeId) ?? 0) + 1;
          generations.set(nodeId, generation);
          nodes.set(nodeId, { generation, deliver: (p) => packetHandlers.forEach((h) => h(p)) });
          started = true;
          return { kind: 'memory', networkId, nodeId };
        },
        async stop() {
          if (!started) return;
          started = false;
          if (nodes.get(nodeId)?.generation === generation) nodes.delete(nodeId);
          dropQueued(nodeId);
          packetHandlers.clear();
          errorHandlers.clear();
        },
        async send(to, bytes) {
          if (!started) throw new Error('transport not started');
          route(nodeId, to, bytes);
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
    },
    setNodeOnline(nodeId, online) {
      if (online) offline.delete(nodeId);
      else {
        offline.add(nodeId);
        dropQueued(nodeId);
      }
    },
    isNodeOnline: (nodeId) => !offline.has(nodeId),
    setGlobalFaults(config) {
      globalFaults = config;
    },
    setLinkFaults(from, to, config) {
      if (config) linkFaults.set(`${from}>${to}`, config);
      else linkFaults.delete(`${from}>${to}`);
    },
    subscribePackets(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => ({ ...counters }),
    dispose() {
      disposed = true;
      queue.forEach((q) => q.cancel());
      queue.clear();
      nodes.clear();
      listeners.clear();
    },
  };
}

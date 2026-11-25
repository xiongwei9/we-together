import type { Clock, Unsubscribe } from '@we/platform';
import { decodeJson, encodeJson } from './codec';
import { isHostMessageType, type Envelope } from './protocol';
import type { ReliableNode } from './reliable';
import { endpointKey, type Endpoint } from './transport';

/** 一条逻辑链路：远端 endpoint 或本机 loopback */
export interface Link {
  readonly key: string;
  readonly endpoint: Endpoint | null;
  send(env: Envelope, options: { reliable: boolean; onFailed?: () => void }): void;
}

/**
 * 每台设备一个：在同一 socket 上区分 Host 角色与 Client 角色的入站消息。
 * Host 与本机 Client 走 loopback，仍然经过编码/解码，不共享对象引用。
 */
export interface DeviceNet {
  remote(endpoint: Endpoint): Link;
  readonly loopbackToHost: Link;
  onHostInbound(handler: (raw: unknown, reply: Link) => void): Unsubscribe;
  onClientInbound(handler: (raw: unknown, from: Link) => void): Unsubscribe;
  dispose(): void;
}

export const LOOPBACK_KEY = 'loopback';

export function createDeviceNet(options: { reliable: ReliableNode; clock: Clock }): DeviceNet {
  const { reliable, clock } = options;
  const hostHandlers = new Set<(raw: unknown, reply: Link) => void>();
  const clientHandlers = new Set<(raw: unknown, from: Link) => void>();
  const pending = new Set<Unsubscribe>();
  let disposed = false;

  const dispatch = (raw: unknown, link: Link): void => {
    if (disposed) return;
    const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
    if (isHostMessageType(type)) clientHandlers.forEach((h) => h(raw, link));
    else hostHandlers.forEach((h) => h(raw, link));
  };

  const remoteLinks = new Map<string, Link>();
  const remote = (endpoint: Endpoint): Link => {
    const key = endpointKey(endpoint);
    let link = remoteLinks.get(key);
    if (!link) {
      link = {
        key,
        endpoint,
        send(env, opts) {
          if (disposed) return;
          try {
            reliable.send(endpoint, encodeJson(env), opts);
          } catch {
            opts.onFailed?.();
          }
        },
      };
      remoteLinks.set(key, link);
    }
    return link;
  };

  const makeLoopback = (deliverTo: 'host' | 'client'): Link => ({
    key: LOOPBACK_KEY,
    endpoint: null,
    send(env) {
      if (disposed) return;
      const bytes = encodeJson(env);
      const cancel = clock.setTimeout(() => {
        pending.delete(cancel);
        const raw = decodeJson(bytes);
        if (deliverTo === 'host') hostHandlers.forEach((h) => h(raw, loopbackToClient));
        else clientHandlers.forEach((h) => h(raw, loopbackToHost));
      }, 0);
      pending.add(cancel);
    },
  });
  const loopbackToHost = makeLoopback('host');
  const loopbackToClient = makeLoopback('client');

  const off = reliable.onMessage((bytes, from) => dispatch(decodeJson(bytes), remote(from)));

  return {
    remote,
    loopbackToHost,
    onHostInbound(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    onClientInbound(handler) {
      clientHandlers.add(handler);
      return () => clientHandlers.delete(handler);
    },
    dispose() {
      disposed = true;
      off();
      pending.forEach((c) => c());
      pending.clear();
      hostHandlers.clear();
      clientHandlers.clear();
    },
  };
}

import type { Unsubscribe } from '@we/platform';

/** 物理地址（设计 §8.1）：初次 JOIN 还没有逻辑 peerId */
export type Endpoint =
  | { kind: 'udp'; host: string; port: number }
  | { kind: 'memory'; networkId: string; nodeId: string };

export interface Packet {
  from: Endpoint;
  payload: Uint8Array;
}

export interface Transport {
  start(): Promise<Endpoint>;
  stop(): Promise<void>;
  /** 成功仅表示交给平台发送，不表示对端收到 */
  send(to: Endpoint, bytes: Uint8Array): Promise<void>;
  onPacket(handler: (packet: Packet) => void): Unsubscribe;
  onError(handler: (error: Error) => void): Unsubscribe;
}

export function endpointKey(e: Endpoint): string {
  return e.kind === 'udp' ? `udp:${e.host}:${e.port}` : `mem:${e.networkId}/${e.nodeId}`;
}

export interface AddressCodec {
  format(e: Endpoint): string;
  parse(text: string): Endpoint | null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 默认地址格式：`192.168.1.10:20000` 或 `mem:<networkId>/<nodeId>` */
export const defaultAddressCodec: AddressCodec = {
  format(e) {
    return e.kind === 'udp' ? `${e.host}:${e.port}` : `mem:${e.networkId}/${e.nodeId}`;
  },
  parse(raw) {
    const text = raw.trim();
    const mem = /^mem:([\w-]+)\/([\w-]+)$/.exec(text);
    if (mem) return { kind: 'memory', networkId: mem[1]!, nodeId: mem[2]! };
    const idx = text.lastIndexOf(':');
    if (idx <= 0) return null;
    const host = text.slice(0, idx);
    const port = Number(text.slice(idx + 1));
    const m = IPV4.exec(host);
    if (!m || m.slice(1).some((p) => Number(p) > 255)) return null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { kind: 'udp', host, port };
  },
};

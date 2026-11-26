import type { Unsubscribe } from '@we/platform';

/**
 * 物理地址（设计 §8.1）：初次 JOIN 还没有逻辑 peerId。
 * relay：联网模式下中继服务器分配的 6 位编号；房主的编号即房间号
 */
export type Endpoint =
  | { kind: 'udp'; host: string; port: number }
  | { kind: 'memory'; networkId: string; nodeId: string }
  | { kind: 'relay'; peer: string };

export interface Packet {
  from: Endpoint;
  payload: Uint8Array;
}

export interface Transport {
  start(): Promise<Endpoint>;
  stop(): Promise<void>;
  /** 成功仅表示交给平台发送，不表示对端收到 */
  send(to: Endpoint, bytes: Uint8Array): Promise<void>;
  /**
   * 局域网广播到发现端口（仅用于房间发现，不可靠、不需要 ACK）。
   * 实现必须展开为逐 endpoint 投递或交给平台广播，不能共享对象引用。
   */
  broadcast(bytes: Uint8Array): Promise<void>;
  onPacket(handler: (packet: Packet) => void): Unsubscribe;
  onError(handler: (error: Error) => void): Unsubscribe;
}

export function endpointKey(e: Endpoint): string {
  if (e.kind === 'relay') return `relay:${e.peer}`;
  return e.kind === 'udp' ? `udp:${e.host}:${e.port}` : `mem:${e.networkId}/${e.nodeId}`;
}

/** 联网房间号：中继服务器分配的 6 位数字 */
export const ROOM_CODE = /^\d{6}$/;

export interface AddressCodec {
  format(e: Endpoint): string;
  parse(text: string): Endpoint | null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 默认地址格式：`192.168.1.10:20000`、`mem:<networkId>/<nodeId>`，或联网房间号 `123456` */
export const defaultAddressCodec: AddressCodec = {
  format(e) {
    if (e.kind === 'relay') return e.peer;
    return e.kind === 'udp' ? `${e.host}:${e.port}` : `mem:${e.networkId}/${e.nodeId}`;
  },
  parse(raw) {
    const text = raw.trim();
    if (ROOM_CODE.test(text)) return { kind: 'relay', peer: text };
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

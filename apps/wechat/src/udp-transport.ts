import type { Endpoint, Packet, Transport } from '@we/multiplayer';

/**
 * 微信 UDP Transport（设计 §8.1）。
 * - 每设备一个活动 socket；离开时取消订阅并 close
 * - 发送时保留 Uint8Array 的 byteOffset/length，不误发整个底层 buffer
 * - 来源端点取自 remoteInfo，而非消息内自报地址
 * - 房间发现：所有设备优先绑定固定发现端口，Client 向子网广播地址发送 DISCOVER（基础库 2.24.0+ 支持 setBroadcast）
 */
const DISCOVERY_PORT = 20000;

/** 由 IP 与子网掩码计算子网广播地址，例如 192.168.1.23/255.255.255.0 → 192.168.1.255 */
function subnetBroadcast(ip: string, mask: string): string | null {
  const a = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return a.map((n, i) => (n & m[i]!) | (~m[i]! & 255)).join('.');
}

export function createWechatUdpTransport(): Transport {
  let socket: WechatMinigame.UDPSocket | null = null;
  let local: Endpoint | null = null;
  let broadcastTargets: string[] = ['255.255.255.255'];
  const packetHandlers = new Set<(p: Packet) => void>();
  const errorHandlers = new Set<(e: Error) => void>();

  const onMessage = (res: WechatMinigame.UDPSocketOnMessageListenerResult): void => {
    const packet: Packet = {
      from: { kind: 'udp', host: res.remoteInfo.address, port: res.remoteInfo.port },
      payload: new Uint8Array(res.message.slice(0)),
    };
    packetHandlers.forEach((h) => h(packet));
  };
  const onError = (res: { errMsg: string }): void => {
    const err = new Error(res.errMsg);
    errorHandlers.forEach((h) => h(err));
  };

  const localIp = (): Promise<{ ip: string; netmask: string }> =>
    new Promise((resolve, reject) => {
      if (typeof wx.getLocalIPAddress !== 'function') {
        reject(new Error('当前基础库不支持获取局域网 IP，请手动查看手机 Wi-Fi 地址'));
        return;
      }
      wx.getLocalIPAddress({
        success: (r) => resolve({ ip: r.localip, netmask: r.netmask }),
        fail: (e) => reject(new Error(`获取局域网 IP 失败：${e.errMsg}`)),
      });
    });

  return {
    async start() {
      if (local) return local;
      if (typeof wx.createUDPSocket !== 'function') throw new Error('当前微信版本不支持 UDP（需要基础库 2.7.0+）');
      const s = wx.createUDPSocket();
      let port: number;
      try {
        port = s.bind(DISCOVERY_PORT);
      } catch {
        port = 0;
      }
      if (!port) port = s.bind();
      s.onMessage(onMessage);
      s.onError(onError);
      socket = s;
      let host = '0.0.0.0';
      try {
        const info = await localIp();
        host = info.ip;
        const subnet = subnetBroadcast(info.ip, info.netmask);
        // iOS 上受限广播 255.255.255.255 可能被丢弃，同时发送子网广播
        broadcastTargets = subnet ? [subnet, '255.255.255.255'] : ['255.255.255.255'];
      } catch (e) {
        errorHandlers.forEach((h) => h(e instanceof Error ? e : new Error(String(e))));
      }
      if (port !== DISCOVERY_PORT) {
        errorHandlers.forEach((h) => h(new Error(`发现端口 ${DISCOVERY_PORT} 被占用：作为房主时其他玩家需手动输入地址`)));
      }
      local = { kind: 'udp', host, port };
      return local;
    },
    async stop() {
      if (!socket) return;
      socket.offMessage(onMessage);
      socket.offError(onError);
      socket.close();
      socket = null;
      local = null;
    },
    async send(to, bytes) {
      if (!socket) throw new Error('socket not started');
      if (to.kind !== 'udp') throw new Error('UDP transport cannot send to memory endpoint');
      // 复制出独立 ArrayBuffer，避免发送底层共享 buffer 的多余字节
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      socket.send({ address: to.host, port: to.port, message: buffer, offset: 0, length: buffer.byteLength });
    },
    async broadcast(bytes) {
      if (!socket) throw new Error('socket not started');
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      for (const address of broadcastTargets) {
        socket.send({ address, port: DISCOVERY_PORT, message: buffer, offset: 0, length: buffer.byteLength, setBroadcast: true });
      }
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

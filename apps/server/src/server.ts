import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { createRelayHub, type PeerSocket } from './hub.js';

/** 中继服务器：GET /health 健康检查，GET /relay WebSocket 中继（联网模式） */
export interface ServerOptions {
  logger?: boolean;
  /** 断线后编号（房间号）保留时间 */
  reserveMs?: number;
  maxPeers?: number;
  ratePerSecond?: number;
  rateBurst?: number;
  /** 单帧上限：可靠层数据报 ≤ 1200 字节，留出余量 */
  maxFrameBytes?: number;
  /** 测试注入：编号生成 */
  newId?: () => string;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  // 日志中去掉查询串：重连 URL 带有令牌
  const app = Fastify({
    logger: options.logger ? { serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) } } : false,
  });
  const maxFrameBytes = options.maxFrameBytes ?? 4096;
  await app.register(websocket, { options: { maxPayload: maxFrameBytes } });

  const hub = createRelayHub({
    now: () => Date.now(),
    reserveMs: options.reserveMs ?? 60_000,
    maxPeers: options.maxPeers ?? 5_000,
    ratePerSecond: options.ratePerSecond ?? 200,
    rateBurst: options.rateBurst ?? 400,
    newId: options.newId,
  });
  const sweeper = setInterval(() => hub.sweep(), 10_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.get('/health', async () => ({ ok: true, ...hub.stats() }));

  app.get('/relay', { websocket: true }, (socket, request) => {
    const query = request.query as { id?: unknown; token?: unknown };
    const claim = typeof query.id === 'string' && typeof query.token === 'string' ? { id: query.id, token: query.token } : undefined;
    const peer: PeerSocket = {
      sendText: (text) => socket.send(text),
      sendBinary: (bytes) => socket.send(bytes),
      close: (code, reason) => socket.close(code, reason),
    };
    const assigned = hub.connect(peer, claim);
    if (!assigned) {
      socket.close(1013, 'server full');
      return;
    }
    socket.on('message', (data, isBinary) => {
      // 只转发二进制帧；客户端文本帧没有用途，忽略
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      hub.receive(assigned.id, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    socket.on('close', () => hub.disconnect(assigned.id, peer));
    socket.on('error', () => hub.disconnect(assigned.id, peer));
  });

  return app;
}

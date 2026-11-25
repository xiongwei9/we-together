/** 统一消息模型（设计 §8.3）与运行时 schema 校验 */

export const PROTOCOL_VERSION = 1;

/** 房间密码：可选的入房口令，仅做访问控制，不作为加密密钥 */
export const MAX_PASSWORD = 16;

export type RoomStatus = 'lobby' | 'playing' | 'finished' | 'closed';

export interface RoomPlayer {
  playerId: string;
  nickname: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

/** 公开房间视图：不包含凭证、地址、序列号等会话私密信息 */
export interface RoomView {
  roomId: string;
  hostId: string;
  gameId: string;
  gameTitle: string;
  rulesVersion: string;
  roomVersion: number;
  matchId: string | null;
  status: RoomStatus;
  capacity: { min: number; max: number };
  players: readonly RoomPlayer[];
}

export interface Envelope<T = unknown> {
  v: 1;
  roomId: string;
  matchId: string | null;
  from: string;
  to: string;
  sessionEpoch: string;
  messageId: string;
  type: string;
  payload: T;
}

export type RoomAction =
  | { kind: 'ready'; ready: boolean }
  | { kind: 'start' }
  | { kind: 'leave' }
  | { kind: 'back-to-lobby' }
  | { kind: 'end-match' }
  | { kind: 'resume-game' }
  | { kind: 'close-room' };

export interface PauseInfo {
  reasons: readonly ('disconnect' | 'host-hidden')[];
  disconnected: readonly string[];
}

export interface PlayerSnapshot<V = unknown> {
  matchId: string;
  version: number;
  phaseId: string;
  view: V;
  /** 计时显示：剩余毫秒（暂停时冻结）。Client 倒计时仅用于显示 */
  timer: { remainingMs: number; totalMs: number } | null;
  paused: PauseInfo | null;
}

/** 房间发现应答：只含大厅展示所需的公开信息 */
export interface RoomAdvert {
  nonce: string;
  protocol: number;
  roomId: string;
  gameId: string;
  gameTitle: string;
  hostName: string;
  players: number;
  capacity: number;
  status: RoomStatus;
  hasPassword: boolean;
}

export type ClientMessage =
  | { type: 'DISCOVER'; payload: { nonce: string; protocol: number; gameId: string } }
  | { type: 'JOIN_REQUEST'; payload: { requestId: string; protocol: number; gameId: string; password: string; nickname: string } }
  | { type: 'RESUME_REQUEST'; payload: { requestId: string; playerId: string; credential: string } }
  | { type: 'ROOM_COMMAND'; payload: { commandId: string; action: RoomAction } }
  | { type: 'GAME_COMMAND'; payload: { commandId: string; phaseId: string; expectedVersion: number; action: unknown } }
  | { type: 'SYNC_REQUEST'; payload: Record<string, never> }
  | { type: 'HEARTBEAT'; payload: { t: number } };

export type HostMessage =
  | { type: 'ROOM_INFO'; payload: RoomAdvert }
  | { type: 'JOIN_ACCEPT'; payload: { requestId: string; playerId: string; credential: string; sessionEpoch: string; room: RoomView } }
  | { type: 'JOIN_REJECT'; payload: { requestId: string; code: string } }
  | { type: 'RESUME_ACCEPT'; payload: { requestId: string; playerId: string; sessionEpoch: string; room: RoomView } }
  | { type: 'RESUME_REJECT'; payload: { requestId: string; code: string } }
  | { type: 'SESSION_REJECT'; payload: { code: string; epoch: string } }
  | { type: 'ROOM_SNAPSHOT'; payload: { room: RoomView } }
  | { type: 'COMMAND_RESULT'; payload: { commandId: string; ok: boolean; code?: string } }
  | { type: 'PLAYER_SNAPSHOT'; payload: PlayerSnapshot }
  | { type: 'PONG'; payload: { t: number } }
  | { type: 'ROOM_CLOSED'; payload: { reason: string } };

export type ClientEnvelope = Envelope & ClientMessage;
export type HostEnvelope = Envelope & HostMessage;

// ---- schema helpers -------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => isStr(v, 64) && /^[\w-]+$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function parseEnvelopeBase(raw: unknown): Envelope | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION) return null;
  if (!isStr(raw.roomId, 64) || !(raw.matchId === null || isId(raw.matchId))) return null;
  if (!isStr(raw.from, 64) || !isStr(raw.to, 64) || !isStr(raw.sessionEpoch, 64)) return null;
  if (!isId(raw.messageId) || !isStr(raw.type, 32) || !('payload' in raw)) return null;
  return raw as unknown as Envelope;
}

function parseRoomAction(a: unknown): RoomAction | null {
  if (!isObj(a) || !isStr(a.kind, 32)) return null;
  switch (a.kind) {
    case 'ready':
      return isBool(a.ready) ? { kind: 'ready', ready: a.ready } : null;
    case 'start':
    case 'leave':
    case 'back-to-lobby':
    case 'end-match':
    case 'resume-game':
    case 'close-room':
      return { kind: a.kind };
    default:
      return null;
  }
}

/** Host 端：校验来自网络的 Client 消息（不可信输入） */
export function parseClientEnvelope(raw: unknown): ClientEnvelope | null {
  const env = parseEnvelopeBase(raw);
  if (!env) return null;
  const p = env.payload;
  if (!isObj(p)) return null;
  switch (env.type) {
    case 'DISCOVER':
      return isId(p.nonce) && isNum(p.protocol) && isStr(p.gameId, 32) ? (env as ClientEnvelope) : null;
    case 'JOIN_REQUEST':
      if (isId(p.requestId) && isNum(p.protocol) && isStr(p.gameId, 32) && isStr(p.password, MAX_PASSWORD) && isStr(p.nickname, 64))
        return env as ClientEnvelope;
      return null;
    case 'RESUME_REQUEST':
      return isId(p.requestId) && isId(p.playerId) && isStr(p.credential, 128) ? (env as ClientEnvelope) : null;
    case 'ROOM_COMMAND': {
      const action = parseRoomAction(p.action);
      return isId(p.commandId) && action ? ({ ...env, payload: { commandId: p.commandId, action } } as ClientEnvelope) : null;
    }
    case 'GAME_COMMAND':
      return isId(p.commandId) && isStr(p.phaseId, 64) && isNum(p.expectedVersion) && 'action' in p
        ? (env as ClientEnvelope)
        : null;
    case 'SYNC_REQUEST':
      return env as ClientEnvelope;
    case 'HEARTBEAT':
      return isNum(p.t) ? (env as ClientEnvelope) : null;
    default:
      return null;
  }
}

function isRoomView(v: unknown): v is RoomView {
  if (!isObj(v) || !isStr(v.roomId) || !isStr(v.hostId) || !isNum(v.roomVersion) || !Array.isArray(v.players)) return false;
  return v.players.every((p) => isObj(p) && isStr(p.playerId) && isStr(p.nickname) && isNum(p.seat));
}

/** Client 端：校验来自 Host 的消息 */
export function parseHostEnvelope(raw: unknown): HostEnvelope | null {
  const env = parseEnvelopeBase(raw);
  if (!env) return null;
  const p = env.payload;
  if (!isObj(p)) return null;
  switch (env.type) {
    case 'ROOM_INFO':
      return isId(p.nonce) && isStr(p.roomId, 64) && isStr(p.gameId, 32) && isStr(p.gameTitle, 64) && isStr(p.hostName, 64) &&
        isNum(p.players) && isNum(p.capacity) && isStr(p.status, 16) && isBool(p.hasPassword)
        ? (env as HostEnvelope)
        : null;
    case 'JOIN_ACCEPT':
      return isId(p.requestId) && isId(p.playerId) && isStr(p.credential) && isStr(p.sessionEpoch) && isRoomView(p.room)
        ? (env as HostEnvelope)
        : null;
    case 'RESUME_ACCEPT':
      return isId(p.requestId) && isId(p.playerId) && isStr(p.sessionEpoch) && isRoomView(p.room) ? (env as HostEnvelope) : null;
    case 'JOIN_REJECT':
    case 'RESUME_REJECT':
      return isId(p.requestId) && isStr(p.code) ? (env as HostEnvelope) : null;
    case 'SESSION_REJECT':
      return isStr(p.code) && isStr(p.epoch) ? (env as HostEnvelope) : null;
    case 'ROOM_SNAPSHOT':
      return isRoomView(p.room) ? (env as HostEnvelope) : null;
    case 'COMMAND_RESULT':
      return isId(p.commandId) && isBool(p.ok) ? (env as HostEnvelope) : null;
    case 'PLAYER_SNAPSHOT':
      return isId(p.matchId) && isNum(p.version) && isStr(p.phaseId) && 'view' in p ? (env as HostEnvelope) : null;
    case 'PONG':
      return isNum(p.t) ? (env as HostEnvelope) : null;
    case 'ROOM_CLOSED':
      return isStr(p.reason) ? (env as HostEnvelope) : null;
    default:
      return null;
  }
}

const HOST_TYPES = new Set([
  'ROOM_INFO',
  'JOIN_ACCEPT',
  'JOIN_REJECT',
  'RESUME_ACCEPT',
  'RESUME_REJECT',
  'SESSION_REJECT',
  'ROOM_SNAPSHOT',
  'COMMAND_RESULT',
  'PLAYER_SNAPSHOT',
  'PONG',
  'ROOM_CLOSED',
]);

export function isHostMessageType(type: unknown): boolean {
  return typeof type === 'string' && HOST_TYPES.has(type);
}

/** 控制字符、零宽字符与双向控制符 */
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e]', 'g');

/** 昵称清洗：去控制字符、限长 */
export function sanitizeNickname(raw: string): string {
  const cleaned = raw.replace(UNSAFE_CHARS, '').trim();
  return Array.from(cleaned).slice(0, 12).join('');
}

/** 错误码 → 用户可读文本 */
export const ERROR_TEXT: Record<string, string> = {
  ROOM_FULL: '房间已满',
  BAD_PASSWORD: '房间密码错误',
  GAME_IN_PROGRESS: '游戏已开始，不能加入新成员',
  PROTOCOL: '版本不兼容',
  WRONG_GAME: '游戏类型不一致',
  BAD_NICKNAME: '昵称不合法',
  ROOM_CLOSED: '房间已关闭',
  BAD_CREDENTIAL: '恢复凭证无效',
  UNKNOWN_SESSION: '会话已失效，请重新加入',
  NOT_HOST: '只有房主可以操作',
  NOT_READY: '还有玩家未准备或未连接',
  BAD_PLAYER_COUNT: '玩家人数不符合要求',
  WRONG_STATUS: '当前状态不能执行此操作',
  PAUSED: '游戏已暂停',
  STALE_PHASE: '阶段已变化，请重试',
  COMMAND_ID_REUSED: '命令编号冲突',
  BAD_ACTION: '非法操作',
  DELIVERY_FAILED: '网络不可达，请重试',
  TIMEOUT: '连接超时',
};

import type { RandomSource } from '@we/platform';
import { base64url } from './codec';

export interface IdFactory {
  /** 唯一 ID：随机前缀 + 递增计数（消息、命令等高频 ID） */
  next(prefix: string): string;
  /** 高熵随机串（会话凭证等） */
  secret(byteLength?: number): Promise<string>;
}

/** 安全随机数不可用时直接抛错，绝不回退到 Math.random */
export async function createIdFactory(random: RandomSource): Promise<IdFactory> {
  const prefixBytes = await random.bytes(6);
  const base = base64url(prefixBytes).replace(/[^A-Za-z0-9]/g, 'x');
  let counter = 0;
  return {
    next(prefix) {
      counter++;
      return `${prefix}${base}${counter.toString(36)}`;
    },
    async secret(byteLength = 16) {
      return base64url(await random.bytes(byteLength));
    },
  };
}

/** 6 位数字邀请码（仅用于入房校验，不作为加密密钥） */
export async function createInviteCode(random: RandomSource): Promise<string> {
  const bytes = await random.bytes(4);
  const n = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

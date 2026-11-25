/** 纯 TS UTF-8 / base64url，避免依赖 TextEncoder（微信基础库不保证） */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    let code: number;
    if (b0 < 0x80) code = b0;
    else if (b0 >= 0xc0 && b0 < 0xe0 && i < bytes.length) code = ((b0 & 31) << 6) | (bytes[i++]! & 63);
    else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length) {
      code = ((b0 & 15) << 12) | ((bytes[i]! & 63) << 6) | (bytes[i + 1]! & 63);
      i += 2;
    } else if (b0 >= 0xf0 && i + 2 < bytes.length) {
      code = ((b0 & 7) << 18) | ((bytes[i]! & 63) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63);
      i += 3;
    } else code = 0xfffd;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else out += String.fromCharCode(code);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function encodeJson(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** 不可变深拷贝（JSON 数据） */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

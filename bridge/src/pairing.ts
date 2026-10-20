/**
 * 配对串：把 地址+端口+token 打包成一个可复制粘贴的字符串，格式 ccc1.<base64url(JSON)>。
 * 注意：这只是编码（防手抄错、一次复制），不是加密——本地配对场景不需要加密。
 * 本文件是单一来源，由 scripts/sync-protocol.mjs 同步到 bridge/src/ 与 extension/src/lib/，只改这里。
 */

/** 配对信息：h=地址 p=端口 t=token（短字段名让编码后的串更短） */
export interface PairingInfo {
  h: string;
  p: number;
  t: string;
}

/** 配对串前缀（版本号内嵌：ccc1 = 格式 v1） */
export const PAIRING_PREFIX = "ccc1.";
/** 裸 token 兼容回退时的默认地址/端口（与 bridge/src/config.ts 的 DEFAULT_PORT 保持一致） */
export const PAIRING_FALLBACK_HOST = "127.0.0.1";
export const PAIRING_FALLBACK_PORT = 19280;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * ASCII → base64url（纯 JS 实现，浏览器/Node 通用，不依赖 Buffer/atob）。
 * JSON.stringify 会把非 ASCII 转义成 \uXXXX，故输入天然只含 ASCII。
 * @param ascii 只含 ASCII 字符的字符串
 * @returns base64url（无 padding）
 */
function b64urlEncode(ascii: string): string {
  let out = "";
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : -1;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : -1;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b >= 0) out += B64_ALPHABET[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c >= 0) out += B64_ALPHABET[c & 63];
  }
  return out;
}

/**
 * base64url（无 padding）→ ASCII。
 * @param s base64url 字符串
 * @returns 解码出的 ASCII 字符串
 * @throws 含非法字符时抛错（调用方捕获）
 */
function b64urlDecode(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 4) {
    // 越界位置记 -1 作 padding；范围内的 -1 是非法字符
    const v = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64_ALPHABET.indexOf(s.charAt(i + k)) : -1)) as [number, number, number, number];
    if (v.some((x, k) => x === -1 && i + k < s.length)) throw new Error("非法 base64 字符");
    const [a, b, c, d] = v;
    out += String.fromCharCode((a << 2) | ((b < 0 ? 0 : b) >> 4));
    if (c >= 0) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (d >= 0) out += String.fromCharCode(((c & 3) << 6) | d);
  }
  return out;
}

/**
 * 生成配对串。
 * @param info 地址/端口/token
 * @returns ccc1. 开头的配对串
 */
export function encodePairing(info: PairingInfo): string {
  return PAIRING_PREFIX + b64urlEncode(JSON.stringify({ h: info.h, p: info.p, t: info.t }));
}

/**
 * 解析配对串；兼容直接粘贴裸 token（回退默认地址与端口，对齐旧版配对流程）。
 * @param raw 用户粘贴的内容（允许首尾空白）
 * @returns 配对信息；完全无法识别时返回 null
 */
export function decodePairing(raw: string): PairingInfo | null {
  const s = raw.trim();
  if (!s) return null;
  if (!s.startsWith(PAIRING_PREFIX)) {
    // 裸 token：只接受 token 形态字符（hex/字母数字），防止把整段文字误当 token
    return /^[a-zA-Z0-9_-]{8,}$/.test(s) ? { h: PAIRING_FALLBACK_HOST, p: PAIRING_FALLBACK_PORT, t: s } : null;
  }
  try {
    const obj = JSON.parse(b64urlDecode(s.slice(PAIRING_PREFIX.length))) as Partial<PairingInfo>;
    if (typeof obj.t !== "string" || !obj.t) return null;
    return {
      h: typeof obj.h === "string" && obj.h ? obj.h : PAIRING_FALLBACK_HOST,
      p: typeof obj.p === "number" && obj.p > 0 ? obj.p : PAIRING_FALLBACK_PORT,
      t: obj.t,
    };
  } catch {
    return null;
  }
}

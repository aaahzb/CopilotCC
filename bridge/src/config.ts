import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 桥接配置。token 是扩展配对的凭证；allowedOrigins 是允许握手的扩展 Origin 白名单（空数组 = 开发期不校验，仅警告） */
export interface BridgeConfig {
  token: string;
  port: number;
  allowedOrigins: string[];
  createdAt: string;
}

/**
 * 把配置写回 config.json（0600 权限）。在线改端口后持久化用。
 * @param config 完整配置对象（token/allowedOrigins/createdAt 原样保留）
 * @param dir 配置目录，默认 configDir()
 */
export function saveConfig(config: BridgeConfig, dir: string = configDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export const DEFAULT_PORT = 19280;

/**
 * 发布版扩展的固定 Origin，首次生成 config.json 时预置进白名单。
 * 由 extension/wxt.config.ts 的固定 manifest key 派生（算法：公钥 DER 的 SHA-256 前 16 字节，
 * 每半字节映射 a-p，见 scripts/gen-extension-key.mjs），所有用户装出来的扩展 ID 都是它。
 * 换 key 时必须同步改这里——bridge/tests/config.test.ts 有一致性校验把关。
 */
export const DEFAULT_EXTENSION_ORIGIN = "chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno";

/**
 * 配置目录。默认 ~/.ccc-bridge，可用 CCC_BRIDGE_HOME 环境变量覆盖（测试与 selftest 用）。
 * @returns 配置目录绝对路径
 */
export function configDir(): string {
  return process.env.CCC_BRIDGE_HOME ?? path.join(os.homedir(), ".ccc-bridge");
}

/**
 * 读取配置；不存在则生成随机 token 并落盘（0600 权限）。
 * 首次生成的白名单预置发布版扩展 Origin（DEFAULT_EXTENSION_ORIGIN），新用户零配置；
 * 已存在的配置原样读取，不擅自迁移（空数组是刻意的开发模式，放行并警告）。
 * @param dir 配置目录，默认 configDir()
 * @returns 完整配置对象
 * @throws 配置文件存在但 JSON 损坏或缺关键字段时抛错
 */
export function loadOrCreateConfig(dir: string = configDir()): BridgeConfig {
  const p = path.join(dir, "config.json");
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<BridgeConfig>;
    if (typeof parsed.token !== "string" || typeof parsed.port !== "number") {
      throw new Error(`配置文件损坏: ${p}`);
    }
    return {
      token: parsed.token,
      port: parsed.port,
      allowedOrigins: parsed.allowedOrigins ?? [],
      createdAt: parsed.createdAt ?? "",
    };
  }
  const cfg: BridgeConfig = {
    token: randomBytes(32).toString("hex"),
    port: DEFAULT_PORT,
    allowedOrigins: [DEFAULT_EXTENSION_ORIGIN], // 出厂预置：新用户免手抄扩展 Origin
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
  return cfg;
}

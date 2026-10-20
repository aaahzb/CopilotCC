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

export const DEFAULT_PORT = 19280;

/**
 * 配置目录。默认 ~/.ccc-bridge，可用 CCC_BRIDGE_HOME 环境变量覆盖（测试与 selftest 用）。
 * @returns 配置目录绝对路径
 */
export function configDir(): string {
  return process.env.CCC_BRIDGE_HOME ?? path.join(os.homedir(), ".ccc-bridge");
}

/**
 * 读取配置；不存在则生成随机 token 并落盘（0600 权限）。
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
    allowedOrigins: [],
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
  return cfg;
}

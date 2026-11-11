import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalHookTransport } from "./terminal-hooks";

const execFileAsync = promisify(execFile);

/**
 * 只执行 CLI --version，不启动聊天或访问 API。
 * @param cliPath 服务端解析出的 Claude 可执行文件
 * @returns 首个 semver；超时、失败或无法识别时返回 unknown
 */
export async function probeCliVersion(cliPath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ["--version"], {
      timeout: 3000,
      maxBuffer: 4096,
      windowsHide: true,
      env: process.env,
    });
    return /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 只启用真实探针已验证的 command Hook；版本号不能证明 HTTP Hook 实际可用。
 * @param _version CLI 版本字符串，保留给后续经过真实探针验证的能力选择
 * @returns 当前固定使用本地 command helper
 */
export function selectHookTransport(_version: string): TerminalHookTransport {
  // 2.1.316 的 HTTP 探针在本机超时，command 对照探针成功；不能按文档或 semver 猜测能力。
  return "command";
}

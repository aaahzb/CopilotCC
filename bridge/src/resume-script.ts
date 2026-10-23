/**
 * 别名续聊脚本：在别名文件夹生成「继续聊天-<别名>.sh」，终端里 bash 一下即 cd 到该文件夹
 * 并 claude --resume 当前会话。桥接在绑定/会话演进/回答完成时自动重写保鲜；
 * 删除别名、别名改名或换文件夹时删除旧脚本（仅认本工具生成的标记，防误删用户同名文件）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 脚本内容里的生成标记（删除前校验用，与用户手写文件区分） */
export const RESUME_SCRIPT_MARKER = "CopilotCC 生成";

/**
 * 清洗别名得到脚本文件名：Windows 非法字符 <>:"/\|?* 与控制字符 → "-"，首尾空白/点裁掉，
 * 空名回退「未命名」，别名部分上限 60 字符（留足 .sh 与路径长度余量）。
 * @param aliasName 别名
 * @returns 文件名（不含目录）
 */
export function resumeScriptName(aliasName: string): string {
  const clean = aliasName
    .replace(/[<>:"/\|?*\x00-\x1f]/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 60);
  return `继续聊天-${clean || "未命名"}.sh`;
}

/**
 * 生成脚本内容。无会话时输出提示并 exit 1（用户跑脚本能看到原因，不会神秘失败）。
 * @param aliasName 别名（写进注释与提示，用户看得懂这是哪个别名的脚本）
 * @param sessionId 要续的会话；null = 尚无会话
 * @returns bash 脚本全文
 */
export function resumeScriptContent(aliasName: string, sessionId: string | null): string {
  const head = [
    "#!/usr/bin/env bash",
    `# ${RESUME_SCRIPT_MARKER}：别名「${aliasName}」的终端续聊脚本（会话切换时由桥接自动更新；删别名自动删除）`,
    'cd "$(dirname "$0")" || exit 1',
    "",
  ].join("\n");
  if (!sessionId) {
    return `${head}echo "别名「${aliasName}」还没有会话记录：先在扩展里聊一句，脚本会自动更新为续聊命令"\nexit 1\n`;
  }
  return `${head}exec claude --resume "${sessionId}"\n`;
}

/**
 * 写入续聊脚本（内容不变则跳过，避免无谓写盘与 mtime 抖动）；尽力 chmod 0755。
 * @param folder 别名文件夹
 * @param aliasName 别名
 * @param sessionId 当前会话 ID（可为 null）
 * @returns 脚本文件名；写失败（文件夹不存在/无权限等）返回 null
 */
export function writeResumeScript(folder: string, aliasName: string, sessionId: string | null): string | null {
  try {
    const name = resumeScriptName(aliasName);
    const file = path.join(folder, name);
    const content = resumeScriptContent(aliasName, sessionId);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) return name; // 幂等
    fs.writeFileSync(file, content, "utf-8");
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* Windows 无 chmod 语义，忽略 */
    }
    return name;
  } catch {
    return null;
  }
}

/**
 * 删除续聊脚本；仅当文件含生成标记才动手（用户同名手写文件不受影响）。
 * @param folder 别名文件夹
 * @param aliasName 别名
 * @returns 是否实际删除
 */
export function removeResumeScript(folder: string, aliasName: string): boolean {
  try {
    const file = path.join(folder, resumeScriptName(aliasName));
    if (!fs.existsSync(file)) return false;
    if (!fs.readFileSync(file, "utf-8").includes(RESUME_SCRIPT_MARKER)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

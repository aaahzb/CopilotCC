/**
 * 别名续聊脚本：在别名文件夹成对生成「继续聊天-<别名>.sh」（Git Bash/macOS/Linux 终端）
 * 与「继续聊天-<别名>.bat」（Windows：PowerShell/cmd 里直接运行或双击）。成对写是因为
 * 别名文件夹可能走网盘同步到另一平台的机器。桥接在绑定/会话演进/回答完成时自动重写保鲜；
 * 删除别名、别名改名或换文件夹时删除旧脚本（仅认本工具生成的标记，防误删用户同名文件）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 脚本内容里的生成标记（删除前校验用，与用户手写文件区分） */
export const RESUME_SCRIPT_MARKER = "CopilotCC 生成";

/**
 * 清洗别名得到脚本文件名主干：Windows 非法字符 <>:"/\|?* 与控制字符 → "-"，首尾空白/点裁掉，
 * 空名回退「未命名」，别名部分上限 60 字符（留足扩展名与路径长度余量）。
 * @param aliasName 别名
 * @returns 文件名主干（不含目录与扩展名）
 */
export function resumeScriptStem(aliasName: string): string {
  const clean = aliasName
    .replace(/[<>:"/\|?*\x00-\x1f]/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 60);
  return `继续聊天-${clean || "未命名"}`;
}

/**
 * bash 脚本文件名（.sh）。
 * @param aliasName 别名
 * @returns 文件名（不含目录）
 */
export function resumeScriptName(aliasName: string): string {
  return `${resumeScriptStem(aliasName)}.sh`;
}

/**
 * Windows 批处理文件名（.bat）：PowerShell/cmd 都能直接运行，双击也行。
 * @param aliasName 别名
 * @returns 文件名（不含目录）
 */
export function resumeScriptBatName(aliasName: string): string {
  return `${resumeScriptStem(aliasName)}.bat`;
}

/**
 * 生成 bash 脚本内容。无会话时输出提示并 exit 1（用户跑脚本能看到原因，不会神秘失败）。
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
 * 生成 Windows 批处理内容：CRLF 行尾（cmd 惯例），chcp 65001 让中文提示在 GBK 控制台不乱码。
 * 无会话时提示并 exit /b 1（/b = 只退脚本，不关用户的终端窗口）。
 * @param aliasName 别名
 * @param sessionId 要续的会话；null = 尚无会话
 * @returns bat 脚本全文
 */
export function resumeScriptBatContent(aliasName: string, sessionId: string | null): string {
  const head = [
    "@echo off",
    "chcp 65001 >nul",
    `rem ${RESUME_SCRIPT_MARKER}：别名「${aliasName}」的终端续聊脚本（会话切换时由桥接自动更新；删别名自动删除）`,
    'cd /d "%~dp0"',
    "",
  ].join("\r\n");
  if (!sessionId) {
    return `${head}echo 别名「${aliasName}」还没有会话记录：先在扩展里聊一句，脚本会自动更新为续聊命令\r\nexit /b 1\r\n`;
  }
  return `${head}claude --resume "${sessionId}"\r\n`;
}

/**
 * 内容有变化才写盘（幂等）：避免无谓写盘与 mtime 抖动。
 * @param file 目标文件
 * @param content 期望内容
 */
function writeIfChanged(file: string, content: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) return;
  fs.writeFileSync(file, content, "utf-8");
}

/**
 * 成对写入续聊脚本（.sh + .bat，内容不变各自跳过）；.sh 尽力 chmod 0755。
 * @param folder 别名文件夹
 * @param aliasName 别名
 * @param sessionId 当前会话 ID（可为 null）
 * @returns 当前平台可直接运行的脚本文件名（win32 给 .bat，其余给 .sh；仅用于界面提示）；写失败返回 null
 */
export function writeResumeScript(folder: string, aliasName: string, sessionId: string | null): string | null {
  try {
    const shName = resumeScriptName(aliasName);
    const batName = resumeScriptBatName(aliasName);
    writeIfChanged(path.join(folder, shName), resumeScriptContent(aliasName, sessionId));
    writeIfChanged(path.join(folder, batName), resumeScriptBatContent(aliasName, sessionId));
    try {
      fs.chmodSync(path.join(folder, shName), 0o755);
    } catch {
      /* Windows 无 chmod 语义，忽略 */
    }
    return process.platform === "win32" ? batName : shName;
  } catch {
    return null;
  }
}

/**
 * 删除续聊脚本（.sh 与 .bat 都试）；仅当文件含生成标记才动手（用户同名手写文件不受影响）。
 * @param folder 别名文件夹
 * @param aliasName 别名
 * @returns 是否实际删掉了至少一个
 */
export function removeResumeScript(folder: string, aliasName: string): boolean {
  let removed = false;
  for (const name of [resumeScriptName(aliasName), resumeScriptBatName(aliasName)]) {
    try {
      const file = path.join(folder, name);
      if (!fs.existsSync(file)) continue;
      if (!fs.readFileSync(file, "utf-8").includes(RESUME_SCRIPT_MARKER)) continue;
      fs.unlinkSync(file);
      removed = true;
    } catch {
      /* 尽力删除，单个失败不影响另一个 */
    }
  }
  return removed;
}

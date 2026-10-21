/**
 * 上传文件说明块模板（单一来源）。修改本文件后运行 scripts/sync-protocol.mjs 同步到两端。
 * 扩展用它拼展示口径（预期路径），桥接用它拼实际发送口径（落盘后的真实路径），
 * 重名加 -1 后缀时两边略有差异，以桥接实际发送为准。
 */

/** 上传文件的保存目录名（绑定文件夹根目录下） */
export const UPLOAD_DIR = "copilotUploads";

/**
 * 组装 [上传文件] 说明块，注入用户消息头部；Claude 据此用 Read 工具查看文件。
 * @param paths 已保存文件的绝对路径列表
 * @returns 说明块文本（以 [上传文件] 标记开头，转录回放靠它识别 upload 附带标记）
 */
export function composeUploadNote(paths: string[]): string {
  return `[上传文件] 用户上传了 ${paths.length} 个文件，已保存到当前工作目录下的 ${UPLOAD_DIR} 目录，需要用 Read 工具查看：\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/** 单文件大小上限（字节）：与桥接 MAX_UPLOAD_BYTES 一致 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** 单次最多上传文件数：与协议 MAX_UPLOAD_FILES 一致 */
export const MAX_FILES = 10;
/** 单次总大小上限（字节）：与协议 MAX_UPLOAD_TOTAL_B64（≈45MB 二进制）一致 */
export const MAX_TOTAL_BYTES = 45 * 1024 * 1024;

/** 待上传文件项（协议 chat.send.uploads 的元素） */
export interface PendingUpload {
  name: string;
  dataB64: string;
}

/**
 * 人性化文件大小。
 * @param n 字节数
 * @returns 如 "512 B" / "2.0 KB" / "5.0 MB"
 */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 校验待上传清单（协议防线之前的友好拦截，错误信息给人看）。
 * @param files 合并后的完整待上传列表（已有 + 新加）
 * @returns 错误信息；合法返回 null
 */
export function validateFiles(files: Array<{ name: string; size: number }>): string | null {
  if (files.length > MAX_FILES) return `一次最多上传 ${MAX_FILES} 个文件`;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) return `文件 ${f.name} 超过单文件 ${formatSize(MAX_FILE_BYTES)} 上限`;
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return `文件总大小超过 ${formatSize(MAX_TOTAL_BYTES)} 上限`;
  return null;
}

/**
 * FileReader 读文件为 base64（剥掉 data:...;base64, 前缀）。
 * @param file 浏览器 File 对象
 * @returns base64 内容
 * @throws 读取失败时 reject
 */
export function readFileB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    r.readAsDataURL(file);
  });
}

/**
 * 批量读文件为协议上传项。
 * @param files 浏览器 File 列表
 * @returns PendingUpload 数组（顺序与输入一致）
 */
export async function readFilesAsUploads(files: File[]): Promise<PendingUpload[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, dataB64: await readFileB64(f) })));
}

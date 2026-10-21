import * as fs from "node:fs";
import * as path from "node:path";
import { UPLOAD_DIR } from "./upload-note";

/** 单文件大小上限（字节）：与协议 MAX_UPLOAD_B64_CHARS（≈30MB 二进制）对应 */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/** 落盘结果：成功与失败分开，单个失败不影响其他文件 */
export interface SaveUploadsResult {
  /** name=清洗后的文件名，path=落盘绝对路径（重名已加 -1 后缀） */
  saved: Array<{ name: string; path: string }>;
  failed: Array<{ name: string; reason: string }>;
}

/** 严格 base64 字符集校验：node 解码器宽容，垃圾输入会静默解出脏数据，先拒掉 */
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 清洗上传文件名：basename 去路径穿越，剥控制字符与换行（说明块按行排版，防排版注入），限长。
 * @param name 客户端上报的文件名（不可信）
 * @returns 可用文件名；非法（空/纯点）返回 null
 */
export function sanitizeUploadName(name: string): string | null {
  // 不用 path.basename：POSIX 实现不认反斜杠，Windows 风格穿越名（..\..\evil.txt）在 macOS 上会整串漏过
  // （CI macos-latest 抓到的真实失败）；按正反斜杠切分，两端平台行为一致
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f]/g, "").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 100);
}

/**
 * 把上传文件落盘到 <folder>/copilotUploads/（目录不存在自动创建；重名加 -1/-2 后缀保留扩展名）。
 * @param folder 绑定文件夹绝对路径
 * @param uploads 待保存文件（协议层已校验数量/单文件/总量上限）
 * @returns 成功与失败清单
 */
export function saveUploads(folder: string, uploads: Array<{ name: string; dataB64: string }>): SaveUploadsResult {
  const dir = path.join(folder, UPLOAD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const out: SaveUploadsResult = { saved: [], failed: [] };
  for (const u of uploads) {
    const name = sanitizeUploadName(u.name);
    if (!name) {
      out.failed.push({ name: u.name, reason: "文件名非法" });
      continue;
    }
    if (!B64_RE.test(u.dataB64) || u.dataB64.length % 4 !== 0) {
      out.failed.push({ name, reason: "数据编码损坏" });
      continue;
    }
    const buf = Buffer.from(u.dataB64, "base64");
    if (buf.length === 0) {
      out.failed.push({ name, reason: "空文件" });
      continue;
    }
    if (buf.length > MAX_UPLOAD_BYTES) {
      out.failed.push({ name, reason: "超过 30MB 上限" });
      continue;
    }
    // 重名不覆盖：同一会话的历史引用仍指向旧文件内容
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
    const target = path.join(dir, candidate);
    fs.writeFileSync(target, buf);
    out.saved.push({ name, path: target });
  }
  return out;
}

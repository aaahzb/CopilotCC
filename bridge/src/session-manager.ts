import * as fs from "node:fs";
import * as path from "node:path";

/** 会话映射记录 */
export interface SessionRecord {
  sessionId: string;
  title: string;
  updatedAt: string;
}

/**
 * 规范化文件夹路径作为映射键：解析为绝对路径，Windows（NTFS 不区分大小写）整体小写。
 * @param p 用户输入路径
 * @returns 规范化后的键
 */
export function normalizeFolder(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * 校验路径是存在的目录。
 * @param p 路径
 * @returns 存在且为目录返回 true
 */
export function isValidFolder(p: string): boolean {
  try {
    return fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 文件夹 → sessionId 映射，JSON 文件持久化 */
export class SessionManager {
  private map: Record<string, SessionRecord> = {};

  /**
   * @param filePath 映射文件路径（如 ~/.ccc-bridge/sessions.json）
   */
  constructor(private readonly filePath: string) {}

  /**
   * 从磁盘加载。文件不存在视为空映射，不抛错。
   * @throws 文件存在但 JSON 损坏时抛错
   */
  load(): void {
    if (fs.existsSync(this.filePath)) {
      this.map = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    }
  }

  /**
   * 查询文件夹的会话记录。
   * @param folder 文件夹路径
   * @returns 记录或 undefined
   */
  get(folder: string): SessionRecord | undefined {
    return this.map[normalizeFolder(folder)];
  }

  /**
   * 写入记录并立即落盘。
   * @param folder 文件夹路径
   * @param rec 会话记录
   */
  set(folder: string, rec: SessionRecord): void {
    this.map[normalizeFolder(folder)] = rec;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.map, null, 2), "utf-8");
  }

  /**
   * 删除文件夹的映射记录并落盘（新建会话/删除当前会话时用）。
   * @param folder 文件夹路径
   */
  delete(folder: string): void {
    delete this.map[normalizeFolder(folder)];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.map, null, 2), "utf-8");
  }
}

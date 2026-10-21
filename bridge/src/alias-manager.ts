import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeFolder } from "./session-manager";

/** 别名记录：文件夹+会话组合的命名快捷方式 */
export interface AliasRecord {
  id: string;
  name: string;
  folder: string;
  /** 绑定的会话 ID；null = 选中别名时在该文件夹开新会话 */
  sessionId: string | null;
  createdAt: string;
}

/** 别名列表，JSON 文件持久化（~/.ccc-bridge/aliases.json） */
export class AliasManager {
  private list: AliasRecord[] = [];

  /**
   * @param filePath 持久化文件路径（如 ~/.ccc-bridge/aliases.json）
   */
  constructor(private readonly filePath: string) {}

  /**
   * 从磁盘加载。文件不存在视为空列表，不抛错。
   * @throws 文件存在但 JSON 损坏时抛错
   */
  load(): void {
    if (fs.existsSync(this.filePath)) {
      this.list = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as AliasRecord[];
    }
  }

  /**
   * 全部别名（创建顺序）。
   * @returns 别名数组副本
   */
  all(): AliasRecord[] {
    return [...this.list];
  }

  /**
   * 按 ID 查别名。
   * @param id 别名 ID
   * @returns 记录或 undefined
   */
  get(id: string): AliasRecord | undefined {
    return this.list.find((a) => a.id === id);
  }

  /**
   * 按绑定状态匹配别名：文件夹规范化相等（Windows 不区分大小写）且 sessionId 一致。
   * @param folder 文件夹路径
   * @param sessionId 当前会话 ID（无会话传 null）
   * @returns 匹配到的别名或 undefined
   */
  findByState(folder: string, sessionId: string | null): AliasRecord | undefined {
    const key = normalizeFolder(folder);
    return this.list.find((a) => normalizeFolder(a.folder) === key && a.sessionId === sessionId);
  }

  /**
   * 创建别名并落盘。
   * @param name 用户起的别名（首尾空白会被裁掉）
   * @param folder 绑定文件夹
   * @param sessionId 绑定会话 ID；null = 选中时开新会话
   * @returns 新记录（id 为随机 16 位 hex）
   */
  create(name: string, folder: string, sessionId: string | null): AliasRecord {
    const rec: AliasRecord = {
      id: randomBytes(8).toString("hex"),
      name: name.trim(),
      folder,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    this.list.push(rec);
    this.save();
    return rec;
  }

  /**
   * 更新别名字段并落盘；未提供的字段保持原值。
   * @param id 别名 ID
   * @param patch 要改的字段；sessionId 可显式传 null（改为"新会话"）
   * @returns 更新后的记录；ID 不存在返回 undefined
   */
  update(id: string, patch: Partial<Pick<AliasRecord, "name" | "folder" | "sessionId">>): AliasRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    if (patch.name !== undefined) rec.name = patch.name.trim();
    if (patch.folder !== undefined) rec.folder = patch.folder;
    if (patch.sessionId !== undefined) rec.sessionId = patch.sessionId;
    this.save();
    return rec;
  }

  /**
   * 删除别名并落盘（只删别名映射，不动会话与转录）。
   * @param id 别名 ID
   * @returns 是否确有删除
   */
  delete(id: string): boolean {
    const n = this.list.length;
    this.list = this.list.filter((a) => a.id !== id);
    if (this.list.length !== n) this.save();
    return this.list.length !== n;
  }

  /** 落盘（目录不存在时先建） */
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.list, null, 2), "utf-8");
  }
}

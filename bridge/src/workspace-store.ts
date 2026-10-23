/**
 * 工作区绑定持久化：桥接重启（升级/崩溃/关机）后，首个视图接入时按 workspace.json
 * 恢复上次的 文件夹+别名——镜像架构下"关掉重开啥都在"的底座。best-effort：文件
 * 缺失/损坏一律当无绑定（扩展侧 lastFolder 回绑兜底），绝不让桥接起不来。
 */
import * as fs from "node:fs";

/** 持久化的工作区绑定 */
export interface WorkspaceBinding {
  /** 上次绑定的文件夹（null = 未绑定过） */
  folder: string | null;
  /** 上次进行中的别名 ID（null = 无别名） */
  aliasId: string | null;
}

/** 工作区绑定存储，JSON 文件持久化（~/.ccc-bridge/workspace.json） */
export class WorkspaceStore {
  /**
   * @param filePath 绑定文件路径（如 ~/.ccc-bridge/workspace.json）
   */
  constructor(private readonly filePath: string) {}

  /**
   * 读取绑定。文件不存在、JSON 损坏或形态不对都返回 null（恢复是 best-effort，不抛错）。
   * @returns 绑定或 null
   */
  load(): WorkspaceBinding | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<WorkspaceBinding>;
      if (typeof raw.folder !== "string" || raw.folder === "") return null;
      return { folder: raw.folder, aliasId: typeof raw.aliasId === "string" && raw.aliasId ? raw.aliasId : null };
    } catch {
      return null;
    }
  }

  /**
   * 保存绑定（覆盖写）。写失败静默——下次绑定/别名操作还会再写，不扰主流程。
   * @param b 当前工作区绑定
   */
  save(b: WorkspaceBinding): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(b, null, 2), "utf-8");
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }
}

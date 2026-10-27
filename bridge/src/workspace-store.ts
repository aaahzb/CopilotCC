/** 工作区绑定与执行设置持久化；best-effort，文件缺失或损坏不阻断桥接启动。 */
import * as fs from "node:fs";
import { isEffortLevel, isPermissionMode, type EffortLevelSetting, type PermissionModeSetting } from "./protocol";

/** fast off 的恢复基线；actualModel 仅供 request=null 的自动档使用 */
export interface FastRestoreBaseline {
  /** 开启前的模型请求；null=自动档 */
  request: string | null;
  /** CC 在提升前解析出的完整实际模型 ID；未公开元数据不可用时可缺失 */
  actualModel?: string;
}

/** 桥接权威执行设置；存在本字段即表示自动 hello 播种已完成 */
export interface WorkspaceExecutionSettings {
  permissionMode: PermissionModeSetting;
  model?: string;
  effort?: EffortLevelSetting;
  fastMode: boolean;
  /** 仅桥接与磁盘使用，不进入 WS 协议 */
  fastRestore?: FastRestoreBaseline;
}

/** 判断持久化模型字段是否为可用的非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 持久化的工作区绑定与可选执行设置 */
export interface WorkspaceBinding {
  folder: string | null;
  aliasId: string | null;
  execution?: WorkspaceExecutionSettings;
}

/** 工作区 JSON 存储（通常为 ~/.ccc-bridge/workspace.json） */
export class WorkspaceStore {
  /** @param filePath 工作区持久化文件完整路径 */
  constructor(private readonly filePath: string) {}

  /** @returns 可部分读取的原始字段；文件缺失或损坏时为空对象 */
  private readRaw(): Partial<WorkspaceBinding> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<WorkspaceBinding> : {};
    } catch {
      return {};
    }
  }

  /** @param value 要写入的完整合并结果 @returns 无；写失败静默 */
  private write(value: Partial<WorkspaceBinding>): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2), "utf-8");
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }

  /** @returns 有效文件夹绑定；未绑定或记录损坏时为 null */
  load(): WorkspaceBinding | null {
    const raw = this.readRaw();
    if (typeof raw.folder !== "string" || raw.folder === "") return null;
    const execution = this.loadExecutionSettings();
    return {
      folder: raw.folder,
      aliasId: typeof raw.aliasId === "string" && raw.aliasId ? raw.aliasId : null,
      ...(execution ? { execution } : {}),
    };
  }

  /** @returns 已校验并迁移的执行设置；旧文件或非法记录为 null */
  loadExecutionSettings(): WorkspaceExecutionSettings | null {
    const value = this.readRaw().execution;
    if (!value || !isPermissionMode(value.permissionMode) || typeof value.fastMode !== "boolean") return null;
    const model = isNonEmptyString(value.model) ? value.model : undefined;
    let normalizedModel = model;
    let restore: FastRestoreBaseline | undefined;
    const rawRestore = (value as { fastRestore?: unknown }).fastRestore;
    if (rawRestore && typeof rawRestore === "object" && !Array.isArray(rawRestore)) {
      const request = (rawRestore as { request?: unknown }).request;
      if (request === null || isNonEmptyString(request)) {
        const actualModel = (rawRestore as { actualModel?: unknown }).actualModel;
        restore = {
          request,
          // 具体 request 不允许携带 actual，避免手动模型被旧的自动快照覆盖。
          ...(request === null && isNonEmptyString(actualModel) ? { actualModel } : {}),
        };
      }
    }
    if (!value.fastMode) {
      restore = undefined; // off 不留恢复状态，防止下次 on 误用旧基线
    } else if (!restore) {
      // 旧版只有 fast/model：它未曾做 Opus 提升，升级时补齐一次并保存旧模型。
      restore = { request: model ?? null };
      normalizedModel = "opus";
    }
    const normalized: WorkspaceExecutionSettings = {
      permissionMode: value.permissionMode,
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(isEffortLevel(value.effort) ? { effort: value.effort } : {}),
      fastMode: value.fastMode,
      ...(restore ? { fastRestore: restore } : {}),
    };
    // 一次性写回迁移/清理结果；再次装载的 JSON 形状相同，不重复迁移合法状态。
    if (JSON.stringify(value) !== JSON.stringify(normalized)) this.saveExecutionSettings(normalized);
    return normalized;
  }

  /** 合并保存绑定，未提供的 execution 字段保持原值 @param b 当前绑定 @returns 无 */
  save(b: WorkspaceBinding): void {
    this.write({ ...this.readRaw(), ...b });
  }

  /** 只合并执行设置，保留 hello 前尚未恢复的文件夹与别名 @param execution 权威执行设置 @returns 无 */
  saveExecutionSettings(execution: WorkspaceExecutionSettings): void {
    this.write({ ...this.readRaw(), execution });
  }
}

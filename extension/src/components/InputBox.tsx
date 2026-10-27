import React, { useEffect, useRef, useState } from "react";
import type { PermissionModeSetting, EffortLevelSetting, FastModeRuntime } from "../lib/protocol";
import { fastDisabledReasonText, fastStatusText } from "../lib/format";
import { formatSize, readFilesAsUploads, validateFiles, type PendingUpload } from "../lib/upload-files";

/** 底部输入区：上方选择权限/模型与 CC 原生 fast，下方选择 effort 并显示 CC 真值；另含上传、发送和真正停止 */
export function InputBox(props: {
  disabled: boolean;
  /** 一轮生成进行中（含思考/工具调用期，不等首字）：发送键变为停止键，Esc 可中止 */
  busy: boolean;
  attachEnabled: boolean;
  permissionMode: PermissionModeSetting;
  /** 模型别名；空串 = 自动（跟随 CLI 配置，界面用 effectiveModel 呈现实际生效值） */
  model: string;
  /** 推理强度；空串 = 自动（同上，界面呈现 effectiveEffort 真值） */
  effort: EffortLevelSetting | "";
  /** 桥接上报的实际生效模型（已压短）；优先于手动选择显示，未知 = undefined */
  effectiveModel?: string;
  /** CC 实际 effort；null = 明确未下发，undefined = 尚无真值时可显示请求值 */
  effectiveEffort?: EffortLevelSetting | null;
  /** 用户请求的原生 fast 开关；不代表已经实际生效 */
  fastMode: boolean;
  /** CC 最近回报的 fast 真值；undefined = 等待回报或老 CLI 未提供 */
  fastRuntime?: FastModeRuntime;
  /** 原生设置应用失败；只显示在设置区 */
  settingsError?: string;
  onFastModeChange(v: boolean): void;
  /** 本次强制看页面：下一条消息强制附带页面全文（一次性，compact 后自动续一轮） */
  forceAttach: boolean;
  onToggleForceAttach(): void;
  onToggleAttach(v: boolean): void;
  onModeChange(m: PermissionModeSetting): void;
  onModelChange(v: string): void;
  onEffortChange(v: EffortLevelSetting | ""): void;
  /** 草稿（受控）：真源在父组件/桥接工作区，弹窗与侧边栏镜像同一输入内容 */
  draft: string;
  /** 草稿本地变更（父组件负责上屏状态与防抖上报桥接） */
  onDraftChange(t: string): void;
  /** 输入法组合开始/结束（父组件据它暂缓草稿镜像，防组合中被远端回包顶字） */
  onComposition?(composing: boolean): void;
  /** 发送：uploads 为待上传文件（无上传时是空数组）；桥接落盘到绑定文件夹的 copilotUploads */
  onSend(text: string, uploads: PendingUpload[]): void;
  onStop(): void;
}): React.ReactElement {
  const [files, setFiles] = useState<File[]>([]); // 待上传文件（芯片行可单个移除）
  const [uploadError, setUploadError] = useState(""); // 校验失败提示（数量/单文件/总量上限）
  const [dragOver, setDragOver] = useState(false); // 拖拽悬停高亮
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [effortOpen, setEffortOpen] = useState(false); // 仅控制下方 effort 弹层，不进入设置协议
  const effortStatusRef = useRef<HTMLDivElement>(null);

  // 弹层打开时支持点击外部和 Escape 关闭；不拦截事件，保留输入区原有停止快捷键。
  useEffect(() => {
    if (!effortOpen) return;
    const onOutside = (event: MouseEvent): void => {
      if (!effortStatusRef.current?.contains(event.target as Node | null)) setEffortOpen(false);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setEffortOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [effortOpen]);

  /** 合并新文件并整单校验：任一越界整批不加，报原因（友好拦截，协议层还有防线） */
  function addFiles(list: FileList | File[]): void {
    if (props.disabled) return;
    const merged = [...files, ...Array.from(list)];
    const err = validateFiles(merged);
    if (err) {
      setUploadError(err);
      return;
    }
    setUploadError("");
    setFiles(merged);
  }

  function removeAt(i: number): void {
    setFiles((fs) => fs.filter((_, j) => j !== i));
    setUploadError("");
  }

  const submit = async (): Promise<void> => {
    if (props.disabled || props.busy || (!props.draft.trim() && files.length === 0)) return; // busy 兜底：防 Enter 竞态连发
    // 发送时才把 File 读成 base64：芯片停留期间不占内存
    const uploads = await readFilesAsUploads(files);
    props.onSend(props.draft.trim(), uploads); // 草稿清空由父组件负责（本地即清 + 桥接广播兜底）
    setFiles([]);
    setUploadError("");
  };
  // 有 CC 真值时实际值优先；普通设置变化会清真值，此时才显示请求值并标明待确认。
  const modelPending = !props.effectiveModel && Boolean(props.model);
  const modelText = props.effectiveModel || props.model || "";
  const modelHint = modelText ? `${modelText}${modelPending ? "（待确认）" : ""}` : "";
  const effortPending = props.effectiveEffort === undefined && Boolean(props.effort);
  // null 是 CC 明确回报“不下发 effort”，不能用 ?? 回退成用户请求值。
  const effortText = props.effectiveEffort !== undefined ? (props.effectiveEffort ?? "") : props.effort;
  const effortHint = effortText ? `${effortText}${effortPending ? "（待确认）" : ""}` : "";
  const hint = [modelHint, effortHint].filter(Boolean).join(" · ");
  const fastReason = props.fastRuntime?.disabledReason;
  const fastTitle = [
    `请求 fast ${props.fastMode ? "on" : "off"}；实际状态由 Claude Code 回报，单独切换不会中断当前轮次`,
    fastReason ? fastDisabledReasonText(fastReason) : "",
    props.fastRuntime?.state === "cooldown" ? "冷却期与恢复由 CC 原生处理，CopilotCC 不计时、不限速" : "",
  ].filter(Boolean).join("；");
  return (
    <div
      className={`input-box${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault(); // 必须阻止默认行为，drop 事件才会触发
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); // 拦截浏览器默认的"打开/下载该文件"
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
      }}
    >
      <div className="toggles">
        <label>
          <input type="checkbox" checked={props.attachEnabled} onChange={(e) => props.onToggleAttach(e.target.checked)} />
          附带网页
        </label>
        <label className={`fast-toggle${props.fastMode ? " on" : ""}`} title={fastTitle}>
          <input type="checkbox" aria-label="Claude Code 原生 fast" checked={props.fastMode} onChange={(e) => props.onFastModeChange(e.target.checked)} />
          fast {props.fastMode ? "on" : "off"}
        </label>
        <select value={props.permissionMode} title="权限模式" onChange={(e) => props.onModeChange(e.target.value as PermissionModeSetting)}>
          <option value="auto">auto 自动</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="approve-each">逐条审批</option>
        </select>
        <select value={props.model} title="模型（自动 = 跟随本机 CLI 配置，· 后为当前实际生效值）" onChange={(e) => props.onModelChange(e.target.value)}>
          {/* 不显示"默认"伪状态：自动档直接呈现实际生效模型，真值未到（尚未聊过）时如实说明跟随 CLI */}
          <option value="">{props.effectiveModel ? `自动 · ${props.effectiveModel}` : "自动（跟随 CLI 配置）"}</option>
          <option value="fable">fable</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
        </select>
      </div>
      {props.settingsError ? <div className="settings-error" role="alert">{props.settingsError}</div> : null}
      {files.length > 0 ? (
        <div className="upload-chips">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="upload-chip" title={f.name}>
              📁 {f.name}（{formatSize(f.size)}）
              <button title="移除该文件" onClick={() => removeAt(i)}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      {uploadError ? <div className="upload-error">{uploadError}</div> : null}
      <textarea
        rows={3}
        placeholder={props.disabled ? "先绑定文件夹…" : "针对当前网页提问，Enter 发送 / Shift+Enter 换行；可拖入或点 📁 上传文件"}
        value={props.draft}
        disabled={props.disabled}
        onChange={(e) => props.onDraftChange(e.target.value)}
        onCompositionStart={() => props.onComposition?.(true)}
        onCompositionEnd={() => props.onComposition?.(false)}
        onKeyDown={(e) => {
          // Esc = 中止本轮生成（对齐 Claude Code CLI 的 ESC）；输入法组合中的 Esc 是取消拼音，不拦截
          if (e.key === "Escape" && props.busy && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onStop();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {/* 发送行：模型仍在上方选择；点击左侧模型·effort 状态选 effort，CC fast 真值紧跟其右 */}
      <div className="send-row">
        <div className="execution-status" ref={effortStatusRef}>
          <button
            type="button"
            className="model-effort"
            aria-label={`当前 ${hint || "自动"}，点击修改 effort`}
            aria-haspopup="listbox"
            aria-expanded={effortOpen}
            title={`${modelPending || effortPending ? "当前显示请求值，等待 CC 回报实际模型/effort" : "CC 最近回报的实际模型与推理强度"}；点击修改 effort`}
            onClick={() => setEffortOpen((open) => !open)}
          >{hint || "自动"}</button>
          <span className={`fast-runtime ${props.fastRuntime?.state ?? "pending"}`} title={fastTitle} aria-live="polite">
            {`(${fastStatusText(props.fastRuntime)})`}
          </span>
          {effortOpen ? (
            <div className="effort-picker" role="listbox" aria-label="选择 effort">
              {(["", "low", "medium", "high", "xhigh", "max"] as Array<EffortLevelSetting | "">).map((value) => (
                <button
                  key={value || "auto"}
                  type="button"
                  role="option"
                  aria-selected={props.effort === value}
                  data-effort={value}
                  onClick={() => {
                    setEffortOpen(false);
                    props.onEffortChange(value);
                  }}
                >
                  {value || (props.effectiveEffort === null
                    ? "自动 · 未下发 effort"
                    : props.effectiveEffort
                      ? `自动 · ${props.effectiveEffort}`
                      : "自动（跟随 CLI 配置）")}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={`force-attach${props.forceAttach ? " on" : ""}`}
          aria-pressed={props.forceAttach}
          title={props.forceAttach
            ? "已点亮 ✓：下一条消息强制附带页面全文；再点一次即取消（用后自动失效；本轮若发生 compact 会自动续到下一轮）"
            : "本次强制看页面：下一条消息强制附带页面全文（不受同页去重限制），用后自动失效；本轮若发生 compact 会自动续到下一轮"}
          onClick={props.onToggleForceAttach}
        >
          📄 强制看页面{props.forceAttach ? " ✓" : ""}
        </button>
        <span className="send-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = ""; // 重置：同一文件可再次选择
            }}
          />
          <button
            type="button"
            className="upload-btn"
            title="上传文件（也可直接拖进输入区）：保存到绑定文件夹的 copilotUploads 目录，Claude 用 Read 查看"
            disabled={props.disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            📁
          </button>
          {props.busy ? (
            <button type="button" className="stop-btn" title="停止本轮生成（输入框聚焦时按 Esc 同效）" onClick={props.onStop}>■ 停止</button>
          ) : (
            <button disabled={props.disabled || (!props.draft.trim() && files.length === 0)} onClick={() => void submit()}>发送</button>
          )}
        </span>
      </div>
    </div>
  );
}

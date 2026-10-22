import React, { useRef, useState } from "react";
import type { PermissionModeSetting, EffortLevelSetting } from "../lib/protocol";
import { formatSize, readFilesAsUploads, validateFiles, type PendingUpload } from "../lib/upload-files";

/** 底部输入区：附带开关、权限模式/模型/effort 选择（同一行）、文件上传（拖入或点 📁）、发送/停止 */
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
  /** 桥接上报的实际生效 effort；null/undefined = 不显示 */
  effectiveEffort?: EffortLevelSetting | null;
  /** 本次强制看页面：下一条消息强制附带页面全文（一次性，compact 后自动续一轮） */
  forceAttach: boolean;
  onToggleForceAttach(): void;
  onToggleAttach(v: boolean): void;
  onModeChange(m: PermissionModeSetting): void;
  onModelChange(v: string): void;
  onEffortChange(v: EffortLevelSetting | ""): void;
  /** 发送：uploads 为待上传文件（无上传时是空数组）；桥接落盘到绑定文件夹的 copilotUploads */
  onSend(text: string, uploads: PendingUpload[]): void;
  onStop(): void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]); // 待上传文件（芯片行可单个移除）
  const [uploadError, setUploadError] = useState(""); // 校验失败提示（数量/单文件/总量上限）
  const [dragOver, setDragOver] = useState(false); // 拖拽悬停高亮
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (props.disabled || props.busy || (!text.trim() && files.length === 0)) return; // busy 兜底：防 Enter 竞态连发
    // 发送时才把 File 读成 base64：芯片停留期间不占内存
    const uploads = await readFilesAsUploads(files);
    props.onSend(text.trim(), uploads);
    setText("");
    setFiles([]);
    setUploadError("");
  };
  // 指示文本：手动选择优先（刚改下拉时上报值还是旧会话的），其次桥接上报的实际生效值；都不知道就不显示（绝不显示"默认"二字）
  const modelText = props.model || props.effectiveModel || "";
  const effortText = props.effort || (props.effectiveEffort ?? "");
  const hint = [modelText ? `模型 ${modelText}` : "", effortText ? `effort ${effortText}` : ""].filter(Boolean).join(" · ");
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
        <select value={props.effort} title="推理强度（自动 = 跟随本机 CLI 配置，· 后为当前实际生效值）" onChange={(e) => props.onEffortChange(e.target.value as EffortLevelSetting | "")}>
          <option value="">{props.effectiveEffort ? `自动 · ${props.effectiveEffort}` : "自动（跟随 CLI 配置）"}</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
      </div>
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
      {/* 悬浮层包裹：强制看页面按钮绝对定位悬浮在输入框右上角，不占布局位置 */}
      <div className="ta-wrap">
        <textarea
          rows={3}
          placeholder={props.disabled ? "先绑定文件夹…" : "针对当前网页提问，Enter 发送 / Shift+Enter 换行；可拖入或点 📁 上传文件"}
          value={text}
          disabled={props.disabled}
          onChange={(e) => setText(e.target.value)}
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
        <button
          type="button"
          className={`force-attach${props.forceAttach ? " on" : ""}`}
          title="本次强制看页面：下一条消息强制附带页面全文（不受同页去重限制），用后自动失效；本轮若发生 compact 会自动续到下一轮"
          onClick={props.onToggleForceAttach}
        >
          📄 强制看页面
        </button>
      </div>
      {/* 发送行：最左只读显示当前生效的模型·effort（改动入口是上方下拉），上传/发送/停止按钮靠右 */}
      <div className="send-row">
        <span className="model-effort" title="当前生效的模型与推理强度（首轮回复后显示实际值；在上方下拉修改）">{hint}</span>
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
            <button disabled={props.disabled || (!text.trim() && files.length === 0)} onClick={() => void submit()}>发送</button>
          )}
        </span>
      </div>
    </div>
  );
}

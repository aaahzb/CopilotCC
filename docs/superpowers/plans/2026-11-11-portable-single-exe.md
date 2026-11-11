# Windows 绿色单文件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Windows 完整双终端桥接压缩内嵌为一个免安装 `CopilotCC.exe`，启动时先安全清理旧组件，再校验或解压当前负载，并保持真实 CLI 双终端能力。

**Architecture:** 保留现有完整发行目录作为中间产物；新增 .NET Framework WinForms 启动器，将 ZIP 作为资源嵌入。启动器在 `CCC_BRIDGE_HOME/runtime` 下按负载 SHA-256 原子发布组件，生产入口通过 `CCC_PORTABLE_RUNTIME_DIR` 定位 Console 包装和 PTY。公开 artifact 只包含单 exe。

**Tech Stack:** TypeScript、Node.js 22、Vitest、C# 5 / .NET Framework 4.x、WinForms、System.IO.Compression、7-Zip、Bun compile、现有 Chrome/Claude Code/node-pty 验收链。

## Global Constraints

- 用户只管理一个绿色 `CopilotCC.exe`；免安装、免管理员、不写注册表、exe 旁无依赖。
- 启动先清理旧版本和临时残留，再校验或解压；活跃目录、未知目录、junction 和权限异常必须保留。
- 目标约 40 MB 量级，最终记录真实大小；不把 227 MB 未压缩目录直接嵌入。
- 所有新行为先取得预期 RED，再写最小实现；不自动提交、推送、打 tag 或发布。
- 不停止或替换用户正在使用的桥接，不读取私人配对配置，不调用真实 API。
- 真实验证只使用 `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110` 下的新空目录。
- macOS 与 GitHub Runner 没有实际运行证据时保持未验收。

---

### Task 1: 生产入口识别已校验的便携负载目录

**Files:**
- Modify: `bridge/src/runtime-entry.ts`
- Test: `bridge/tests/entrypoints.test.ts`

**Interfaces:**
- Produces: `resolvePortableRuntimeDirectory(value, configRoot): string | null`
- Produces: `terminalNativeDirectory(entry?, executable?, portableValue?, configRoot?): string`
- Produces: `terminalChildCommand(entry?, executable?, platform?, portableValue?, configRoot?): TerminalChildCommand`

- [ ] **Step 1: 写便携目录解析与 Console 路径 RED**

新增测试：空值保持旧布局；`<configRoot>/runtime/<64位小写哈希>` 被接受；相对路径、错误父目录、非哈希目录、junction 和缺失 `payload-manifest.json` 抛 `PORTABLE_RUNTIME_DIR`；Windows `terminalChildCommand` 返回该目录下的 `ccc-terminal.exe`，开发 `.ts` 入口不受变量影响。

```ts
const hash = "a".repeat(64);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-portable-entry-"));
const runtime = path.join(root, "runtime", hash);
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(path.join(runtime, "payload-manifest.json"), "{}\n");
expect(resolvePortableRuntimeDirectory(runtime, root)).toBe(runtime);
expect(terminalChildCommand("C:/outer/CopilotCC.exe", "C:/outer/CopilotCC.exe", "win32", runtime, root))
  .toEqual({ executable: path.join(runtime, "ccc-terminal.exe"), prefixArgs: [] });
expect(() => resolvePortableRuntimeDirectory(path.join(root, "other"), root))
  .toThrow("PORTABLE_RUNTIME_DIR");
```

- [ ] **Step 2: 运行并确认 RED**

Run: `npm --prefix bridge test -- tests/entrypoints.test.ts`
Expected: 新导入不存在或便携参数未生效，新增用例失败；既有入口用例保留。

- [ ] **Step 3: 最小实现严格目录边界**

用 `path.resolve`、`path.relative` 和 `lstatSync` 验证直接父子关系、哈希 basename、非符号链接及 manifest 普通文件；开发态先返回 `dist/native-dev`，编译态只有变量非空才走便携目录。

```ts
export function resolvePortableRuntimeDirectory(
  value: string | undefined,
  configRoot: string = configDir(),
): string | null {
  if (!value) return null;
  const resolved = path.resolve(value);
  const runtimeRoot = path.resolve(configRoot, "runtime");
  const name = path.basename(resolved);
  if (path.dirname(resolved) !== runtimeRoot || !/^[a-f0-9]{64}$/.test(name)
    || fs.lstatSync(resolved).isSymbolicLink()
    || !fs.statSync(path.join(resolved, "payload-manifest.json")).isFile()) {
    throw new Error("PORTABLE_RUNTIME_DIR");
  }
  return resolved;
}
```

实现时补齐 `lstatSync`/`statSync` 不存在和重解析点异常，统一转成固定错误；不得添加未知目录回退。

- [ ] **Step 4: 聚焦与类型检查转 GREEN**

Run: `npm --prefix bridge test -- tests/entrypoints.test.ts && npm --prefix bridge run typecheck`
Expected: 全部通过，旧双 exe 默认布局不变。

### Task 2: 单文件启动器的安全清理、ZIP 发布与进度界面

**Files:**
- Create: `bridge/launcher/PortableLauncher.cs`
- Create: `bridge/launcher/PortableLauncherTests.cs`
- Create: `bridge/scripts/run-portable-launcher-tests.mjs`
- Create: `bridge/tests/portable-launcher.test.ts`

**Interfaces:**
- Produces: `PortableRuntime.Prepare(configRoot, expectedHash, zip, progress): string`
- Produces: `PortableRuntime.Cleanup(runtimeRoot, currentHash, activeProbe): CleanupReport`
- Produces: `PortableRuntime.Verify(directory, expectedHash): bool`
- Consumes: `PortablePayloadInfo.PayloadHash`、`CopilotCC.Payload.zip` 构建资源。

- [ ] **Step 1: 写 C#  harness RED**

Node 测试定位 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，以 `/main:CopilotCC.Portable.Tests.Program` 编译 launcher 与 harness；非 Windows 跳过，Windows 缺编译器必须失败。harness 用真实临时目录和内存 ZIP 执行：

1. `Prepare` 生成当前哈希目录和 `ccc-bridge.exe`。
2. 先收到 `cleanup` 再收到 `extract`。
3. 有标记旧版本与 `.extracting-*` 被清，未知目录保留。
4. 注入 `activeProbe` 的旧版本保留，报告不得声称 deleted。
5. 完整当前版本复用；改动一个字节后重建。
6. `../escape`、绝对路径、重复条目、清单外条目均在写入前拒绝。
7. 两个并发 `Prepare` 只得到一个有效版本，无临时目录残留。
8. 无效哈希、伪造 product 标记和 junction 不被递归删除。

核心断言示例：

```csharp
var events = new List<string>();
var progress = new RecordingProgress(events);
string current = PortableRuntime.Prepare(root, hash, NewZip(files, hash), progress);
Assert(Directory.Exists(current), "current runtime missing");
Assert(events.IndexOf("cleanup") >= 0 && events.IndexOf("extract") > events.IndexOf("cleanup"),
  "cleanup must happen before extraction");
Assert(Directory.Exists(unknown) && !Directory.Exists(old), "cleanup ownership boundary broken");
```

- [ ] **Step 2: 运行并确认 RED**

Run: `npm --prefix bridge test -- tests/portable-launcher.test.ts`
Expected: 因 `PortableRuntime`/`PortablePayloadInfo` 尚不存在，C# 编译或 harness 断言失败；不得把缺 csc 的环境错误记为行为 RED。

- [ ] **Step 3: 实现清单、路径和原子发布**

`PayloadManifest` 使用 `DataContractJsonSerializer`，字段固定为 `schemaVersion/product/payloadHash/mainExecutable/terminalExecutable/files`。清单自身不参与自身哈希。`ValidateEntry` 只接受相对普通文件路径；先读取并核对全部 ZIP 条目，再创建 staging。

```csharp
private static string ValidateRelative(string value) {
  if (String.IsNullOrEmpty(value) || value.IndexOf('\\') >= 0 || Path.IsPathRooted(value)) Fail();
  var parts = value.Split('/');
  if (parts.Any(p => p.Length == 0 || p == "." || p == "..")) Fail();
  return String.Join(Path.DirectorySeparatorChar.ToString(), parts);
}
```

`Prepare` 在同配置根互斥锁内执行：清理 → 当前版本复核 → staging 解压 → 全文件 SHA-256 → `Directory.Move`。同名目标已存在时重新复核，不覆盖有效目标。

- [ ] **Step 4: 实现专有清理和占用保护**

旧版本目录必须同时满足 64 位哈希名和 `product=CopilotCC` 的 manifest 标记；staging 必须匹配 `.extracting-<hash>-<Guid>` 且带启动器标记。任何 `ReparsePoint` 只跳过，不递归。`CleanupReport` 分别记录 deleted/skipped/active/errors，证据只能保存规范化目录名和错误类型。

```csharp
if (activeProbe(directory)) { report.Active.Add(name); continue; }
if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
  report.Skipped.Add(name); continue;
}
try { Directory.Delete(directory, true); report.Deleted.Add(name); }
catch (UnauthorizedAccessException) { report.Skipped.Add(name); }
catch (IOException) { report.Skipped.Add(name); }
```

生产 active probe 只把可执行路径位于该版本目录内的相关进程视为活跃；路径查询异常对候选桥接进程保守保留，不因 PID 相同就删除。

- [ ] **Step 5: 实现 WinForms 进度与固定内层启动**

窗口含状态标签和 0–100 ProgressBar，依次显示清理、校验、解压、启动。准备成功后使用 `UseShellExecute=false` 启动清单指定的 `ccc-bridge.exe`，传入 `CCC_PORTABLE_RUNTIME_DIR` 并继承 `CCC_BRIDGE_HOME`。进程立即非零退出时显示错误；零退出允许表示已有实例接管。所有错误保持可见，不弹成功假提示。

- [ ] **Step 6: 复跑 C# harness 和桥接测试**

Run: `npm --prefix bridge test -- tests/portable-launcher.test.ts tests/entrypoints.test.ts && npm --prefix bridge run typecheck`
Expected: C# harness 全部命名用例通过，TypeScript 聚焦测试和 typecheck 退出码 0。

### Task 3: 生成压缩资源并构建真实单文件

**Files:**
- Create: `bridge/scripts/build-portable-exe.mjs`
- Create: `bridge/tests/portable-payload.test.ts`
- Modify: `bridge/package.json`

**Interfaces:**
- Produces: `createPayloadManifest(sourceDir): { manifest, payloadHash }`
- Produces: `buildPortableExe({sourceDir,outDir,sevenZip,csc}): Promise<BuildResult>`
- Output: `bridge/dist/portable-win-x64/CopilotCC.exe`

- [ ] **Step 1: 写负载清单与公开目录 RED**

测试用小型假负载验证：递归文件均有大小/SHA-256；哈希稳定且内容变化会改变；固定包含两个 exe 和 `pty-manifest.json`；拒绝 symlink；公开 `outDir` 只能有 `CopilotCC.exe`；构建输入不完整时不得留下伪成功 exe。

```ts
const first = createPayloadManifest(sourceDir);
expect(first.manifest.product).toBe("CopilotCC");
expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
expect(first.manifest.files.map((file: { path: string }) => file.path))
  .toEqual(expect.arrayContaining(["ccc-bridge.exe", "ccc-terminal.exe", "pty-manifest.json"]));
```

- [ ] **Step 2: 运行并确认 RED**

Run: `npm --prefix bridge test -- tests/portable-payload.test.ts`
Expected: 模块不存在，套件按预期失败。

- [ ] **Step 3: 实现 ZIP、资源和启动器编译**

将完整中间目录复制到构建临时目录，写入 `payload-manifest.json`，用 `7z a -tzip -mx=9` 压缩目录内容。生成只含实际哈希的 `PortablePayloadInfo.cs`，以 `/target:winexe /platform:x64 /optimize+` 和必要 Framework reference 编译；ZIP 作为 `CopilotCC.Payload.zip` 资源嵌入。构建成功后核对资源、PE GUI 子系统和单文件目录，记录 SHA-256/字节数。

```js
const args = [
  "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
  `/out:${output}`, `/win32icon:${icon}`, `/resource:${zip},CopilotCC.Payload.zip`,
  launcherSource, generatedInfo,
];
```

临时目录和中间 ZIP 只位于 `bridge/dist/.portable-build-*`，finally 清理本轮自己创建的构建临时项，不碰旧证据。

- [ ] **Step 4: 小型测试 GREEN 后构建真实产物**

Run: `npm --prefix bridge test -- tests/portable-payload.test.ts tests/portable-launcher.test.ts && node bridge/scripts/build-portable-exe.mjs`
Expected: 测试通过；生成唯一 `dist/portable-win-x64/CopilotCC.exe`；输出真实大小和 SHA-256，目标约 40 MB 量级，不以目标值替代实测。

### Task 4: 隔离生命周期验收与发布接线

**Files:**
- Create: `bridge/scripts/verify-portable-exe.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `bridge/scripts/verify-embedded-terminal.mjs`

**Interfaces:**
- Output: `<approved-root>/portable-verification.json`
- Existing verifier adds `--portable`，公开 app 目录仅复制 `CopilotCC.exe`，默认启动外层，真实桥接身份指向 `home/runtime/<hash>/ccc-bridge.exe`。

- [ ] **Step 1: 为生命周期验收写初始 RED**

先让 `verify-portable-exe.mjs` 要求 `portableSingleFileOnly/startupProgressVisible/cleanupBeforeExtract/oldVersionRemoved/unknownPreserved/activePreserved/staleStagingRemoved/tamperedRebuilt/repeatedStartsBounded/noSidecarFiles/cleanupEmpty` 全部有真实证据；在构建脚本或启动器尚未接通时运行，确认非零且不能生成 `ok=true`。

- [ ] **Step 2: 实现定向生命周期验收**

在批准根目录的新空目录中只复制单 exe。用隔离 HOME 启动，等待 `runtime.json` 和真实进程身份；通过窗口类/PID 登记进度窗口并截图。植入带标记旧版本、staging、未知目录和 junction 后重启，核对先后顺序与边界。活跃版本通过实际运行的内层桥接验证不被删除；篡改文件、异常中断后重启验证恢复。只定向 WM_CLOSE 或按已登记身份清理。

- [ ] **Step 3: 接入 CI/Release 的单文件门禁**

Windows 构建在完整布局验证后执行 launcher harness、`build-portable-exe.mjs` 和项目树外单文件生命周期验收。Release 只上传 `bridge/dist/portable-win-x64/CopilotCC.exe`，不再公开 227 MB 目录 zip；PTY route 仍可作为内部构建 artifact，不包含 token 或用户配置。

- [ ] **Step 4: 扩展现有双终端验收的 portable 默认入口**

`--portable` 模式启动外层 exe，outer 退出不能误判内层桥接退出；从内层真实进程身份解析 `ccc-terminal.exe` 与 PTY 根目录。原有缺 manifest 故障注入仍可使用独立中间目录副本，但正常路径和真实 resume 路径必须经过单 exe。证据新增 `portableSingleFileOnly=true`，不能复用旧目录证据。

### Task 5: 完整回归、真实 CLI 双终端和文档交付

**Files:**
- Modify: `README.md`
- Modify: `docs/guide.md`
- Modify: `docs/development.md`
- Modify: `TODO.md`
- Modify: `task_plan.md`
- Modify: `progress.md`
- Modify: `findings.md`

- [ ] **Step 1: 完整自动回归**

Run: `npm --prefix bridge test && npm --prefix bridge run typecheck && npm --prefix extension test && npm --prefix extension run typecheck && npm --prefix extension run build`
Expected: 全部退出码 0，记录最新文件数和测试数；不得沿用 405/173 作为新结果。

- [ ] **Step 2: 单文件假 CLI 全量真实窗口回归**

Run: `node bridge/scripts/verify-embedded-terminal.mjs --root <approved-new-empty> --portable`
Expected: 原有全部必需项及新增单文件项为 true，Hook/运行错误/真实上游/清理残留为零。

- [ ] **Step 3: 单文件真实 CLI 双终端回归**

Run: `node bridge/scripts/verify-embedded-terminal.mjs --root <approved-new-empty> --portable --real-cli-resume-only`
Expected: 初始会话、embedded/system resume 上下文、JSONL 镜像、关窗恢复、正常桥接关闭及零残留全部通过；只访问本机假上游。

- [ ] **Step 4: 最终构建与清洁性复核**

重新构建单 exe，确认验收副本 SHA-256 与最终产物一致，运行 `verify-portable-exe.mjs` 最终轮；记录真实大小、单文件目录、重复启动后的版本目录上限和清理报告。执行相关脚本 `node --check`、原生布局校验、`git diff --check` 与敏感路径核对。

- [ ] **Step 5: 更新交付文档并给出唯一下载路径**

README 下载表和核心亮点改为绿色单文件；guide 写明直接替换 exe、无需保留旁置 `pty/`、首次启动进度和旧组件清理；development 记录构建/验收命令及活跃目录保留边界。TODO 只勾选实际通过的 Windows 项，macOS 和 GitHub Runner 保持未验收。最终向用户提供：

```text
D:\SVN_Cursor\chromeClaudeCode\bridge\dist\portable-win-x64\CopilotCC.exe
```

不自动提交、推送、打 tag 或发布。

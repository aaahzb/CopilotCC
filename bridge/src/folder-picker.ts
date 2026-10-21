import { execFile } from "node:child_process";

/** 选择框兜底超时：用户挂着不点也不至于让子进程永远悬挂 */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 弹系统原生文件夹选择框，返回所选绝对路径。
 * Windows 用 PowerShell FolderBrowserDialog（-STA + 置顶 owner 窗体），macOS 用 osascript choose folder。
 * 用户取消、平台不支持、执行出错统一返回 null（取消与不支持不区分，UI 保留手输路径的退路）。
 * @returns 所选路径；取消/不支持/出错返回 null
 */
export function pickFolder(): Promise<string | null> {
  if (process.platform === "win32") {
    // 无 owner 的 FolderBrowserDialog 常被压到后台：挂一个 TopMost 隐形窗体做 owner 保证弹到最前
    return run("powershell", [
      "-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; "
      + "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }; "
      + "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择要绑定的文件夹'; "
      + "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ]);
  }
  if (process.platform === "darwin") {
    return run("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择要绑定的文件夹")']);
  }
  return Promise.resolve(null);
}

/**
 * 执行外部命令并收集 stdout；任何失败（含用户取消的非零退出）都解析为 null。
 * @param cmd 可执行程序
 * @param args 参数列表
 * @returns 规范化后的路径（去掉末尾斜杠，保住盘符根目录）或 null
 */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // windowsHide 只藏子进程的控制台黑窗，GUI 选择框是子进程自建的窗口，不受影响
    execFile(cmd, args, { timeout: PICK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      let p = stdout.trim().replace(/[\/]+$/, ""); // macOS choose folder 结果末尾带 /
      if (/^[A-Za-z]:$/.test(p)) p += "\\"; // 选中盘符根目录时保住斜杠（"C:" 会被解析成 cwd）
      resolve(p.length > 0 ? p : null);
    });
  });
}

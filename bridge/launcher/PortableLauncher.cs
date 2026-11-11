using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CopilotCC.Portable {
  internal static class PortableProgram {
    [STAThread]
    private static void Main(string[] args) {
      PortableRuntime.EnableLongPaths();
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new LauncherForm(args));
    }
  }

  internal sealed class LauncherForm : Form {
    private readonly string[] arguments;
    private readonly Label status;
    private readonly ProgressBar progress;
    private readonly Button closeButton;
    private bool allowClose;

    internal LauncherForm(string[] args) {
      arguments = args;
      Text = "CopilotCC 正在启动";
      ClientSize = new Size(460, 126);
      StartPosition = FormStartPosition.CenterScreen;
      FormBorderStyle = FormBorderStyle.FixedSingle;
      MaximizeBox = false;
      MinimizeBox = false;
      ControlBox = false;
      ShowInTaskbar = true;
      BackColor = Color.White;
      try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

      var title = new Label {
        Text = "CopilotCC", Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
        AutoSize = true, Location = new Point(20, 14),
      };
      status = new Label {
        Text = "正在准备绿色运行组件…", AutoSize = false, Size = new Size(420, 24),
        Location = new Point(22, 51), Font = new Font("Microsoft YaHei UI", 9F),
      };
      progress = new ProgressBar {
        Minimum = 0, Maximum = 100, Value = 0, Size = new Size(420, 12),
        Location = new Point(22, 83), Style = ProgressBarStyle.Continuous,
      };
      closeButton = new Button {
        Text = "关闭", Size = new Size(80, 28), Location = new Point(362, 101), Visible = false,
      };
      closeButton.Click += delegate { allowClose = true; Close(); };
      Controls.Add(title);
      Controls.Add(status);
      Controls.Add(progress);
      Controls.Add(closeButton);
    }

    protected override async void OnShown(EventArgs e) {
      base.OnShown(e);
      try {
        string configRoot = ConfigurationRoot();
        string runtime;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("CopilotCC.Payload.zip")) {
          if (resource == null) throw new InvalidDataException("单文件内未找到压缩运行组件");
          using (var zip = new ZipArchive(resource, ZipArchiveMode.Read, false)) {
            var reporter = new UiProgress(this);
            runtime = await Task.Run(() => PortableRuntime.Prepare(
              configRoot, PortablePayloadInfo.PayloadHash, zip, reporter));
          }
        }
        Report("launch", 96, "正在启动 CopilotCC");
        StartBridge(runtime);
        Report("ready", 100, "启动完成");
        await Task.Delay(250);
        allowClose = true;
        Close();
      } catch (Exception error) {
        ShowFailure(error);
      }
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
      if (!allowClose && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
      base.OnFormClosing(e);
    }

    private void StartBridge(string runtime) {
      string executable = Path.Combine(runtime, "ccc-bridge.exe");
      var start = new ProcessStartInfo {
        FileName = executable,
        WorkingDirectory = runtime,
        Arguments = JoinArguments(arguments),
        UseShellExecute = false,
        CreateNoWindow = true,
      };
      start.EnvironmentVariables["CCC_PORTABLE_RUNTIME_DIR"] = runtime;
      using (Process process = Process.Start(start)) {
        if (process == null) throw new InvalidOperationException("无法创建桥接进程");
        process.WaitForExit(800);
        if (process.HasExited && process.ExitCode != 0) {
          throw new InvalidOperationException("桥接进程启动失败，退出码 " + process.ExitCode);
        }
        // 零退出可能表示已有托盘实例接管，不能误报为启动失败。
      }
    }

    private static string ConfigurationRoot() {
      string configured = Environment.GetEnvironmentVariable("CCC_BRIDGE_HOME");
      if (!String.IsNullOrEmpty(configured)) return Path.GetFullPath(configured);
      string profile = Environment.GetEnvironmentVariable("USERPROFILE");
      if (String.IsNullOrEmpty(profile)) profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      return Path.Combine(profile, ".ccc-bridge");
    }

    private static string JoinArguments(string[] args) {
      if (args == null || args.Length == 0) return "";
      return String.Join(" ", Array.ConvertAll(args, QuoteArgument));
    }

    private static string QuoteArgument(string value) {
      if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
      var result = new StringBuilder("\"");
      int slashes = 0;
      foreach (char character in value) {
        if (character == '\\') { slashes++; continue; }
        if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
        else result.Append('\\', slashes).Append(character);
        slashes = 0;
      }
      result.Append('\\', slashes * 2).Append('"');
      return result.ToString();
    }

    private void Report(string stage, int percent, string message) {
      if (InvokeRequired) {
        BeginInvoke(new Action<string, int, string>(Report), stage, percent, message);
        return;
      }
      status.Text = message;
      progress.Value = Math.Max(progress.Minimum, Math.Min(progress.Maximum, percent));
    }

    private void ShowFailure(Exception error) {
      if (InvokeRequired) {
        BeginInvoke(new Action<Exception>(ShowFailure), error);
        return;
      }
      allowClose = true;
      ControlBox = true;
      closeButton.Visible = true;
      ClientSize = new Size(460, 154);
      status.Text = "启动失败：" + error.GetType().Name + "。请确认目录可写，并关闭残留的 CopilotCC 组件后重试。";
      status.Size = new Size(420, 48);
      progress.Value = 0;
      MessageBox.Show(this,
        "CopilotCC 未能准备运行组件。\n\n阶段：" + status.Text + "\n\n详细信息：" + error.Message,
        "CopilotCC 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private sealed class UiProgress : IPortableProgress {
      private readonly LauncherForm form;
      internal UiProgress(LauncherForm owner) { form = owner; }
      public void Report(string stage, int percent, string message) {
        form.Report(stage, percent, message);
      }
    }
  }
}

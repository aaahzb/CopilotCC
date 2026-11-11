using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace CopilotCC.Portable {
  /// <summary>启动阶段进度，由 WinForms 或测试记录器接收。</summary>
  public interface IPortableProgress {
    void Report(string stage, int percent, string message);
  }

  [DataContract]
  public sealed class PayloadFile {
    [DataMember(Name = "path")] public string Path;
    [DataMember(Name = "sha256")] public string Sha256;
    [DataMember(Name = "size")] public long Size;
  }

  [DataContract]
  public sealed class PayloadManifest {
    [DataMember(Name = "schemaVersion")] public int SchemaVersion;
    [DataMember(Name = "product")] public string Product;
    [DataMember(Name = "payloadHash")] public string PayloadHash;
    [DataMember(Name = "mainExecutable")] public string MainExecutable;
    [DataMember(Name = "terminalExecutable")] public string TerminalExecutable;
    [DataMember(Name = "files")] public List<PayloadFile> Files;
  }

  [DataContract]
  public sealed class PackedChunk {
    [DataMember(Name = "offset")] public long Offset;
    [DataMember(Name = "size")] public long Size;
  }

  [DataContract]
  public sealed class PackedFile {
    [DataMember(Name = "path")] public string Path;
    [DataMember(Name = "size")] public long Size;
    [DataMember(Name = "chunks")] public List<PackedChunk> Chunks;
  }

  [DataContract]
  public sealed class PackedStorage {
    [DataMember(Name = "schemaVersion")] public int SchemaVersion;
    [DataMember(Name = "contentPack")] public string ContentPack;
    [DataMember(Name = "files")] public List<PackedFile> Files;
  }

  /// <summary>只报告目录名和结果，不记录配置、环境或秘密。</summary>
  public sealed class CleanupReport {
    public readonly List<string> Deleted = new List<string>();
    public readonly List<string> Skipped = new List<string>();
    public readonly List<string> Active = new List<string>();
    public readonly List<string> Errors = new List<string>();
  }

  /// <summary>绿色单文件的清理、ZIP 校验、原子发布和版本复用。</summary>
  public static class PortableRuntime {
    private const string ManifestName = "payload-manifest.json";
    private const string StorageName = "payload-storage.json";
    private const string ContentPackName = "payload-content.bin";
    private const string StagingMarker = ".copilotcc-extracting";
    private static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex StagingPattern = new Regex(
      @"^\.extracting-[a-f0-9]{64}-[a-f0-9]{32}$", RegexOptions.CultureInvariant);

    static PortableRuntime() {
      EnableLongPaths();
    }

    /// <summary>必须在进程第一次 Path/IO 调用前启用；迟到的开关不会改变旧路径语义。</summary>
    public static void EnableLongPaths() {
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
    }

    /// <summary>把绝对本地/UNC 路径转为 Windows 扩展 IO 形式，幂等且不改变语义。</summary>
    private static string IoPath(string value) {
      string full = Path.GetFullPath(value);
      if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
      if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
      return @"\\?\" + full;
    }

    /// <summary>传给内层进程和公开调用者的路径不携带扩展前缀。</summary>
    private static string PublicPath(string value) {
      if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
      if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) return value.Substring(4);
      return value;
    }

    /// <summary>先清理，再校验或解压当前版本；整个过程按配置根串行化。</summary>
    public static string Prepare(string configRoot, string expectedHash, ZipArchive zip, IPortableProgress progress) {
      if (String.IsNullOrEmpty(configRoot)) throw new InvalidDataException("配置目录为空");
      if (!HashPattern.IsMatch(expectedHash ?? "")) throw new InvalidDataException("负载哈希非法");
      if (zip == null) throw new ArgumentNullException("zip");
      string root = Path.GetFullPath(configRoot);
      string ioRoot = IoPath(root);
      string runtimeRoot = Path.Combine(ioRoot, "runtime");
      Directory.CreateDirectory(ioRoot);
      EnsureRealDirectory(runtimeRoot, true);
      string mutexName = @"Local\CopilotCC.Runtime." + HashBytes(Encoding.UTF8.GetBytes(root.ToUpperInvariant()));
      using (var mutex = new Mutex(false, mutexName)) {
        bool acquired = false;
        try {
          try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(60)); }
          catch (AbandonedMutexException) { acquired = true; }
          if (!acquired) throw new TimeoutException("等待另一个 CopilotCC 启动器超时");
          Report(progress, "cleanup", 5, "正在清理旧版本组件");
          Cleanup(runtimeRoot, expectedHash, IsRuntimeDirectoryActive);
          string current = Path.Combine(runtimeRoot, expectedHash);
          Report(progress, "verify", 15, "正在校验当前组件");
          if (Verify(current, expectedHash)) {
            Report(progress, "ready", 100, "组件已就绪");
            return PublicPath(current);
          }
          RemoveInvalidCurrent(current, expectedHash);
          Report(progress, "extract", 20, "正在解压当前组件");
          return PublicPath(ExtractAndPublish(runtimeRoot, current, expectedHash, zip, progress));
        } finally {
          if (acquired) mutex.ReleaseMutex();
        }
      }
    }

    /// <summary>只清理本应用所有的旧版本和临时目录，活跃或异常目录保留。</summary>
    public static CleanupReport Cleanup(string runtimeRoot, string currentHash, Func<string, bool> activeProbe) {
      var report = new CleanupReport();
      runtimeRoot = IoPath(runtimeRoot);
      if (!Directory.Exists(runtimeRoot)) return report;
      EnsureRealDirectory(runtimeRoot, false);
      foreach (string directory in Directory.GetDirectories(runtimeRoot)) {
        string name = Path.GetFileName(directory);
        if (String.Equals(name, currentHash, StringComparison.OrdinalIgnoreCase)) continue;
        try {
          if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
            report.Skipped.Add(name);
            continue;
          }
          bool ownedVersion = HashPattern.IsMatch(name) && HasOwnedManifest(directory, name);
          bool ownedStaging = StagingPattern.IsMatch(name) && HasStagingMarker(directory);
          if (!ownedVersion && !ownedStaging) {
            report.Skipped.Add(name);
            continue;
          }
          if (activeProbe != null && activeProbe(PublicPath(directory))) {
            report.Active.Add(name);
            continue;
          }
          // 任何内部链接都使整个目录保守保留，递归删除不得越过目录边界。
          if (ContainsReparsePoint(directory)) {
            report.Skipped.Add(name);
            continue;
          }
          Directory.Delete(directory, true);
          report.Deleted.Add(name);
        } catch (UnauthorizedAccessException error) {
          report.Skipped.Add(name);
          report.Errors.Add(name + ":" + error.GetType().Name);
        } catch (IOException error) {
          report.Skipped.Add(name);
          report.Errors.Add(name + ":" + error.GetType().Name);
        } catch (Exception error) {
          report.Skipped.Add(name);
          report.Errors.Add(name + ":" + error.GetType().Name);
        }
      }
      return report;
    }

    /// <summary>复核清单、全部文件集合、大小和 SHA-256，拒绝任何重解析点。</summary>
    public static bool Verify(string directory, string expectedHash) {
      try {
        directory = IoPath(directory);
        if (!Directory.Exists(directory) || !HashPattern.IsMatch(expectedHash)) return false;
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return false;
        PayloadManifest manifest = ReadManifestFile(Path.Combine(directory, ManifestName));
        ValidateManifest(manifest, expectedHash);
        var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string file in ListFilesNoReparse(directory)) actual.Add(file);
        var expected = new HashSet<string>(manifest.Files.Select(f => f.Path), StringComparer.OrdinalIgnoreCase);
        expected.Add(ManifestName);
        if (!actual.SetEquals(expected)) return false;
        foreach (PayloadFile file in manifest.Files) {
          string full = Path.Combine(directory, ToNativePath(file.Path));
          var info = new FileInfo(full);
          if (!info.Exists || info.Length != file.Size) return false;
          if (!String.Equals(HashFile(full), file.Sha256, StringComparison.Ordinal)) return false;
        }
        return true;
      } catch {
        return false;
      }
    }

    private static string ExtractAndPublish(
      string runtimeRoot, string current, string expectedHash, ZipArchive zip, IPortableProgress progress) {
      PayloadManifest manifest = ReadAndValidateZip(zip, expectedHash);
      PackedStorage storage = ReadPackedStorage(zip, manifest);
      string staging = Path.Combine(runtimeRoot,
        ".extracting-" + expectedHash + "-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(staging);
      try {
        File.WriteAllText(Path.Combine(staging, StagingMarker),
          "CopilotCC\n" + expectedHash + "\n", new UTF8Encoding(false));
        long total = manifest.Files.Sum(f => Math.Max(0, f.Size));
        long completed = 0;
        if (storage == null) {
          foreach (ZipArchiveEntry entry in zip.Entries) {
            if (entry.FullName.EndsWith("/")) continue;
            string relative = NormalizeRelative(entry.FullName);
            string destination = Path.Combine(staging, ToNativePath(relative));
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            using (Stream input = entry.Open())
            using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              CopyWithProgress(input, output, entry.Length, ref completed, total, progress);
            }
          }
        } else {
          // ZIP 中只保存唯一数据块；按配方重建原始文件后再执行逐文件 SHA-256 复核。
          // 清单不属于 manifest.Files，但也必须作为正式版本文件发布。
          using (Stream input = zip.GetEntry(ManifestName).Open())
          using (var output = new FileStream(Path.Combine(staging, ManifestName), FileMode.CreateNew)) {
            input.CopyTo(output);
          }
          string packFile = Path.Combine(staging, ".copilotcc-content");
          using (Stream input = zip.GetEntry(ContentPackName).Open())
          using (var output = new FileStream(packFile, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            input.CopyTo(output);
          }
          using (var pack = new FileStream(packFile, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            foreach (PackedFile file in storage.Files) {
              string destination = Path.Combine(staging, ToNativePath(file.Path));
              Directory.CreateDirectory(Path.GetDirectoryName(destination));
              using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                foreach (PackedChunk chunk in file.Chunks) {
                  pack.Position = chunk.Offset;
                  CopyWithProgress(pack, output, chunk.Size, ref completed, total, progress);
                }
              }
            }
          }
          File.Delete(packFile);
        }
        File.Delete(Path.Combine(staging, StagingMarker));
        Report(progress, "verify", 92, "正在复核解压结果");
        if (!Verify(staging, expectedHash)) throw new InvalidDataException("解压后的组件哈希校验失败");
        if (Directory.Exists(current)) {
          // 同名目录只能由本启动器在同一互斥锁内重建，绝不覆盖未知内容。
          if (Verify(current, expectedHash)) {
            DeleteOwnedTree(staging);
            Report(progress, "ready", 100, "组件已就绪");
            return current;
          }
          throw new IOException("当前版本目录在发布前发生变化");
        }
        Directory.Move(staging, current);
        Report(progress, "ready", 100, "组件已就绪");
        return current;
      } catch {
        if (Directory.Exists(staging)) {
          try { DeleteOwnedTree(staging); } catch { /* 留待下次启动按专有 staging 标记回收 */ }
        }
        throw;
      }
    }

    private static PayloadManifest ReadAndValidateZip(ZipArchive zip, string expectedHash) {
      var manifestEntries = zip.Entries.Where(e => e.FullName == ManifestName).ToArray();
      if (manifestEntries.Length != 1) throw new InvalidDataException("负载清单数量非法");
      if (manifestEntries[0].Length > 1024 * 1024) throw new InvalidDataException("负载清单过大");
      PayloadManifest manifest;
      using (Stream input = manifestEntries[0].Open()) {
        var serializer = new DataContractJsonSerializer(typeof(PayloadManifest));
        manifest = serializer.ReadObject(input) as PayloadManifest;
      }
      ValidateManifest(manifest, expectedHash);
      var expected = new HashSet<string>(manifest.Files.Select(f => f.Path), StringComparer.OrdinalIgnoreCase);
      expected.Add(ManifestName);
      bool packed = zip.Entries.Any(e => e.FullName == StorageName || e.FullName == ContentPackName);
      if (packed) {
        if (zip.Entries.Count(e => e.FullName == StorageName) != 1
          || zip.Entries.Count(e => e.FullName == ContentPackName) != 1) {
          throw new InvalidDataException("去重负载描述数量非法");
        }
        expected.Clear();
        expected.Add(ManifestName);
        expected.Add(StorageName);
        expected.Add(ContentPackName);
      }
      var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (ZipArchiveEntry entry in zip.Entries) {
        bool directory = entry.FullName.EndsWith("/");
        string name = directory ? entry.FullName.TrimEnd('/') : entry.FullName;
        string relative = NormalizeRelative(name);
        if (directory) continue;
        if (!actual.Add(relative)) throw new InvalidDataException("ZIP 含重复文件");
      }
      if (!actual.SetEquals(expected)) throw new InvalidDataException("ZIP 文件集合与清单不一致");
      return manifest;
    }

    private static PackedStorage ReadPackedStorage(ZipArchive zip, PayloadManifest manifest) {
      ZipArchiveEntry descriptorEntry = zip.GetEntry(StorageName);
      if (descriptorEntry == null) return null;
      if (descriptorEntry.Length > 4 * 1024 * 1024) throw new InvalidDataException("去重负载描述过大");
      PackedStorage storage;
      using (Stream input = descriptorEntry.Open()) {
        var serializer = new DataContractJsonSerializer(typeof(PackedStorage));
        storage = serializer.ReadObject(input) as PackedStorage;
      }
      if (storage == null || storage.SchemaVersion != 1 || storage.ContentPack != ContentPackName
        || storage.Files == null) throw new InvalidDataException("去重负载描述身份非法");
      long packLength = zip.GetEntry(ContentPackName).Length;
      long originalTotal = manifest.Files.Sum(f => f.Size);
      if (packLength > originalTotal) throw new InvalidDataException("去重数据包大于原始负载");
      var expected = new HashSet<string>(manifest.Files.Select(f => f.Path), StringComparer.OrdinalIgnoreCase);
      var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var sizes = manifest.Files.ToDictionary(f => f.Path, f => f.Size, StringComparer.OrdinalIgnoreCase);
      var ranges = new List<Tuple<long, long>>();
      foreach (PackedFile file in storage.Files) {
        if (file == null || file.Chunks == null || NormalizeRelative(file.Path) != file.Path
          || !expected.Contains(file.Path) || !actual.Add(file.Path) || sizes[file.Path] != file.Size) {
          throw new InvalidDataException("去重文件配方非法");
        }
        long reconstructed = 0;
        foreach (PackedChunk chunk in file.Chunks) {
          if (chunk == null || chunk.Offset < 0 || chunk.Size <= 0
            || chunk.Offset > packLength - chunk.Size || reconstructed > file.Size - chunk.Size) {
            throw new InvalidDataException("去重数据块越界");
          }
          ranges.Add(Tuple.Create(chunk.Offset, chunk.Size));
          reconstructed += chunk.Size;
        }
        if (reconstructed != file.Size) throw new InvalidDataException("去重文件大小不一致");
      }
      if (!actual.SetEquals(expected)) throw new InvalidDataException("去重配方文件集合不完整");
      // 所有 pack 字节必须至少被一个原始文件引用，禁止夹带无用内容。
      long covered = 0;
      foreach (var range in ranges.OrderBy(r => r.Item1).ThenBy(r => r.Item2)) {
        if (range.Item1 > covered) throw new InvalidDataException("去重数据包含未引用区域");
        covered = Math.Max(covered, range.Item1 + range.Item2);
      }
      if (covered != packLength) throw new InvalidDataException("去重数据包覆盖不完整");
      return storage;
    }

    private static void CopyWithProgress(
      Stream input, Stream output, long length, ref long completed, long total, IPortableProgress progress) {
      var buffer = new byte[128 * 1024];
      long remaining = length;
      while (remaining > 0) {
        int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
        if (read <= 0) throw new InvalidDataException("负载数据提前结束");
        output.Write(buffer, 0, read);
        remaining -= read;
        completed += read;
        int percent = total > 0 ? 20 + (int)(completed * 70 / total) : 90;
        Report(progress, "extract", Math.Min(90, percent), "正在解压当前组件");
      }
    }

    private static void ValidateManifest(PayloadManifest manifest, string expectedHash) {
      if (manifest == null || manifest.SchemaVersion != 1 || manifest.Product != "CopilotCC"
        || manifest.PayloadHash != expectedHash || manifest.MainExecutable != "ccc-bridge.exe"
        || manifest.TerminalExecutable != "ccc-terminal.exe" || manifest.Files == null) {
        throw new InvalidDataException("负载清单身份非法");
      }
      var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (PayloadFile file in manifest.Files) {
        if (file == null || file.Size < 0 || !HashPattern.IsMatch(file.Sha256 ?? "")) {
          throw new InvalidDataException("负载文件记录非法");
        }
        string relative = NormalizeRelative(file.Path);
        if (relative != file.Path || relative == ManifestName || !paths.Add(relative)) {
          throw new InvalidDataException("负载文件路径非法或重复");
        }
      }
      if (!paths.Contains("ccc-bridge.exe") || !paths.Contains("ccc-terminal.exe")
        || !paths.Contains("pty-manifest.json")) throw new InvalidDataException("负载缺少必要组件");
    }

    private static string NormalizeRelative(string value) {
      if (String.IsNullOrEmpty(value) || value.IndexOf('\\') >= 0 || value.IndexOf(':') >= 0
        || Path.IsPathRooted(value) || value.StartsWith("/")) throw new InvalidDataException("负载相对路径非法");
      string[] parts = value.Split('/');
      if (parts.Any(part => part.Length == 0 || part == "." || part == "..")) {
        throw new InvalidDataException("负载路径含非法分段");
      }
      return String.Join("/", parts);
    }

    private static string ToNativePath(string value) {
      return value.Replace('/', Path.DirectorySeparatorChar);
    }

    private static PayloadManifest ReadManifestFile(string file) {
      var info = new FileInfo(file);
      if (!info.Exists || info.Length > 1024 * 1024
        || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("版本清单无效");
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        var serializer = new DataContractJsonSerializer(typeof(PayloadManifest));
        return serializer.ReadObject(stream) as PayloadManifest;
      }
    }

    private static bool HasOwnedManifest(string directory, string hash) {
      try {
        PayloadManifest manifest = ReadManifestFile(Path.Combine(directory, ManifestName));
        return manifest != null && manifest.SchemaVersion == 1 && manifest.Product == "CopilotCC"
          && manifest.PayloadHash == hash;
      } catch { return false; }
    }

    private static bool HasStagingMarker(string directory) {
      try {
        string file = Path.Combine(directory, StagingMarker);
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return false;
        string text = File.ReadAllText(file);
        string name = Path.GetFileName(directory);
        string hash = name.Substring(".extracting-".Length, 64);
        return text == "CopilotCC\n" + hash + "\n" || text == "CopilotCC\r\n" + hash + "\r\n";
      } catch { return false; }
    }

    private static void RemoveInvalidCurrent(string current, string expectedHash) {
      if (!Directory.Exists(current)) return;
      if (IsRuntimeDirectoryActive(current)) throw new IOException("损坏组件正被另一个实例使用");
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0
        || !HasOwnedManifest(current, expectedHash) || ContainsReparsePoint(current)) {
        throw new InvalidDataException("当前版本无效且不能确认安全清理边界");
      }
      Directory.Delete(current, true);
    }

    private static void EnsureRealDirectory(string directory, bool create) {
      if (create) Directory.CreateDirectory(directory);
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
        throw new IOException("runtime 目录不能是链接或 junction");
      }
    }

    private static bool ContainsReparsePoint(string directory) {
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return true;
      foreach (string file in Directory.GetFiles(directory)) {
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return true;
      }
      foreach (string child in Directory.GetDirectories(directory)) {
        if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) return true;
        if (ContainsReparsePoint(child)) return true;
      }
      return false;
    }

    private static IEnumerable<string> ListFilesNoReparse(string directory) {
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
        throw new IOException("负载含重解析点");
      }
      foreach (string file in Directory.GetFiles(directory)) {
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) {
          throw new IOException("负载含文件链接");
        }
        yield return Path.GetFileName(file);
      }
      foreach (string child in Directory.GetDirectories(directory)) {
        if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) {
          throw new IOException("负载含目录链接");
        }
        foreach (string file in ListFilesNoReparse(child)) {
          yield return Path.GetFileName(child) + "/" + file;
        }
      }
    }

    private static string HashFile(string file) {
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        return HashBytes(stream);
      }
    }

    private static string HashBytes(byte[] bytes) {
      using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes));
    }

    private static string HashBytes(Stream stream) {
      using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(stream));
    }

    private static string Hex(byte[] bytes) {
      return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private static bool IsRuntimeDirectoryActive(string directory) {
      var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "ccc-bridge", "ccc-terminal", "OpenConsole", "conpty", "winpty-agent",
      };
      foreach (Process process in Process.GetProcesses()) {
        using (process) {
          if (!candidates.Contains(process.ProcessName)) continue;
          try {
            string executable = PublicPath(Path.GetFullPath(process.MainModule.FileName));
            string prefix = PublicPath(Path.GetFullPath(directory)).TrimEnd(Path.DirectorySeparatorChar)
              + Path.DirectorySeparatorChar;
            if (executable.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
          } catch {
            // 候选桥接进程身份未知时不能删除任何可能属于它的版本。
            return true;
          }
        }
      }
      return false;
    }

    private static void DeleteOwnedTree(string directory) {
      if (ContainsReparsePoint(directory)) throw new IOException("拒绝递归清理含链接的目录");
      Directory.Delete(directory, true);
    }

    private static void Report(IPortableProgress progress, string stage, int percent, string message) {
      if (progress != null) progress.Report(stage, percent, message);
    }
  }
}

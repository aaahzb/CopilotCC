using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace CopilotCC.Portable.Tests {
  internal sealed class RecordingProgress : IPortableProgress {
    internal readonly List<string> Events = new List<string>();
    public void Report(string stage, int percent, string message) {
      Events.Add(stage);
    }
  }

  internal static class Program {
    private static int failures;

    private static int Main() {
      PortableRuntime.EnableLongPaths();
      Console.OutputEncoding = Encoding.UTF8;
      Run("prepare-cleanup-before-extract", TestPrepareAndOrder);
      Run("cleanup-owned-only-and-active", TestCleanupBoundaries);
      Run("tampered-current-rebuilt", TestTamperedCurrent);
      Run("unsafe-and-extra-zip-rejected", TestUnsafeZip);
      Run("concurrent-prepare-single-version", TestConcurrentPrepare);
      Run("packed-storage-roundtrip", TestPackedStorage);
      Run("junction-never-recursed", TestJunctionPreserved);
      Run("long-path-prepare", TestLongPathPrepare);
      Console.WriteLine(failures == 0
        ? "PORTABLE_LAUNCHER_TESTS_OK=8"
        : "PORTABLE_LAUNCHER_TESTS_FAILED=" + failures);
      return failures == 0 ? 0 : 1;
    }

    private static void Run(string name, Action test) {
      try {
        test();
        Console.WriteLine("PASS " + name);
      } catch (Exception error) {
        failures++;
        Console.WriteLine("FAIL " + name + ": " + error.Message);
      }
    }

    private static void Assert(bool condition, string message) {
      if (!condition) throw new InvalidOperationException(message);
    }

    private static string NewRoot() {
      string root = Path.Combine(Path.GetTempPath(), "ccc-portable-csharp-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(root);
      return root;
    }

    private static Dictionary<string, byte[]> ValidFiles() {
      return new Dictionary<string, byte[]> {
        { "ccc-bridge.exe", Encoding.UTF8.GetBytes("bridge-v1") },
        { "ccc-terminal.exe", Encoding.UTF8.GetBytes("terminal-v1") },
        { "pty-manifest.json", Encoding.UTF8.GetBytes("{\"schemaVersion\":1}\n") },
        { "pty/node_modules/node-pty/lib/index.js", Encoding.UTF8.GetBytes("module.exports={};\n") },
      };
    }

    private static PayloadManifest NewManifest(string hash, IDictionary<string, byte[]> files) {
      var manifest = new PayloadManifest {
        SchemaVersion = 1,
        Product = "CopilotCC",
        PayloadHash = hash,
        MainExecutable = "ccc-bridge.exe",
        TerminalExecutable = "ccc-terminal.exe",
        Files = new List<PayloadFile>(),
      };
      foreach (var pair in files.OrderBy(p => p.Key, StringComparer.Ordinal)) {
        manifest.Files.Add(new PayloadFile {
          Path = pair.Key,
          Size = pair.Value.LongLength,
          Sha256 = Hash(pair.Value),
        });
      }
      return manifest;
    }

    private static string Hash(byte[] bytes) {
      using (var sha = SHA256.Create()) {
        return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
      }
    }

    private static byte[] ManifestBytes(PayloadManifest manifest) {
      var serializer = new DataContractJsonSerializer(typeof(PayloadManifest));
      using (var stream = new MemoryStream()) {
        serializer.WriteObject(stream, manifest);
        return stream.ToArray();
      }
    }

    private static void AddEntry(ZipArchive zip, string name, byte[] bytes) {
      var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
      using (var output = entry.Open()) output.Write(bytes, 0, bytes.Length);
    }

    private static ZipArchive NewZip(
      IDictionary<string, byte[]> files, string hash, params string[] extraEntries) {
      var stream = new MemoryStream();
      using (var create = new ZipArchive(stream, ZipArchiveMode.Create, true)) {
        AddEntry(create, "payload-manifest.json", ManifestBytes(NewManifest(hash, files)));
        foreach (var pair in files) AddEntry(create, pair.Key, pair.Value);
        foreach (string extra in extraEntries) AddEntry(create, extra, Encoding.UTF8.GetBytes("bad"));
      }
      // Create 模式中的条目只写不可读；完成后必须按真实启动器方式重新打开 Read 模式。
      stream.Position = 0;
      return new ZipArchive(stream, ZipArchiveMode.Read, false);
    }

    private static void WriteOwnedVersion(string directory, string hash, string product) {
      Directory.CreateDirectory(directory);
      var manifest = NewManifest(hash, ValidFiles());
      manifest.Product = product;
      File.WriteAllBytes(Path.Combine(directory, "payload-manifest.json"), ManifestBytes(manifest));
    }

    private static void DeleteOwnedTree(string directory) {
      if (!Directory.Exists(directory)) return;
      var attributes = File.GetAttributes(directory);
      if ((attributes & FileAttributes.ReparsePoint) != 0) {
        Directory.Delete(directory, false);
        return;
      }
      foreach (string child in Directory.GetDirectories(directory)) DeleteOwnedTree(child);
      foreach (string file in Directory.GetFiles(directory)) File.Delete(file);
      Directory.Delete(directory, false);
    }

    private static void TestPrepareAndOrder() {
      string root = NewRoot();
      try {
        string hash = new string('1', 64);
        var progress = new RecordingProgress();
        using (var zip = NewZip(ValidFiles(), hash)) {
          string current = PortableRuntime.Prepare(root, hash, zip, progress);
          Assert(Directory.Exists(current), "current version missing");
          Assert(File.ReadAllText(Path.Combine(current, "ccc-bridge.exe")) == "bridge-v1", "payload not extracted");
          Assert(PortableRuntime.Verify(current, hash), "fresh payload failed verification");
        }
        Assert(progress.Events.IndexOf("cleanup") >= 0, "cleanup not reported");
        Assert(progress.Events.IndexOf("extract") > progress.Events.IndexOf("cleanup"), "extract happened before cleanup");
        int extractionCount = progress.Events.Count(e => e == "extract");
        using (var zip = NewZip(ValidFiles(), hash)) PortableRuntime.Prepare(root, hash, zip, progress);
        Assert(progress.Events.Count(e => e == "extract") == extractionCount, "valid current version was needlessly extracted");
      } finally {
        DeleteOwnedTree(root);
      }
    }

    private static void TestCleanupBoundaries() {
      string root = NewRoot();
      try {
        string runtime = Path.Combine(root, "runtime");
        string currentHash = new string('1', 64);
        string oldHash = new string('2', 64);
        string activeHash = new string('3', 64);
        string fakeHash = new string('4', 64);
        string old = Path.Combine(runtime, oldHash);
        string active = Path.Combine(runtime, activeHash);
        string fake = Path.Combine(runtime, fakeHash);
        string unknown = Path.Combine(runtime, "user-owned");
        WriteOwnedVersion(old, oldHash, "CopilotCC");
        WriteOwnedVersion(active, activeHash, "CopilotCC");
        WriteOwnedVersion(fake, fakeHash, "OtherProduct");
        Directory.CreateDirectory(unknown);
        File.WriteAllText(Path.Combine(unknown, "keep.txt"), "keep");
        string staging = Path.Combine(runtime, ".extracting-" + oldHash + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        File.WriteAllText(Path.Combine(staging, ".copilotcc-extracting"), "CopilotCC\n" + oldHash + "\n");
        CleanupReport report = PortableRuntime.Cleanup(runtime, currentHash, p => String.Equals(p, active, StringComparison.OrdinalIgnoreCase));
        Assert(!Directory.Exists(old), "owned old version not removed");
        Assert(!Directory.Exists(staging), "owned staging not removed");
        Assert(Directory.Exists(active), "active old version removed");
        Assert(Directory.Exists(unknown), "unknown directory removed");
        Assert(Directory.Exists(fake), "foreign product directory removed");
        Assert(report.Deleted.Contains(oldHash) && report.Active.Contains(activeHash), "cleanup report inaccurate");
      } finally {
        DeleteOwnedTree(root);
      }
    }

    private static void TestTamperedCurrent() {
      string root = NewRoot();
      try {
        string hash = new string('5', 64);
        string current;
        using (var zip = NewZip(ValidFiles(), hash)) current = PortableRuntime.Prepare(root, hash, zip, null);
        File.WriteAllText(Path.Combine(current, "ccc-bridge.exe"), "tampered");
        Assert(!PortableRuntime.Verify(current, hash), "tampering was not detected");
        using (var zip = NewZip(ValidFiles(), hash)) PortableRuntime.Prepare(root, hash, zip, null);
        Assert(File.ReadAllText(Path.Combine(current, "ccc-bridge.exe")) == "bridge-v1", "tampered current not rebuilt");
      } finally {
        DeleteOwnedTree(root);
      }
    }

    private static void TestUnsafeZip() {
      string root = NewRoot();
      try {
        string hash = new string('6', 64);
        using (var zip = NewZip(ValidFiles(), hash, "../escape.txt")) {
          bool rejected = false;
          try { PortableRuntime.Prepare(root, hash, zip, null); }
          catch (InvalidDataException) { rejected = true; }
          Assert(rejected, "zip slip was accepted");
        }
        using (var zip = NewZip(ValidFiles(), hash, "unexpected.txt")) {
          bool rejected = false;
          try { PortableRuntime.Prepare(root, hash, zip, null); }
          catch (InvalidDataException) { rejected = true; }
          Assert(rejected, "unlisted file was accepted");
        }
        Assert(!File.Exists(Path.Combine(root, "escape.txt")), "unsafe entry escaped runtime");
        Assert(!Directory.GetDirectories(Path.Combine(root, "runtime"), ".extracting-*").Any(), "rejected zip left staging files");
      } finally {
        DeleteOwnedTree(root);
      }
    }

    private static void TestConcurrentPrepare() {
      string root = NewRoot();
      try {
        string hash = new string('7', 64);
        var tasks = new[] { 0, 1 }.Select(_ => Task.Run(() => {
          using (var zip = NewZip(ValidFiles(), hash)) return PortableRuntime.Prepare(root, hash, zip, null);
        })).ToArray();
        Task.WaitAll(tasks);
        Assert(tasks.All(t => t.Result == tasks[0].Result), "concurrent publishers selected different paths");
        Assert(PortableRuntime.Verify(tasks[0].Result, hash), "concurrent payload invalid");
        Assert(!Directory.GetDirectories(Path.Combine(root, "runtime"), ".extracting-*").Any(), "concurrent prepare left staging");
      } finally {
        DeleteOwnedTree(root);
      }
    }

    private static ZipArchive NewPackedZip(IDictionary<string, byte[]> files, string hash, bool invalidRange = false) {
      var unique = new Dictionary<string, long>();
      var pack = new MemoryStream();
      var descriptors = new StringBuilder();
      descriptors.Append("{\"schemaVersion\":1,\"contentPack\":\"payload-content.bin\",\"files\":[");
      bool first = true;
      foreach (var pair in files.OrderBy(p => p.Key, StringComparer.Ordinal)) {
        string key = Hash(pair.Value);
        long offset;
        if (!unique.TryGetValue(key, out offset)) {
          offset = pack.Position;
          unique.Add(key, offset);
          pack.Write(pair.Value, 0, pair.Value.Length);
        }
        if (!first) descriptors.Append(",");
        first = false;
        long chunkOffset = invalidRange ? pack.Length + 100 : offset;
        descriptors.Append("{\"path\":\"").Append(pair.Key).Append("\",\"size\":").Append(pair.Value.Length)
          .Append(",\"chunks\":[{\"offset\":").Append(chunkOffset).Append(",\"size\":").Append(pair.Value.Length).Append("}]}");
      }
      descriptors.Append("]}");
      var stream = new MemoryStream();
      using (var create = new ZipArchive(stream, ZipArchiveMode.Create, true)) {
        AddEntry(create, "payload-manifest.json", ManifestBytes(NewManifest(hash, files)));
        AddEntry(create, "payload-storage.json", Encoding.UTF8.GetBytes(descriptors.ToString()));
        AddEntry(create, "payload-content.bin", pack.ToArray());
      }
      stream.Position = 0;
      return new ZipArchive(stream, ZipArchiveMode.Read, false);
    }

    private static void TestPackedStorage() {
      string root = NewRoot();
      string invalidRoot = NewRoot();
      try {
        string hash = new string('a', 64);
        var files = ValidFiles();
        files["ccc-terminal.exe"] = files["ccc-bridge.exe"];
        using (var zip = NewPackedZip(files, hash)) {
          string current = PortableRuntime.Prepare(root, hash, zip, null);
          Assert(PortableRuntime.Verify(current, hash), "deduplicated payload failed final verification");
          Assert(File.ReadAllText(Path.Combine(current, "ccc-terminal.exe")) == "bridge-v1", "shared chunk was not reconstructed");
          Assert(!File.Exists(Path.Combine(current, "payload-storage.json")), "storage recipe leaked into runtime");
          Assert(!File.Exists(Path.Combine(current, "payload-content.bin")), "content pack leaked into runtime");
        }
        using (var zip = NewPackedZip(files, new string('b', 64), true)) {
          bool rejected = false;
          try { PortableRuntime.Prepare(invalidRoot, new string('b', 64), zip, null); }
          catch (InvalidDataException) { rejected = true; }
          Assert(rejected, "out-of-range packed chunk was accepted");
        }
      } finally {
        DeleteOwnedTree(root);
        DeleteOwnedTree(invalidRoot);
      }
    }

    private static void TestLongPathPrepare() {
      string root = Path.Combine(NewRoot(), new string('r', 150));
      try {
        string hash = new string('c', 64);
        string relative = "pty/" + new string('d', 70) + "/" + new string('f', 70) + ".js";
        var files = ValidFiles();
        files[relative] = Encoding.UTF8.GetBytes("long-path-content\n");
        string current;
        using (var zip = NewPackedZip(files, hash)) current = PortableRuntime.Prepare(root, hash, zip, null);
        Assert(!current.StartsWith(@"\\?\"), "extended IO path leaked to the child process");
        Assert(PortableRuntime.Verify(current, hash), "long-path payload failed verification");
        string file = @"\\?\" + Path.Combine(current, relative.Replace('/', Path.DirectorySeparatorChar));
        Assert(File.ReadAllText(file) == "long-path-content\n", "long-path file was not reconstructed");
      } finally {
        DeleteOwnedTree(@"\\?\" + root);
      }
    }

    private static void TestJunctionPreserved() {
      string root = NewRoot();
      try {
        string runtime = Path.Combine(root, "runtime");
        string oldHash = new string('8', 64);
        string old = Path.Combine(runtime, oldHash);
        WriteOwnedVersion(old, oldHash, "CopilotCC");
        string external = Path.Combine(root, "external");
        Directory.CreateDirectory(external);
        File.WriteAllText(Path.Combine(external, "keep.txt"), "keep");
        string link = Path.Combine(old, "linked");
        var start = new ProcessStartInfo("cmd.exe", "/d /c mklink /J \"" + link + "\" \"" + external + "\"") {
          CreateNoWindow = true, UseShellExecute = false,
        };
        using (var process = Process.Start(start)) {
          process.WaitForExit();
          Assert(process.ExitCode == 0, "could not create test junction");
        }
        CleanupReport report = PortableRuntime.Cleanup(runtime, new string('9', 64), _ => false);
        Assert(Directory.Exists(old), "directory containing junction was recursively removed");
        Assert(File.Exists(Path.Combine(external, "keep.txt")), "junction target was touched");
        Assert(report.Skipped.Contains(oldHash), "junction skip not reported");
      } finally {
        DeleteOwnedTree(root);
      }
    }
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);

describe("仓库检查门禁", () => {
  it("CI 与 Release 都检查生成副本、文档和项目脚本", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toMatch(/run: npm run check$/m);
    }
  });
});

/**
 * 读取 Release 工作流中的 artifact 下载步骤配置。
 * @returns 每个 actions/download-artifact 步骤的 YAML 文本。
 */
function artifactDownloadSteps(): string[] {
  return (releaseWorkflow.split("  publish:")[1] ?? "")
    .split("- uses: actions/download-artifact@v4")
    .slice(1)
    .map((step) => step.split("\n      - ")[0]);
}

describe("Release artifact 汇总", () => {
  it("按三个固定名称下载公开资产，不使用多行 Minimatch pattern", () => {
    const steps = artifactDownloadSteps();
    const names = steps.map((step) => step.match(/^\s+name: (\S+)$/m)?.[1]);

    expect(names.sort()).toEqual(["bridge-mac", "bridge-win", "extension"]);
    for (const step of steps) {
      expect(step).not.toMatch(/^\s+pattern:/m);
      expect(step).toMatch(/^\s+path: assets$/m);
      expect(step).toMatch(/^\s+merge-multiple: true$/m);
    }
  });
});

describe("最终 Windows 发行产物验收", () => {
  it("Release 用最终单文件和解压后的扩展 zip 跑真实 Chrome", () => {
    const buildWin = releaseWorkflow.split("  build-win:")[1]?.split("\n  build-mac:")[0] ?? "";
    expect(buildWin).toContain("needs: [test, build-ext]");
    expect(buildWin).toMatch(/name: extension\n\s+path: \$\{\{ runner\.temp \}\}\/ccc-release-extension/);
    expect(buildWin).toMatch(
      /C:\/Windows\/System32\/tar\.exe" -xf .*ccc-release-extension.*-chrome\.zip.*chrome-mv3/,
    );
    expect(buildWin).toMatch(/node scripts\/verify-embedded-terminal\.mjs \\\n\s+--root [^\n]+ --portable$/m);
  });

  it("CI 的 Windows 门禁同样运行最终单文件真实 Chrome", () => {
    expect(ciWorkflow).toMatch(/name: Windows：最终绿色单文件与扩展真实 Chrome 离线验收[\s\S]*?node scripts\/verify-embedded-terminal\.mjs \\\n\s+--root [^\n]+ --portable/);
  });
});

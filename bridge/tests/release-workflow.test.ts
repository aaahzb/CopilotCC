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

/**
 * 读取 Release 工作流中的 artifact 下载步骤配置。
 * @returns 每个 actions/download-artifact 步骤的 YAML 文本。
 */
function artifactDownloadSteps(): string[] {
  return releaseWorkflow
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

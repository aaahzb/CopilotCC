import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { localApprovedVerificationRoot, resolvePortableVerificationRoot } from "../scripts/verification-root.mjs";

const base = path.resolve(os.tmpdir(), "ccc-portable-root-policy");
const localApprovedRoot = path.join(base, "approved");
const runnerTemp = path.join(base, "runner-temp");
const projectRoot = path.join(base, "project");

/** 构造纯路径策略参数。 @param githubActions 是否模拟 GitHub Actions。 @returns 解析参数。 */
function options(githubActions = false): {
  localApprovedRoot: string;
  runnerTemp: string;
  projectRoot: string;
  githubActions: boolean;
} {
  return { localApprovedRoot, runnerTemp, projectRoot, githubActions };
}

describe("本机验收批准根目录配置", () => {
  it("CCC_VERIFY_ROOT 显式指定绝对批准目录", () => {
    expect(localApprovedVerificationRoot({ CCC_VERIFY_ROOT: localApprovedRoot })).toBe(localApprovedRoot);
  });

  it("拒绝依赖当前工作目录的相对批准目录", () => {
    expect(() => localApprovedVerificationRoot({ CCC_VERIFY_ROOT: "relative/approved" })).toThrow("绝对路径");
  });
});

describe("绿色单文件生命周期验收根目录", () => {
  it("本机只接受原批准目录的严格子目录", () => {
    const requested = path.join(localApprovedRoot, "new-empty-run");
    expect(resolvePortableVerificationRoot(requested, options())).toBe(requested);
    expect(() => resolvePortableVerificationRoot(localApprovedRoot, options())).toThrow("严格位于");
    expect(() => resolvePortableVerificationRoot(path.join(base, "other"), options())).toThrow("批准目录");
  });

  it("只有 GitHub Actions 才允许 RUNNER_TEMP 的严格子目录", () => {
    const requested = path.join(runnerTemp, "portable-verify");
    expect(resolvePortableVerificationRoot(requested, options(true))).toBe(requested);
    expect(() => resolvePortableVerificationRoot(requested, options(false))).toThrow("批准目录");
    expect(() => resolvePortableVerificationRoot(runnerTemp, options(true))).toThrow("严格位于");
  });

  it("项目树、缺失参数和 approved 下的项目目录均拒绝", () => {
    expect(() => resolvePortableVerificationRoot("", options(true))).toThrow("必须");
    expect(() => resolvePortableVerificationRoot(path.join(projectRoot, "verify"), options(true))).toThrow("项目树");
    const nestedProject = path.join(localApprovedRoot, "project");
    expect(() => resolvePortableVerificationRoot(path.join(nestedProject, "verify"), {
      ...options(), projectRoot: nestedProject,
    })).toThrow("项目树");
  });
});

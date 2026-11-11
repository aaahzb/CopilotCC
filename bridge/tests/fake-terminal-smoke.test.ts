import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcessWithoutNullStreams>();
const tempDirs: string[] = [];

/** 等待子进程输出包含指定文本，超时时只报告阶段，不输出环境。 */
function waitForText(output: () => string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (output().includes(text)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`等待 ${text} 超时`));
      }
    }, 20);
  });
}

afterEach(async () => {
  for (const child of children) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  }
  children.clear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("隔离假 CLI 的 PTY 冒烟模式", () => {
  it("ECHO 返回中文、持续产生 tick，EXIT 使用退出码 7", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-fake-smoke-test-"));
    tempDirs.push(configDir);
    const script = path.resolve("scripts/fake-terminal-claude.ts");
    const child = spawn(process.execPath, [script], {
      cwd: configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CCC_PTY_SMOKE_MODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    await waitForText(() => output, "SIZE:");
    child.stdin.write("ECHO\n");
    await waitForText(() => output, "中文输出:你好");
    await waitForText(() => output, "TICK:5");
    child.stdin.write("EXIT\n");
    await expect(exited).resolves.toBe(7);
    children.delete(child);
  }, 15_000);
});

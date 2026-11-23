import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("用法: npm run verify\n\n依次检查生成副本、Markdown 链接、脚本测试、两端类型、两端单测和扩展生产构建。");
  process.exit(0);
}

if (process.argv.length > 2) {
  console.error(`未知参数: ${process.argv.slice(2).join(", ")}\n用法: npm run verify`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const command = windows ? process.env.ComSpec || "cmd.exe" : "npm";
const commandPrefix = windows ? ["/d", "/s", "/c", "npm"] : [];
const steps = [
  ["项目检查", ["run", "check"]],
  ["类型检查", ["run", "typecheck"]],
  ["单元测试", ["test"]],
  ["扩展生产构建", ["run", "build"]],
];

for (const [name, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(command, [...commandPrefix, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${name}无法启动: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${name}失败，退出码 ${result.status ?? "未知"}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n全部验证通过");

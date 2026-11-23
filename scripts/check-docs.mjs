import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("用法: node scripts/check-docs.mjs [Markdown 文件...]\n\n未指定文件时检查当前工作树中全部未忽略的 Markdown 文件（含未跟踪文件）。只检查本地文件链接。");
  process.exit(0);
}

const root = args.length > 0 ? process.cwd() : projectRoot;
const files = args.length > 0
  ? args
  : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((file) => file && existsSync(path.resolve(root, file)));
const broken = [];
const linkPattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

for (const file of files) {
  const absoluteFile = path.resolve(root, file);
  const markdown = readFileSync(absoluteFile, "utf8");
  const lines = markdown.split(/\r?\n/);
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      return;
    }
    const prose = line.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(linkPattern)) {
      const target = match[1] ?? match[2];
      if (!target || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) {
        continue;
      }
      const localPath = target.split("#", 1)[0];
      if (!localPath) {
        continue;
      }
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(localPath);
      } catch {
        broken.push(`${file}:${index + 1} 链接编码无效 → ${target}`);
        continue;
      }
      const resolved = decodedPath.startsWith("/")
        ? path.join(root, decodedPath)
        : path.resolve(path.dirname(absoluteFile), decodedPath);
      if (!existsSync(resolved)) {
        broken.push(`${file}:${index + 1} 目标不存在 → ${target}`);
      }
    }
  });
}

if (broken.length > 0) {
  console.error(broken.join("\n"));
  console.error(`发现 ${broken.length} 个失效的本地链接`);
  process.exitCode = 1;
} else {
  console.log(`已检查 ${files.length} 个 Markdown 文件，本地链接均存在`);
}

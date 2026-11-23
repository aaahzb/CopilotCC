import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ccc-check-docs-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "target.md"), "# Target\n", "utf8");
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

test("接受存在的相对链接、图片、锚点和外部链接", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "README.md"),
    "[指南](docs/target.md#安装)\n![图片](docs/target.md)\n[外部](https://example.com)\n[锚点](#本地)\n",
    "utf8",
  );
  const result = run(root, ["README.md"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 个 Markdown 文件/);
});

test("报告失效链接的文件、行号和目标", (t) => {
  const root = createFixture(t);
  writeFileSync(path.join(root, "README.md"), "# Test\n\n[缺失](docs/missing.md)\n", "utf8");
  const result = run(root, ["README.md"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:3/);
  assert.match(result.stderr, /docs\/missing\.md/);
});

test("忽略行内代码和代码块中的链接示例", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "README.md"),
    "`[示例](missing-inline.md)`\n```md\n[示例](missing-block.md)\n```\n[真实](docs/target.md)\n",
    "utf8",
  );
  const result = run(root, ["README.md"]);
  assert.equal(result.status, 0, result.stderr);
});

test("默认检查当前工作树中的新文档并跳过已移走的旧路径", (t) => {
  const root = createFixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "[新文档](docs/new.md)\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  rmSync(path.join(root, "docs", "target.md"));
  writeFileSync(path.join(root, "docs", "new.md"), "[缺失](missing.md)\n", "utf8");

  mkdirSync(path.join(root, "scripts"));
  const fixtureScript = path.join(root, "scripts", "check-docs.mjs");
  copyFileSync(script, fixtureScript);
  const result = spawnSync(process.execPath, [fixtureScript], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/new\.md:1/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("从其他目录调用时仍按脚本所在项目解析默认文件", (t) => {
  const root = createFixture(t);
  const result = run(root, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /当前工作树/);
});

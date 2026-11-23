import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./sync-protocol.mjs", import.meta.url));
const sharedFiles = ["protocol.ts", "pairing.ts", "upload-note.ts"];
const destinations = sharedFiles.flatMap((file) => [
  `bridge/src/${file}`,
  `extension/src/lib/${file}`,
]);

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ccc-sync-protocol-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  const script = path.join(root, "scripts", "sync-protocol.mjs");
  copyFileSync(sourceScript, script);
  for (const file of sharedFiles) {
    writeFileSync(path.join(root, "shared", file), `// ${file}\n`, "utf8");
  }
  return { root, script };
}

function run(root, script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("默认模式把共享文件同步到两端", (t) => {
  const { root, script } = createFixture(t);
  const result = run(root, script);
  assert.equal(result.status, 0, result.stderr);
  for (const file of sharedFiles) {
    const expected = readFileSync(path.join(root, "shared", file), "utf8");
    for (const destination of destinations.filter((item) => item.endsWith(`/${file}`))) {
      assert.equal(readFileSync(path.join(root, destination), "utf8"), expected);
    }
  }
});

test("--check 在副本一致时通过且不写入", (t) => {
  const { root, script } = createFixture(t);
  assert.equal(run(root, script).status, 0);
  const before = destinations.map((file) => readFileSync(path.join(root, file)));
  const result = run(root, script, ["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(destinations.map((file) => readFileSync(path.join(root, file))), before);
});

test("--check 报告漂移并保留现场", (t) => {
  const { root, script } = createFixture(t);
  assert.equal(run(root, script).status, 0);
  const drifted = path.join(root, "bridge/src/protocol.ts");
  writeFileSync(drifted, "// local drift\n", "utf8");
  const result = run(root, script, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /bridge\/src\/protocol\.ts/);
  assert.equal(readFileSync(drifted, "utf8"), "// local drift\n");
});

test("--help 只显示用法", (t) => {
  const { root, script } = createFixture(t);
  const result = run(root, script, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--check/);
  assert.equal(run(root, script, ["--unknown"]).status, 2);
});

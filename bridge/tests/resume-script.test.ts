/** 续聊脚本：命名清洗、内容形态、幂等写入、标记防误删 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RESUME_SCRIPT_MARKER, resumeScriptBatContent, resumeScriptBatName, resumeScriptContent, resumeScriptName, removeResumeScript, writeResumeScript } from "../src/resume-script";

describe("resumeScriptName 命名清洗", () => {
  it("非法字符与控制字符替换为 -", () => {
    expect(resumeScriptName("a<b")).toBe("继续聊天-a-b.sh");
    expect(resumeScriptName("x\x01y")).toBe("继续聊天-x-y.sh");
    expect(resumeScriptName("含中文 别名")).toBe("继续聊天-含中文 别名.sh");
  });

  it("首尾空白/点裁掉；空名回退未命名；别名部分 60 字符截断", () => {
    expect(resumeScriptName("  .x.  ")).toBe("继续聊天-x.sh");
    expect(resumeScriptName("")).toBe("继续聊天-未命名.sh");
    expect(resumeScriptName("   ")).toBe("继续聊天-未命名.sh");
    expect(resumeScriptName("长".repeat(80))).toBe(`继续聊天-${"长".repeat(60)}.sh`);
  });
});

describe("resumeScriptContent 内容形态", () => {
  it("有会话：cd 到脚本所在目录并 exec claude --resume", () => {
    const c = resumeScriptContent("我的项目", "sess-1");
    expect(c).toContain(RESUME_SCRIPT_MARKER);
    expect(c).toContain('cd "$(dirname "$0")"');
    expect(c).toContain('exec claude --resume "sess-1"');
  });

  it("无会话：提示并 exit 1，不含续聊命令", () => {
    const c = resumeScriptContent("我的项目", null);
    expect(c).toContain(RESUME_SCRIPT_MARKER);
    expect(c).not.toContain("claude --resume");
    expect(c).toContain("exit 1");
  });
});

describe("writeResumeScript / removeResumeScript", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-script-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("成对写入 .sh 与 .bat；返回当前平台可直跑的文件名；同内容二次调用幂等不重写", () => {
    const name = writeResumeScript(dir, "测试", "s1");
    expect(name).toBe(process.platform === "win32" ? "继续聊天-测试.bat" : "继续聊天-测试.sh"); // 界面闪示用户能直接跑的那个
    const sh = path.join(dir, "继续聊天-测试.sh");
    const bat = path.join(dir, "继续聊天-测试.bat");
    expect(fs.readFileSync(sh, "utf-8")).toContain('exec claude --resume "s1"');
    expect(fs.readFileSync(bat, "utf-8")).toContain('claude --resume "s1"');
    const m1 = fs.statSync(sh).mtimeMs;
    const m2 = fs.statSync(bat).mtimeMs;
    expect(writeResumeScript(dir, "测试", "s1")).toBe(name);
    expect(fs.statSync(sh).mtimeMs).toBe(m1); // 内容没变没重写
    expect(fs.statSync(bat).mtimeMs).toBe(m2);
  });

  it("文件夹不存在返回 null 不抛异常", () => {
    expect(writeResumeScript(path.join(dir, "nope"), "x", null)).toBeNull();
  });

  it("删脚本：带标记的删；无标记同名文件保留；不存在返回 false", () => {
    writeResumeScript(dir, "测试", "s1");
    expect(removeResumeScript(dir, "测试")).toBe(true);
    expect(fs.existsSync(path.join(dir, "继续聊天-测试.sh"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "继续聊天-测试.bat"))).toBe(false); // 成对删除
    // 用户手写同名文件（无生成标记）绝不动
    fs.writeFileSync(path.join(dir, "继续聊天-手写.sh"), "# 我自己的脚本\n", "utf-8");
    expect(removeResumeScript(dir, "手写")).toBe(false);
    expect(fs.existsSync(path.join(dir, "继续聊天-手写.sh"))).toBe(true);
    expect(removeResumeScript(dir, "不存在")).toBe(false);
  });
});

describe("resumeScriptBatName / resumeScriptBatContent（Windows 批处理）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-script-bat-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bat 命名与 sh 同主干", () => {
    expect(resumeScriptBatName("a<b")).toBe("继续聊天-a-b.bat");
    expect(resumeScriptBatName("")).toBe("继续聊天-未命名.bat");
  });

  it("有会话：chcp 65001 防乱码 + cd /d 到脚本目录 + claude --resume（CRLF 行尾）", () => {
    const c = resumeScriptBatContent("我的项目", "sess-1");
    expect(c).toContain(RESUME_SCRIPT_MARKER);
    expect(c).toContain("chcp 65001");
    expect(c).toContain('cd /d "%~dp0"');
    expect(c).toContain('claude --resume "sess-1"');
    expect(c).toContain("\r\n");
  });

  it("无会话：提示并 exit /b 1（不关用户终端窗口），不含续聊命令", () => {
    const c = resumeScriptBatContent("我的项目", null);
    expect(c).toContain(RESUME_SCRIPT_MARKER);
    expect(c).not.toContain("claude --resume");
    expect(c).toContain("exit /b 1");
  });

  it("bat 同受生成标记保护：无标记同名 bat 不删", () => {
    fs.writeFileSync(path.join(dir, "继续聊天-手写.bat"), "@echo off\r\nrem 我自己的\r\n", "utf-8");
    expect(removeResumeScript(dir, "手写")).toBe(false);
    expect(fs.existsSync(path.join(dir, "继续聊天-手写.bat"))).toBe(true);
  });
});

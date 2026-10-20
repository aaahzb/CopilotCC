/** 单实例守卫：runtime.json 记录 {pid, port}——入口启动前查、启动后写、退出时删 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 运行态信息（~/.ccc-bridge/runtime.json） */
export interface RuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * runtime.json 路径。
 * @param dir 配置目录
 * @returns runtime.json 绝对路径
 */
function runtimePath(dir: string): string {
  return path.join(dir, "runtime.json");
}

/**
 * 进程是否存活。EPERM 也算活：进程存在但当前用户无权发信号。
 * @param pid 进程号
 * @returns 存活与否
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 启动前抢占实例位：若 runtime.json 记录的其他进程仍存活则抛错；否则写入占位记录
 * （端口此时未知，启动成功后由 writeRuntime 补写）。同进程重复 claim 不视为冲突（测试场景）。
 * @param dir 配置目录
 * @throws 已有存活实例时抛错（消息含 PID 与端口）
 */
export function claimInstance(dir: string): void {
  const p = runtimePath(dir);
  let info: Partial<RuntimeInfo> | null = null;
  try {
    info = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<RuntimeInfo>;
  } catch {
    info = null; // 文件不存在或损坏：直接接管
  }
  if (info && typeof info.pid === "number" && info.pid !== process.pid && isPidAlive(info.pid)) {
    throw new Error(`已有 ccc-bridge 实例在运行（PID ${info.pid}，端口 ${info.port ?? "?"}）。托盘右键→退出，或结束该进程后再启动。`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, port: 0, startedAt: new Date().toISOString() } satisfies RuntimeInfo), "utf-8");
}

/**
 * 启动成功后补写实际端口。
 * @param dir 配置目录
 * @param port 实际监听端口
 */
export function writeRuntime(dir: string, port: number): void {
  fs.writeFileSync(runtimePath(dir), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() } satisfies RuntimeInfo), "utf-8");
}

/**
 * 退出时删除 runtime.json——仅当记录里的 pid 是自己才删，防止误删新实例的记录。
 * @param dir 配置目录
 */
export function releaseRuntime(dir: string): void {
  const p = runtimePath(dir);
  try {
    const info = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<RuntimeInfo>;
    if (info.pid === process.pid) fs.rmSync(p, { force: true });
  } catch {
    // 文件不存在或损坏就算了
  }
}

/**
 * 注册退出清理钩子（exit / SIGINT / SIGTERM）。
 * @param dir 配置目录
 */
export function releaseRuntimeOnExit(dir: string): void {
  process.on("exit", () => releaseRuntime(dir));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      releaseRuntime(dir);
      process.exit(0);
    });
  }
}

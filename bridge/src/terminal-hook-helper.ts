import { UUID_RE } from "./protocol";
import { readHookJson } from "./terminal-hooks";

export interface HookHelperDeps {
  stdin: NodeJS.ReadableStream;
  // ProcessEnv 的值本就允许缺失；运行时再统一拒绝空配置，避免 Pick 把键误标为必存在。
  env: {
    CCC_TERMINAL_HOOK_URL?: string | undefined;
    CCC_TERMINAL_HOOK_TOKEN?: string | undefined;
  };
  fetchImpl?: typeof fetch;
}

/**
 * 将旧版 CLI command Hook 的 stdin 原样转发到本次 lease 的回环端点。
 * @param deps 私有 stdin、环境和可注入 fetch
 * @throws 配置非法、请求超限或回环响应非 2xx 时抛出固定错误，不输出秘密
 */
export async function runTerminalHookHelper(deps: HookHelperDeps): Promise<void> {
  const body = await readHookJson(deps.stdin);
  let url: URL;
  try {
    url = new URL(deps.env.CCC_TERMINAL_HOOK_URL ?? "");
  } catch {
    throw new Error("HOOK_HELPER_CONFIG");
  }
  const token = deps.env.CCC_TERMINAL_HOOK_TOKEN;
  const pathMatch = /^\/terminal-hook\/([0-9a-f-]+)$/.exec(url.pathname);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || !pathMatch || !UUID_RE.test(pathMatch[1]!) || !token) {
    throw new Error("HOOK_HELPER_CONFIG");
  }
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw new Error(`HOOK_HTTP_${response.status}`);
}

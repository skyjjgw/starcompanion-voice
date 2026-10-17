// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors
import type { ComposeDslContext, ComposeNode } from "@operit/compose-dsl";
import { createDefaultHostService } from "../host-service";

const PAGE_URL = "https://voice.skymoni.local/";
type Request = Record<string, unknown>;
type Response = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } };
interface Lifetime { ended: boolean; callIds: Set<string>; pendingOpens: Set<Promise<Response>>; }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function failure(code: string, message: string): Response {
  return { ok: false, error: { code, message, retryable: false } };
}
function identity(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Owns one foreground WebView and closes every call it attempted to open. */
export default function screen(ctx: ComposeDslContext): ComposeNode {
  const controller = ctx.createWebViewController("starcompanion-voice");
  const [presentation] = ctx.useState<unknown>("presentation", null);
  const input = record(presentation) && record(presentation.input) ? presentation.input : null;
  const chatId = input === null ? null : identity(input.chatId);
  const requestId = record(presentation) ? identity(presentation.requestId) : null;
  const lifetime = ctx.useRef<Lifetime>("voice-lifetime", { ended: false, callIds: new Set(), pendingOpens: new Set() });
  const service = ctx.useRef<ReturnType<typeof createDefaultHostService> | null>("voice-service", null);
  if (service.current === null) service.current = createDefaultHostService();
  const [path, setPath] = ctx.useState("voice-path", "");
  const [error, setError] = ctx.useState("voice-error", "");
  const [busy, setBusy] = ctx.useState("voice-exiting", false);

  async function send(payload: Request): Promise<Response> {
    // The foreground screen lease retains service state. A main IPC call gets a transient engine.
    // Chat submission still uses its own original CHAT runtime through the existing SDK.
    return service.current!.receive(payload);
  }
  async function closeCall(callId: string): Promise<void> {
    const result = await send({ op: "close", callId });
    if (!result.ok && result.error.code !== "CALL_CLOSED") throw new Error(result.error.message);
    lifetime.current.callIds.delete(callId);
  }
  async function closeTracked(): Promise<void> {
    const tracked = [...lifetime.current.callIds];
    // Begin invalidation before the first await: disposal may release the screen engine immediately.
    // The service also tombstones opens that are still waiting for host configuration.
    const firstPass = Promise.allSettled(tracked.map(closeCall));
    await Promise.allSettled([...lifetime.current.pendingOpens]);
    await firstPass;
    const remaining = [...new Set([...tracked, ...lifetime.current.callIds])];
    const results = await Promise.allSettled(remaining.map(closeCall));
    if (results.some(result => result.status === "rejected")) {
      throw new Error("关闭通话未获确认，请再次点击挂断；已提交的聊天回复仍可能继续。");
    }
  }
  async function stopPage(): Promise<void> {
    try {
      await controller.evaluateJavascript("window.StarCompanionCall?.hangup(); true;");
    } catch (_error) {
      // Native close remains available even when the bundled page did not load.
    }
  }
  async function request(...args: unknown[]): Promise<Response> {
    // Page API is StarVoice.request([payload]); the host passes JS arguments as one array.
    const jsArguments = args[0];
    if (args.length !== 1 || !Array.isArray(jsArguments) || jsArguments.length !== 1 ||
        !Array.isArray(jsArguments[0]) || jsArguments[0].length !== 1 || !record(jsArguments[0][0])) {
      return failure("INVALID_UI_REQUEST", "语音请求格式无效。");
    }
    const payload = jsArguments[0][0];
    if (lifetime.current.ended) return failure("UI_CLOSED", "通话页面已关闭。");
    if (payload.op === "bootstrap") {
      try {
        return await send(chatId === null ? { op: "inspect", listChats: true } : { op: "inspect", chatId, listChats: false });
      } catch (_error) {
        return failure("VOICE_IPC_FAILED", "语音服务暂时不可用，请挂断后重试。");
      }
    }
    const callId = identity(payload.callId);
    if (payload.op === "open") {
      if (chatId !== null && payload.chatId !== chatId) {
        return failure("CALL_CHAT_MISMATCH", "通话只能使用当前聊天，请关闭后从目标聊天重新进入。");
      }
      if (callId === null || !/^[A-Za-z0-9._:-]{1,128}$/.test(callId)) return failure("INVALID_UI_REQUEST", "通话标识无效。");
      // Track before awaiting: closing the screen must cover an in-flight open request.
      lifetime.current.callIds.add(callId);
    } else if (callId !== null && !lifetime.current.callIds.has(callId)) {
      return failure("CALL_NOT_OWNED", "此通话不属于当前页面。");
    }
    const operation = send(payload);
    if (payload.op === "open") lifetime.current.pendingOpens.add(operation);
    try {
      const response = await operation;
      if (payload.op === "open" && !response.ok && callId !== null) lifetime.current.callIds.delete(callId);
      if (payload.op === "close" && response.ok && callId !== null) lifetime.current.callIds.delete(callId);
      if (lifetime.current.ended && payload.op === "open" && callId !== null) {
        await closeCall(callId);
        return failure("UI_CLOSED", "通话页面已关闭。");
      }
      return response;
    } catch (_error) {
      if (lifetime.current.ended && payload.op === "open" && callId !== null) {
        void closeCall(callId).catch(() => {});
      }
      return failure("VOICE_IPC_FAILED", "语音服务暂时不可用，请挂断后重试。");
    } finally {
      lifetime.current.pendingOpens.delete(operation);
    }
  }
  async function initialize(): Promise<void> {
    try {
      controller.addJavascriptInterface("StarVoice", { request });
      const resource = await ToolPkg.readResource("voice_web", "voice.html");
      if (!lifetime.current.ended) setPath(resource);
    } catch (_error) {
      if (!lifetime.current.ended) setError("通话页面加载失败，请挂断并返回。");
    }
  }
  ctx.useEffect("voice-cleanup", () => () => {
    lifetime.current.ended = true;
    void stopPage();
    void closeTracked().catch(() => {});
  }, []);

  async function hangup(): Promise<ToolPkg.JsonValue> {
    if (busy) return null;
    setBusy(true);
    lifetime.current.ended = true;
    await stopPage();
    try {
      await closeTracked();
      if (requestId === null) throw new Error("缺少会话窗口标识，请从聊天菜单重新进入。");
      return { type: "toolpkg.presentation.cancel", requestId };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "关闭通话失败，请再次挂断。");
      setBusy(false);
      return null;
    }
  }

  return ctx.UI.Column({ fillMaxSize: true, onLoad: initialize }, [
    ctx.UI.Box({ fillMaxWidth: true, weight: 1 }, path === ""
      ? ctx.UI.Text({ text: error || "正在加载语音通话…", padding: 16 })
      : ctx.UI.WebView({ key: "starcompanion-voice-page", controller, fillMaxSize: true,
        url: PAGE_URL, javaScriptEnabled: true, domStorageEnabled: false, supportZoom: false,
        mediaPlaybackRequiresUserGesture: false,
        onShouldOverrideUrlLoading: navigation => navigation.url === PAGE_URL ? { action: "allow" } : { action: "cancel" },
        onInterceptRequest: resource => resource.url === PAGE_URL
          ? { action: "respond", response: { mimeType: "text/html", encoding: "utf-8", statusCode: 200,
            reasonPhrase: "OK", filePath: path } }
          : { action: "block" },
      })),
    ctx.UI.Column({ fillMaxWidth: true, padding: 10, spacing: 6 }, [
      ...(error === "" ? [] : [ctx.UI.Text({ text: error, style: "bodySmall", color: ctx.MaterialTheme.colorScheme.error })]),
      ctx.UI.Text({ text: "单角色前台通话 · 离开将停止收音，已发送的回复可能继续", style: "labelSmall",
        color: ctx.MaterialTheme.colorScheme.onSurfaceVariant }),
      ctx.UI.Button({ text: busy ? "正在挂断…" : "挂断并返回", fillMaxWidth: true, enabled: !busy, onClick: hangup }),
    ]),
  ]);
}

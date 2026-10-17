// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors
import type { ComposeDslContext, ComposeNode } from "@operit/compose-dsl";

const CALL_ROUTE = "toolpkg:com.skymoni.voice_calls:ui:call";

/** Carries the exact current chat, including an explicit unselected state. */
export default function menu(ctx: ComposeDslContext): ComposeNode {
  const [hostChatId] = ctx.useState<unknown>("chatId", null);
  const chatId = typeof hostChatId === "string" && hostChatId.trim() !== "" ? hostChatId : null;
  return ctx.UI.Row({ fillMaxWidth: true, paddingHorizontal: 12, paddingVertical: 10, spacing: 10,
    verticalAlignment: "center",
    onClick: () => ({ type: "toolpkg.ui.present", routeId: CALL_ROUTE, input: { chatId } }),
  }, [
    ctx.UI.Icon({ name: "Call", size: 24, tint: ctx.MaterialTheme.colorScheme.primary }),
    ctx.UI.Column({ weight: 1 }, [
      ctx.UI.Text({ text: "语音通话", style: "bodyMedium" }),
      ctx.UI.Text({ text: chatId === null ? "选择会话后开始 · 仅前台" : "与当前角色通话 · 仅前台",
        style: "bodySmall", color: ctx.MaterialTheme.colorScheme.onSurfaceVariant }),
    ]),
    ctx.UI.Icon({ name: "ChevronRight", size: 20, tint: ctx.MaterialTheme.colorScheme.onSurfaceVariant }),
  ]);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors
import screen from "./ui/screen.ui.js";
import menu from "./ui/menu.ui.js";

const CALL_ROUTE = "toolpkg:com.skymoni.voice_calls:ui:call";
const MENU_ROUTE = "toolpkg:com.skymoni.voice_calls:ui:menu";

/** Uses the host's existing chat menu and generic presentation contract. */
export function registerToolPkg(): boolean {
  ToolPkg.registerUiRoute({ id: "call", route: CALL_ROUTE, screen, runtime: "compose_dsl", keepAlive: false,
    title: { zh: "星伴语音通话", en: "Voice call" } });
  ToolPkg.registerUiRoute({ id: "menu", route: MENU_ROUTE, screen: menu, runtime: "compose_dsl", keepAlive: false,
    title: { zh: "语音通话", en: "Voice call" } });
  ToolPkg.registerNavigationEntry({ id: "voice-call", route: MENU_ROUTE, surface: "chat_input_menu",
    title: { zh: "语音通话", en: "Voice call" }, icon: "Call", order: 80, params: {} });
  return true;
}

# 先设计，再集成

日常界面迭代在 `design/voice-preview` 分支进行。复用 `web/` 的同一份 HTML、CSS 和组件，使用本机模拟对话预览；设计确认后再合并、接真实服务和打包内测。

```powershell
cd E:/zzz/starcompanion-voice/operit2-plugin
npm run preview
```

打开 http://127.0.0.1:18770。只需要已有 Node.js，不需要 npm install、Operit SDK、Android 模拟器或模型账号。修改界面后约一秒自动刷新；支持角色、完整手机／通话小窗口、聆听／回复／播放／静音／异常／结束状态。键盘输入可演示一轮模拟回复；它不是实际模型或语音验证。HTTP 服务只监听本机回环，禁用麦克风和摄像头，不保存聊天或录音。

需要换端口时运行 `npm run preview -- --port 18771`；终端按 Ctrl+C 停止。

日常只检查这次改到的预览或组件。`npm run preview:check` 做两个轻量 HTTP 检查，不会打包。GitHub 同步设计分支，现有维护分支的完整打包流水线不会由该分支触发。确定设计并准备集成时，再做必要的 SDK、真实服务和 Android 检查。

预览控制和模拟数据均在 `preview/`，该目录不会被正式 ToolPkg 构建收录；模拟适配器只由本机预览服务注入。正式插件依旧使用真实 Operit 桥接。

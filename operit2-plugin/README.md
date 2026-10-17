# 星伴语音通话 · Operit2 插件

独立 ToolPkg 插件，包 ID `com.skymoni.voice_calls`，API `2.0.0`。给现有聊天增加「语音通话」入口和前台通话页面，不改 Operit2 主程序。

本目录是原创 MIT 插件。仓库原有耳畔 erpan Android 应用、Operit 1.12.2 适配器及其许可证保留，不能把旧适配器直接当作 Operit2 插件使用。

## 功能与边界

- 在当前单角色对话中识别短句 → 通过原聊天引擎回复 → 合成音频并播放；聊天继续使用该对话的角色、模型、工具和记忆。
- 首版每轮只调用一次 `Tools.Chat.sendMessage`，拿到完整的真实完成凭据后显示回复并朗读。当前宿主的流式观察器在结束阶段有兼容问题，因此本版不提供逐字生成字幕，也不在失败后自动补发。
- 声音锁定为开通话时的全局 TTS，或本次手动选择的配置。不自动读取角色私有 TTS，不使用独立的 VOICE 提示词模式。
- Web Audio 收音，单声道 PCM16 WAV、16 kHz、单句最多 15 秒。使用能量阈值分句、浏览器回声消除和降噪请求；复杂噪声及扬声器回声效果需要真机验证。
- 支持字幕、静音、键盘输入、停止播放并取消本插件发起的聊天回复。打断或关闭会丢弃迟到结果；STT/TTS 服务端没有取消接口，已发出的服务请求可能继续。
- 仅在通话页面前台工作，离开页面会结束。没有后台或锁屏通话、系统来电界面、音频设备强制切换；群聊需明确参与人，当前版本不支持。

## 安装与配置

1. 使用支持 ToolPkg API 2.0 的 Operit2／星伴版本，在插件管理中导入构建出的 `.toolpkg` 并启用。
2. 在应用设置中配置可用的聊天模型与 STT，确认 TTS 可用。本次 Android 测试已使用默认系统 TTS 合成并播放 WAV，无需另建 TTS 账号。其他 TTS 需要支持返回 WAV、MP3 等编码音频；不同系统引擎仍需验证，未知参数的裸 PCM 不支持。
3. 打开已有的单角色聊天，从输入菜单进入「语音通话」，选择声音并点击开始。
4. 首次需要你主动在 Android 中允许应用使用麦克风。插件不能代为授予权限。也可先使用键盘输入验证角色回复和音频播放。
5. 点击页面下方原生「挂断并返回」关闭通话。

音频和文字由你在应用内选择的识别、聊天及合成服务处理。插件不内置服务账号、密钥或第三方中转；不会将原始服务配置或密钥传给网页，也不保存录音文件。

## 构建与测试

需要 Node.js 22+、TypeScript、esbuild，以及官方 Operit2 源码里的 SDK 类型和 Compose 编译工具。默认查找相邻目录 `starcompanion-operit2`；可用 `OPERIT2_SOURCE` 指定源码路径。已验证的 SDK 基线是 `AAswordman/Operit2` 的 `e592f9b3da1a601fd219f2d2be7b4e4ed75d3149`。

```sh
cd operit2-plugin
npm install
OPERIT2_SOURCE=/path/to/Operit2 node scripts/build.mjs --output /path/to/StarCompanion-Voice-0.1.0.toolpkg
node --test tests/*.test.mjs
```

Windows PowerShell 设置环境变量示例：`$env:OPERIT2_SOURCE='E:/zzz/starcompanion-operit2'`。开发机复用 E 盘已安装工具，不需要编译 APK、安装 Android SDK 或下载语音模型。

归档包含入口、独立 Compose UI 模块、内联本地 HTML、插件源码和本许可证。页面禁止远程导航和远程资源；只允许当前页面管理自己创建的通话。构建与设备验收的具体结果见仓库 `docs/operit2-voice-plugin-validation.md`。

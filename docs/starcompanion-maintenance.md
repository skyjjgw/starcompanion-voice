# 星伴语音维护约定

本项目是 https://github.com/qfyingque/erpan 的真实 GitHub fork，公开维护于
https://github.com/skyjjgw/starcompanion-voice。初始提交固定为
`1032a4f4b4afdb28f05e0568c3c4cfb1a6bbb5fb`。

维护分支为 `starcompanion`，作为个人 fork 的默认分支；`main` 保留 fork 时的上游基线。
主应用仓库为 https://github.com/skyjjgw/starcompanion-operit2。语音功能以插件接入为目标，
目前仅建立公开开发基线，未更换 Android 包名或修改原语音实现，未验证 Operit2 兼容性。

## 改动与同步

- 每个可交付改动包含相应源码、测试及必要说明，检查暂存差异后提交，再普通推送到个人 fork。
- 本地 `origin` 指向个人 fork，`upstream` 指向官方 erpan；日常 `git push` 只推维护分支。
- 维护分支推送和 PR 运行 Node 插件检查。只有实际运行过的 Android 构建、出声、连续对话
  和打断测试才可记录为通过；Node 检查不等于已完成手机音频验收。
- 上游更新在独立分支比较、适配和验证后合并，不强制覆盖维护分支。
- APK、JS/toolpkg 分发包和校验清单随版本单独放 Release；源码推送不会自动安装插件、
  发布 APK、调用付费语音服务或部署服务器。

## 来源与数据

保留原 `LICENSE`、Erpan contributors 与 LiveKit 署名、`THIRD_PARTY_NOTICES.md` 和
`licenses/`。原版安装和验证范围仍以上游保留的说明为准；本 fork 新能力另行注明实际证据。

API key、签名、录音、私人声音、聊天记录、数据库、`.env` 和 `local.properties` 不进入 Git。
构建缓存、依赖、SDK 与 node_modules 不上传。Windows 本地开发优先复用 E 盘已有工具。

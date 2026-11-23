# dsh-codexhost-bridge

DeepSeek Harness (DSH) bridge plugin for running **Codex**, **Claude Code**, and **Antigravity (`agy`)** natively inside DSH via a plugin-owned local CodexHost backend.

## 核心特性

- **三引擎原生接入**：在 DSH 会话输入栏无缝切换 **Codex**、**Claude Code** 与 **Antigravity**，保留各自原生工具、模型、思考强度滑块与权限控制。
- **快启动与低占用**：
  - Claude Code 与 Antigravity 均支持全局磁盘 SWR 模型目录缓存（校验 CLI 可执行文件 stat/mtime 与 7 天 TTL），切换工作区与重启毫秒级出模型。
  - 精简压缩前端 `client.js` 与后端辅助适配器，价格表按需懒加载。
- **长会话与计费完善**：
  - Antigravity 支持 **516K 上下文窗口**、**80% 水位自动 `/compact`**、`transcript.jsonl` 精确缓存命中率与公开单价计费、`antigravity-history` 8 MiB 预算瘦身与 trajectory 拉取熔断。
  - Claude Code 支持 1h 提示词缓存、503/网络错误中继重试、独立无缓存标题生成与原生 `/compact` / `/goal`。
  - Antigravity 与 Claude Code 均支持原生 `/compact` 与 `/goal` 斜杠命令。
- **完整会话导入与现代化控制台**：
  - 内置 DSH Host 控制台（总览 / Agent 连接 / 账号与配额进度条 / 会话导入 / 用量统计与单价编辑器），原生适配 DSH 浅色与深色主题。
  - 支持 Codex、Claude Code 与 Antigravity（直接读取原生 `conversation_summaries.db` + `transcript.jsonl` 重建历史）会话导入与续聊；导入列表自动回查 DSH 已有真实标题，并同步 DSH 手动改名回 Host。

## 环境要求

- **OS**：Windows (`win32`)
- **Node.js**：`>= 22.12.0`（需内置 `node:sqlite`）
- **上游运行时**：本机已安装 `@codexhost/cli` `0.17.4`（用于本地打补丁构建 `backend/`）
- 按需安装各引擎 CLI：`codex`、`claude`、`agy`

## 快速开始（独立构建与安装）

```powershell
# 1. 安装构建依赖（esbuild）
npm install

# 2. 构建前端产物 client.js 与本地补丁后端 backend/
npm run build
# 如需手动指定 CodexHost app 目录：
# node scripts/setup-backend.mjs "C:\path\to\@codexhost\cli-win32-x64\app"
```

将本目录挂载到 DSH 插件目录（如 `~/.dsh/plugins-dev/dsh-codexhost-bridge` 或在 `cordis.patch.yml` 中引用），完整退出 DSH（含系统托盘）重新启动即可生效。

## 测试

```powershell
# 运行不依赖 backend/ 产物的纯单元测试（适用于 CI）
npm run test:unit

# 构建 backend/ 后运行全量测试
npm test
```

## 许可证与合规说明

- 本仓库中的所有桥接源码、补丁脚本与前端代码采用 **MIT License**（见 [LICENSE](./LICENSE)）。
- 为遵守上游许可证与 SDK 再分发条款，本仓库 **不包含** 构建后的 `backend/` 目录。运行 `npm run build:backend` 时会在本机从官方 `@codexhost/cli`（LGPL-3.0）及适配器按 SHA-256 校验后生成私有运行时，并自动复制对应的 `backend/licenses/` 与 `backend/THIRD_PARTY_NOTICES.txt`。

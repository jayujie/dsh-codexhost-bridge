# DSH Host (`dsh-host`)

[English](./README.md)

**DSH Host** 是面向 DeepSeek Harness（DSH）的一键安装插件包，通过插件自有的本地轻量后端，在 DSH 内原生运行 **Codex**、**Claude Code** 与 **Antigravity (`agy`)**。

## 核心特性

- **三引擎原生接入**：在 DSH 对话输入栏无缝切换 **Codex**、**Claude Code**、**Antigravity** 与原生 **DSH**，完整保留各自原生模型目录、思考强度滑块、权限模式、原生斜杠命令与工具审批交互。
- **一键安装与零配置后端引导**：
  - 仓库自带可直接加载的前端产物 `client.js`、标准 `cordis.patch.yml`、多语言元数据与原生 Schemastery 插件配置表单。
  - 通过 `optionalDependencies` 自动声明 `@codexhost/cli-win32-x64@0.17.4`，**无需 `postinstall` 脚本审批**；首次启动后端时自动按 SHA-256 校验上游文件并在 `~/.dsh/dsh-host/runtime/` 下原子生成本地补丁运行时。
- **快启动与低占用**：
  - Claude Code 与 Antigravity 均支持全局磁盘 SWR 模型目录缓存（校验 CLI 可执行文件 `mtime`/`size` 与 7 天 TTL），切换工作区与重启毫秒级出模型。
  - 精简压缩前端 `client.js`，本地单价表按需懒加载。
- **长会话与精准计费**：
  - **Antigravity**：支持 **516K 上下文窗口**、**80% 水位自动 `/compact`**、`transcript.jsonl` 精确缓存命中率与公开单价计费、8 MiB 历史预算瘦身，并支持原生 `/compact` 与 `/goal`。
  - **Claude Code**：支持 1h 提示词缓存、503/网络错误中继重试、独立无缓存标题生成与原生 `/compact` / `/goal`。
- **内置 DSH Host 控制台与会话导入**：
  - 内置现代化 DSH Host 控制台（总览 / Agent 连接 / 账号与配额进度条 / 会话导入 / 用量统计与单价编辑器），原生适配 DSH 浅色与深色主题。
  - 支持 Codex、Claude Code 与 Antigravity（直接读取原生 `conversation_summaries.db` + `transcript.jsonl` 重建历史）会话导入与续聊。

## 一键安装方式

### 方式一：通过 DSH 插件市场（发现页）一键安装

1. 在 DSH 左侧边栏打开 **插件（Plugins）**，在 **实验性插件** 中开启 **自定义插件源（Custom plugin indexes）**。
2. 切换到 **发现（Discover）** 标签页，添加本插件源地址：
   ```text
   https://raw.githubusercontent.com/jayujie/dsh-host/main/market-index.json
   ```
3. 找到 **DSH Host** 点击 **安装（Install）**；若提示重启，完整退出 DSH（含系统托盘）重新打开即可。

### 方式二：通过 DSH 插件管理器直接粘贴 GitHub 地址

1. 打开 DSH 左侧边栏 **插件（Plugins）** → **安装插件**。
2. 粘贴仓库地址：
   ```text
   https://github.com/jayujie/dsh-host
   ```
3. 确认安装，DSH 会自动拉取 `dsh-host` 及其上游依赖 `@codexhost/cli-win32-x64@0.17.4` 并启用插件层。

### 方式三：命令行安装

```powershell
dsh plugin --profile desktop add https://github.com/jayujie/dsh-host
```

## 环境要求

- **操作系统**：Windows x64 (`win32`)
- **DSH 版本**：`>= 0.2.1-rc.5 < 0.3.0-0`
- **Node.js**：`>= 22.12.0`（DSH 桌面端自带 Node 运行时，插件会自动复用）
- **引擎 CLI**（按需安装）：
  - Codex CLI（`codex` 或 Codex Desktop，用于启动本地 CodexHost app-server）
  - Claude Code CLI（`claude`）
  - Antigravity CLI（`agy`）

## 更新推送与版本发布

### 用户端如何接收并安装更新
- **控制台内自动检测与一键更新**：打开 **DSH Host 控制台** 会自动检查 `market-index.json`（不可达时自动回退到 GitHub Releases API）；检测到新版本后顶部会弹出更新横幅，展示版本号、更新说明链接与 **「一键更新」** 按钮（底层调用 DSH 原生 `pluginManager`，安装失败时自动回滚到旧版本）。
- **插件市场发现页**：如果你在 **插件 → 发现** 添加了本仓库的 `market-index.json`，DSH 也会自动对比版本并提示可更新。
- **插件管理器原生更新（npm 渠道）**：若通过 npm 包名 `dsh-host` 安装，DSH 插件管理器原生支持版本列表与就地升级。

### 维护者如何推送新版本
在工作区干净时执行一条命令即可完成发版与推送：
```powershell
npm run release -- patch    # 或 minor / major / 0.6.2
```
脚本会自动递增 `package.json` 版本、重新构建 `client.js`、运行单元测试、打 `vX.Y.Z` 标签、追加更新 `market-index.json`（保留历史版本记录）并推送到 GitHub。推送 `v*` 标签还会自动触发 `.github/workflows/release.yml`，自动打包 `.tgz`、创建 GitHub Release，并在配置了 `NPM_TOKEN` 时自动发布至 npm。

## 本地开发与测试

```powershell
# 安装开发依赖（esbuild、zod）
npm install

# 运行不依赖 backend/ 产物的纯单元测试（适用于 CI）
npm run test:unit

# 重新构建前端 client.js 与本地 backend/
npm run build

# 运行全量测试
npm test
```

## 许可证与合规说明

- 本仓库中的所有桥接源码、补丁脚本与前端代码采用 **MIT License**（见 [LICENSE](./LICENSE)）。
- 为遵守上游许可证与 SDK 再分发条款，本仓库 **不包含** 构建后的 `backend/` 目录；安装后会从 npm 拉取官方 `@codexhost/cli-win32-x64@0.17.4`（LGPL-3.0），在本机通过严格 SHA-256 校验后生成补丁运行时，并完整保留上游 `licenses/` 与 `THIRD_PARTY_NOTICES.txt`。

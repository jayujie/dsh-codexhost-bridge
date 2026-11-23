# DSH Host (`dsh-host`)

[中文说明](./README.zh.md)

**DSH Host** is a DeepSeek Harness (DSH) bundle plugin for running **Codex**, **Claude Code**, and **Antigravity (`agy`)** natively inside DSH through a plugin-owned local background runtime.

## Highlights

- **Three External Engines in One Composer**: Seamlessly switch between **Codex**, **Claude Code**, **Antigravity**, and native **DSH** right in the conversation composer, keeping each engine's native models, reasoning/thinking slider, permissions, slash commands, and tool approvals.
- **One-Click Install & Zero-Config Runtime Provisioning**:
  - Ships a ready-to-load browser bundle (`client.js`), Cordis bundle patch (`cordis.patch.yml`), localized metadata, and a native DSH plugin configuration schema.
  - Declares `@codexhost/cli-win32-x64@0.17.4` as an optional dependency and automatically builds the SHA-256-verified patched local runtime under `~/.dsh/dsh-host/runtime/` on first launch — no manual build step or `postinstall` script approval required.
- **Fast Startup & Low Overhead**:
  - Global disk SWR model catalog cache for both Claude Code and Antigravity (validated by CLI binary `mtime`/`size` and 7-day TTL).
  - Lazy-loaded local model price tables and minified frontend bundle.
- **Long-Session Reliability & Accurate Metering**:
  - **Antigravity**: 516K context window, automatic `/compact` at 80% occupancy, exact `transcript.jsonl` cache-hit & API pricing calculation, 8 MiB history budget, and native `/compact` & `/goal` commands.
  - **Claude Code**: 1-hour prompt caching, 503/network relay retry, isolated uncached title generation, and native `/compact` & `/goal` commands.
- **Built-in DSH Host Console & Session Import**:
  - Dedicated DSH Console panel (Overview / Connections / Accounts & Quota / Session Import / Usage & Price Editor) styled with native DSH light & dark theme tokens.
  - Import & continue existing Codex, Claude Code, and Antigravity sessions (reconstructing Antigravity history directly from `conversation_summaries.db` + `transcript.jsonl`).

## One-Click Installation

### Method 1: DSH Plugin Market (Discover Tab)

1. Open **Plugins** in the DSH sidebar and enable **Custom plugin indexes** (`@deepseek-ai/dsh-experimental-plugin-market-bundle`) under **Experimental plugins**.
2. Switch to the **Discover** tab and add this plugin index URL:
   ```text
   https://raw.githubusercontent.com/jayujie/dsh-host/main/market-index.json
   ```
3. Click **Install** on **DSH Host** and restart DSH (including the system tray) if prompted.

### Method 2: DSH Plugin Manager (Direct GitHub URL)

1. Open **Plugins** in the DSH sidebar and click **Install**.
2. Paste the repository URL:
   ```text
   https://github.com/jayujie/dsh-host
   ```
3. Confirm installation; DSH automatically registers `dsh-host`, installs `@codexhost/cli-win32-x64@0.17.4`, and activates the bundle.

### Method 3: DSH CLI

```powershell
dsh plugin --profile desktop add https://github.com/jayujie/dsh-host
```

## Requirements

- **OS**: Windows x64 (`win32`)
- **DSH**: `>= 0.2.1-rc.5 < 0.3.0-0`
- **Node.js**: `>= 22.12.0` (bundled by DSH Desktop automatically)
- **Engine CLIs** (install whichever engines you plan to use):
  - Codex CLI (`codex` / Codex Desktop — required for starting the CodexHost app-server)
  - Claude Code CLI (`claude`)
  - Antigravity CLI (`agy`)

## Local Development & Testing

```powershell
# Install dev dependencies (esbuild, zod)
npm install

# Run pure unit tests (no pre-built backend/ required)
npm run test:unit

# Rebuild client.js and local backend/ (optional for local dev)
npm run build

# Run full test suite
npm test
```

## License & Compliance

- All bridge source code, patch scripts, and client UI in this repository are licensed under the **MIT License** (see [LICENSE](./LICENSE)).
- To comply with upstream licensing and SDK redistribution terms, this repository does **not** redistribute built `backend/` binaries. Instead, `@codexhost/cli-win32-x64@0.17.4` (LGPL-3.0) is installed directly from npm and patched locally after strict SHA-256 verification, preserving upstream `licenses/` and `THIRD_PARTY_NOTICES.txt`.

# MCSM-AI
**MCSM-AI** is a community fork of [MCSManager](https://github.com/MCSManager/MCSManager) that adds an **AI Agent** inspired by [opencode](https://github.com/sst/opencode), plus a built-in **Minecraft Server Listener (MSL)** so the AI can operate Minecraft servers without Java plugins/mods.
> A Minecraft / Steam game server control panel with an AI co-pilot that reads logs, fixes crashes, manages instances, writes MSL plugins and runs server ops in plain language.
---
## Features
- **AI Agent (opencode-style tool-calling)**
  - Streaming responses with live **thinking (reasoning)**, **tool calls** and markdown output
  - Provider-agnostic: any OpenAI-compatible API endpoint, **multiple models per provider**, selectable in the chat input
  - opencode-inspired **permissions**: tools are grouped into edit / bash / instance / msl keys with wildcard patterns; approvals support **Allow once / Always allow / Reject**; \"always\" rules are persisted per session
  - **File editing tooling**: read_file with line numbers & offset/limit, patch_file with an edit-correcting matcher (exact -> trimmed -> anchored-similarity matching, uniqueness + disproportionate-match guards), apply_patch unified diffs (atomic, multi-file), glob, search_files, write_file
  - Server ops tools: instance list/detail/start/stop/restart/kill/command/config, schedules, **MSL tools**, safe shell_command (read-only commands run without approval), web_search (Tavily / Serper / Brave / Bing / SearXNG / DuckDuckGo), fetch_page, timewait
  - Session management: persistent conversation history, ctx usage drawer, approvals drawer, file-change snapshots with diff & rollback
- **Minecraft Server Listener (MSL) integration**
  - AI can **generate the player-event log regexes from the real server terminal log** (join/quit/chat/command); generation fails with "insufficient info" instead of guessing, and curated regex templates guarantee accurate results
  - MSL plugins are plain JavaScript in plugins/; plugin_require resolves **instance-local node_modules first** (works after npm install in the workspace)
  - **MSL workspace terminal** in the panel dialog: run npm install etc. directly in the instance directory
  - Chinese/GBK-safe: the runtime decodes process output with the instance encoding and auto-injects UTF-8 JVM flags (-Dfile.encoding=UTF-8 ...) like standalone MSL
- **Local-node operation**
  - No node selector anywhere: everything targets the **local machine node** automatically
  - Nav entries for 终端 / 文件管理 / 镜像管理 that auto-focus the local node
  - Node management page removed; embedded (single-process) daemon is the default runtime
- **MCSManager compatibility** — layouts, cards, users, marketplace, schedules, file managers, terminal, audit logs, SSO… all upstream features remain.
---
## Quick start (development)
Requirements: **Node.js >= 18** (20 recommended) + npm.
```bash
npm run install-dependents   # install common/daemon/panel/frontend deps
npm run dev                  # daemon + panel + vite frontend concurrently
```
- Panel API: http://localhost:23333
- Web UI (vite dev): http://localhost:5173/
- Single-process embedded mode is automatic: the panel boots the bundled daemon itself.
Run them separately if needed:
```bash
npm run daemon     # daemon dev (hot reload)
npm run panel      # panel dev (hot reload, port 23333)
npm run frontend   # vite dev server
```
---
## Build & deploy
### Production package (recommended)
```bash
# Linux / macOS
./build.sh
# Windows
build.bat
```
Output production-code/:
```
production-code/
├── start.sh / start.bat    # one-command start (single-process: panel + embedded daemon)
├── web/                    # panel (self-contained app.js) + public/ (built frontend)
└── daemon/
    ├── app.js              # stand-alone daemon (classic split deployment)
    └── production/embedded.js  # embedded daemon loaded by the panel
```
Start:
```bash
cd production-code && ./start.sh      # or start.bat on Windows
```
- **Single-port**: the panel serves the daemon under /daemon internally — no second process, no node selection, NAT friendly
- Bundles are self-contained (BUNDLE=1): **no npm install needed on the server**
- Default port **23333** (change in panel settings)
### First-run setup
1. Open the panel -> choose language -> create the admin account
2. Go to **AI Agent -> 模型提供商** and add a provider:
   - **API 地址**: any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1
   - **模型列表**: one model id per line (the first becomes the default), e.g. gpt-4o-mini
   - **API Key**; optional 推理 (reasoning), 上下文窗口, 最大令牌数
   - Optional **搜索地址 + 搜索 API Key** for web_search:
     - Tavily: https://api.tavily.com/search + your key (free tier ~1000/mo)
     - keyless: SearXNG public instance (https://searx.be/search) or DuckDuckGo (https://duckduckgo.com/html/)
3. Create/select an instance workspace and start chatting — e.g. @fix 服务器崩了，看下日志, @msl 写一个清理掉落物的插件
### MSL quick guide
- Enable **MSL** in the target Minecraft instance (功能组 -> MSL)
- In MSL config, use **AI 生成** for each event regex — the AI reads the **current terminal log** and only generates a regex it can verify; trigger the event in-game first
- Write plugins as JS in plugins/; open the **终端** in the MSL dialog to npm install dependencies
---
## Project layout
```
├── panel/     # Web panel (Koa) - agent engine, providers, approvals, layouts
├── daemon/    # Daemon (instance processes, MSL runtime, embedded mode)
├── frontend/  # Vue 3 + ant-design-vue UI (Agent page, MSL dialogs...)
├── common/    # shared utilities
└── languages/ # i18n packs (12 languages)
```
## License
Apache License 2.0 (inherited from MCSManager). See LICENSE.
## Links
- GitHub: https://github.com/imkysou/mcsm-ai
- MCSManager: https://github.com/MCSManager/MCSManager
- MSL (MinecraftServerListener): https://github.com/imkysou/msl
- opencode: https://github.com/sst/opencode
# MCSM-AI
**MCSM-AI** 是基于 [MCSManager](https://github.com/MCSManager/MCSManager) 开发的社区分支，为其添加了借鉴于 [opencode](https://github.com/sst/opencode) 的 **AI Agent** 功能，并内置了 **Minecraft Server Listener（MSL）**，让 AI 能够脱离 Java 原生的 plugins/mods 开发，直接管理 Minecraft 服务器。
> 一个配备 AI 副驾的 Minecraft / Steam 游戏服管理面板：读日志、修崩溃、管实例、写 MSL 插件、用自然语言完成服务器运维。
---
## 功能特性
- **AI Agent（opencode 式工具调用）**
  - 流式输出：实时展示**思考过程（reasoning）**、**工具调用**与 Markdown 正文
  - 提供商无关：任何 OpenAI 兼容 API；**一个提供商可配置多个模型**，输入框内直接选择
  - opencode 式**权限管理**：工具按 edit / bash / instance / msl 权限键分组（通配符匹配），审批支持 **允许一次 / 总是允许 / 拒绝**，**总是允许**规则按会话持久化
  - **文件编辑工具集**：read_file（带行号 + offset/limit）、patch_file（opencode 编辑校正器：精确 → trim 行匹配 → 锚点相似度匹配，强制唯一 + 比例失衡保护）、apply_patch（unified diff，多文件原子应用）、glob、search_files、write_file
  - 服务器运维：实例列表/详情/启动/停止/重启/强杀/命令/配置、计划任务、**MSL 工具**、安全 shell_command（只读命令免审批）、web_search（Tavily / Serper / Brave / Bing / SearXNG / DuckDuckGo）、fetch_page、timewait
  - 会话管理：持久化历史、上下文用量抽屉、审批抽屉、文件变更快照（diff 与回滚）
- **MSL（MinecraftServerListener）集成**
  - AI 可从**当前服务器终端日志**生成玩家事件正则（加入/退出/发言/指令）；信息不足时明确失败而非瞎猜，内置正规模板保证结果准确
  - MSL 插件就是 plugins/ 里的纯 JavaScript；plugin_require **优先解析实例本地 node_modules**（在实例目录 npm install 后即可用）
  - 面板内的 **MSL 工作区终端**：直接在实例目录执行 npm install 等命令
  - 中文/GBK 安全：运行时按实例编码解码输出，并自动注入 UTF-8 JVM 参数（-Dfile.encoding=UTF-8 …，与独立版 MSL 一致）
- **本机节点化操作**
  - 全站无需选择节点：自动使用**本机节点**
  - 导航内置 **终端 / 文件管理 / 镜像管理** 入口，自动聚焦本机节点
  - 移除节点管理页面；默认单进程模式（内嵌守护进程）
- **MCSManager 兼容性** — 卡片布局、用户体系、市场、计划任务、文件管理、终端、审计日志、SSO 等上游功能全部保留。
---
## 快速开始（开发）
环境要求：**Node.js >= 18**（推荐 20）+ npm。
```bash
npm run install-dependents   # 安装 common/daemon/panel/frontend 依赖
npm run dev                  # 同时启动 daemon + panel + vite 前端
```
- 面板 API：http://localhost:23333
- Web UI（vite 开发服务器）：http://localhost:5173/
- 单进程嵌入模式自动启用：面板自动启动内置的 daemon。
也可以分开运行：
```bash
npm run daemon     # daemon 开发（热重载）
npm run panel      # panel 开发（热重载，端口 23333）
npm run frontend   # vite 开发服务器
```
---
## 构建与部署
### 生产打包（推荐）
```bash
# Linux / macOS
./build.sh
# Windows
build.bat
```
输出 production-code/：
```
production-code/
├── start.sh / start.bat    # 一键启动（单进程：面板 + 内嵌 daemon）
├── web/                    # 面板 app.js（自包含）+ public/（构建后的前端）
└── daemon/
    ├── app.js              # 独立 daemon（经典分离部署也可用）
    └── production/embedded.js  # 内嵌 daemon（面板单进程模式加载）
```
启动：
```bash
cd production-code && ./start.sh      # Windows 用 start.bat
```
- **单端口**：面板内部以 /daemon 提供守护进程服务——无需第二个进程、无需选节点、NAT 友好
- BUNDLE=1 自包含打包：**服务器上无需 npm install**
- 默认端口 **23333**（可在面板设置中修改）
### 首次运行配置
1. 打开面板 -> 选择语言 -> 创建管理员账号
2. 进入 **AI Agent -> 模型提供商** 添加提供商：
   - **API 地址**：任意 OpenAI 兼容端点，如 https://api.openai.com/v1
   - **模型列表**：每行一个模型 ID（第一个为默认），如 gpt-4o-mini
   - **API Key**；可选 推理、上下文窗口、最大令牌数
   - 可选 **搜索地址 + 搜索 API Key**（供 web_search 使用）：
     - Tavily：https://api.tavily.com/search + 你的 Key（免费约 1000 次/月）
     - 免 Key：SearXNG 公共实例（https://searx.be/search）或 DuckDuckGo（https://duckduckgo.com/html/）
3. 选择/创建实例工作区后开始对话——例如 @fix 服务器崩了，看下日志、@msl 写一个清理掉落物的插件
### MSL 快速指南
- 在目标 Minecraft 实例（功能组 -> MSL）启用 **MSL**
- 在 MSL 配置中用 **AI 生成** 各事件正则 —— AI 读取**当前终端日志**，只有能验证的正则才会给出；请先在游戏内触发对应事件
- 在 plugins/ 编写 JS 插件；用 MSL 弹窗中的 **终端** 执行 npm install 安装依赖
---
## 项目结构
```
├── panel/     # Web 面板（Koa）- Agent 引擎、提供商、审批、布局
├── daemon/    # 守护进程（实例进程、MSL 运行时、嵌入模式）
├── frontend/  # Vue 3 + ant-design-vue 前端（Agent 页、MSL 弹窗等）
├── common/    # 公共工具
└── languages/ # i18n 语言包（12 种语言）
```
## 开源协议
Apache License 2.0（继承自 MCSManager），详见 LICENSE。
## 链接
- GitHub 仓库：https://github.com/imkysou/mcsm-ai
- MCSManager：https://github.com/MCSManager/MCSManager
- MSL（MinecraftServerListener）：https://github.com/imkysou/msl
- opencode：https://github.com/sst/opencode
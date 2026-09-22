# Live2D 桌面助手

基于 **Electron + Live2D Cubism + LLM Agent** 的跨平台桌面伴侣应用。在桌面上渲染可交互的 Live2D 角色，接入大语言模型实现智能对话，并以**情感标签驱动角色表情与动作**，支持语音合成/识别、多模态图片输入、对话历史管理等功能。

技术栈：Electron · React 18 · TypeScript · Vite · Tailwind CSS · pixi-live2d-display（Cubism 4 / Cubism 2 双运行时）· better-sqlite3（FTS5 全文检索）· msedge-tts · openai SDK。

---

## 一、功能特性

### 1. Live2D 角色系统
- **双运行时支持**：Cubism 4（`.model3.json`/`.moc3`）与 Cubism 2（`.model.json`/`.moc`）模型均可加载；
- **随包模型**：`Mao`（Cubism4）、`Sagiri 纱雾`、`Megumi 加藤惠`（Cubism2），可在设置中切换；
- **情感-表情-动作映射**：LLM 回复中的情感标签（`[emotion:happy]` 或裸 `[happy]`）自动驱动角色表情与动作；
- **交互**：点击角色触发动作、视线跟随鼠标、说话时口型同步（Web Audio 波形驱动）；
- **外观可调**：角色大小、水平位置、脚底偏移（避免脚被裁切/遮挡）、自动避让对话框。

### 2. LLM Agent 对话
- **OpenAI 兼容接口**：支持 hermes / OpenAI / DeepSeek / Ollama / vLLM 等任意兼容后端，SSE 流式输出；
- **Function Calling**：通过插件为模型提供工具（如查询时间），模型可调用后继续回答；
- **演示模式**：未配置 API 时内置 Demo 回复，开箱即可体验完整闭环；
- **多模态图片输入**：对话可附带图片（选择/粘贴/拖拽，最多 4 张、单张 ≤4MB），以 OpenAI 视觉格式发送；
- **消息可复制**：悬停消息显示复制按钮（助手消息在右侧、用户消息在左侧）。

### 3. 语音能力
- **TTS 语音合成**：默认 **Edge TTS**（免费高质量中文，音色可选：晓晓/晓伊/云希等）；亦支持 OpenAI 兼容 `/audio/speech`；
- **STT 语音识别**：支持 Whisper 兼容 `/audio/transcriptions` 与浏览器 Web Speech API；
- **按住说话**、**唤醒词**（可配置）唤醒助手。

### 4. 窗口与桌面体验
- **无边框透明悬浮窗**、置顶显示、**隐藏任务栏/Dock 图标**，仅通过系统托盘管理；
- **自动伸缩**：打开对话面板=展开（520×680）；空闲=最小（320×360，仅角色），尺寸可配置；
- **拖动移动**：按住工具栏空白处或对话框标题栏拖动；窗口尺寸守卫防止系统吸附放大；
- **工具栏自动折叠**：无操作一段时间后隐藏，移动鼠标恢复；
- **系统托盘**：托盘菜单显示/隐藏、设置、退出；全局快捷键。

### 5. 对话历史
- **会话管理**：多会话、重命名、删除、**一键清空**、导出；
- **全文检索**：SQLite FTS5 全文搜索历史消息；
- **图片持久化**：附带图片随消息存库，重载后仍显示。

### 6. 插件系统
- `plugins/` 目录放置插件，`node:vm` 沙箱隔离执行；
- 插件可注册工具供 LLM Function Calling 调用（示例：`example-time-tool`）。

---

## 二、安装与快速开始

### 安装（Windows）
运行安装包 `release/Live2D Desktop Assistant-<版本>-win-x64.exe`，按向导安装即可。安装后从开始菜单/桌面快捷方式启动，或经系统托盘管理。

> Linux / macOS 安装包见「构建与打包」。macOS 未签名，首次打开需在「系统设置→隐私与安全性」允许。

### 首次配置（接入 LLM）
1. 打开 **设置 → LLM**；
2. 选择 `Provider = openai`，填写：
   - **Base URL**：如 `https://api.openai.com/v1` 或自建后端地址；
   - **API Key**；
   - **Model**：如 `gpt-4o-mini`（支持视觉则可用图片输入）；
3. 点击 **测试连接** 验证；保存后即可对话。

> 后端对接细节（接口地址配置、入参出参、情感标签约定）见 [docs/BACKEND_INTEGRATION.md](docs/BACKEND_INTEGRATION.md)。

### 语音配置
- **设置 → 语音**：选择 TTS 引擎（Edge / OpenAI / 浏览器）、Edge 音色、Whisper 地址、唤醒词等；
- 默认 Edge TTS 无需任何配置即可发声。

---

## 三、使用指南

### 对话
- 点击工具栏 **💬 对话** 打开聊天面板；输入文字回车发送；
- **图片输入**：点输入区图片图标选图，或直接 `Ctrl+V` 粘贴截图、拖拽图片到聊天框；
- **语音输入**：点麦克风或按住快捷键说话；
- **复制消息**：悬停消息点复制图标。

### 角色与窗口
- **移动窗口**：按住工具栏空白处（按钮之间/边缘）拖动；
- **移动对话框**：按住对话框标题栏拖动，双击标题栏复位；
- **缩放角色**：设置 → 外观 → 角色大小滑块；
- **脚底偏移**：设置 → 外观 → 脚底偏移，微调角色脚底留白避免被裁；
- **隐藏/显示角色**：工具栏眼睛图标或快捷键。

### 切换 / 添加模型
- **切换**：设置 → 外观 → 模型下拉框（Mao / Sagiri / Megumi）；
- **添加自定义模型**：把模型文件夹放入安装目录 `resources/assets/models/<文件夹名>/`，文件夹内需含模型文件（Cubism4 为 `*.model3.json`，Cubism2 为 `*.model.json`）及其相对资源（贴图/动作/表情子目录）；重启或重开设置即出现在下拉框。模型文件名无需与文件夹同名。

### 历史
- 工具栏 **🕘 历史** 打开历史面板：搜索、打开、删除单条、**清空全部**（二次确认）。

### 快捷键（默认，可在设置修改）
| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+L` | 显示/隐藏角色 |
| `Ctrl+Shift+T` | 按住说话 |
| `Ctrl+Shift+M` | 切换静音 |
| `Ctrl+Shift+S` | 打开设置 |

---

## 四、开发

### 环境
Node.js ≥ 18。

```bash
npm install          # 安装依赖（含 postinstall 补丁）
npm run dev          # 启动 Electron 开发模式
npm run dev:web      # 仅浏览器开发模式（演示 LLM + localStorage 历史）
npm run build        # 构建渲染层 + 主进程
npm run typecheck    # TypeScript 类型检查
```

### 构建与打包
```bash
npm run dist:win     # Windows NSIS 安装包
npm run dist:linux   # Linux AppImage
npm run dist:mac     # macOS DMG（建议在 macOS 上执行）
```
产物输出到 `release/`。

### 自测模式（无头/CI 可用）
```bash
SMOKE_TEST=1 npm start        # 全链路冒烟测试（40+ 检查项）
E2E_BACKEND=1 npm start       # 自研后端对接 E2E（需先配置 config.json 指向后端）
E2E_VOICE=1 npm start         # 语音链路 E2E（TTS/STT）
FEET_DIAG=1 npm start         # 布局/截图诊断（输出几何与截图到 /tmp）
```
Linux 无头环境需 `xvfb-run` 与 `NO_TRANSPARENT=1`（透明窗口在无头下禁用 GPU）：
```bash
SMOKE_TEST=1 NO_TRANSPARENT=1 xvfb-run -a npm start
```

---

## 五、配置参考

用户配置存于 `userData/config.json`（与默认值深合并，旧配置自动补齐新字段）。主要分区：

| 分区 | 关键字段 | 说明 |
|---|---|---|
| `llm` | `provider`/`baseUrl`/`apiKey`/`model`/`systemPrompt`/`contextWindow` | LLM 后端与人格 |
| `voice` | `ttsEngine`(edge/openai/browser)/`edgeVoice`/`whisperBaseUrl`/`wakeWord` | 语音合成与识别 |
| `appearance` | `modelDir`/`modelScale`/`modelX`/`footInset`/`avoidPanel`/`autoResizeWindow`/`expandedWidth/Height`/`bareWidth/Height`/`autoHideToolbar` | 角色与窗口外观 |
| `shortcuts` | `toggleCharacter`/`pushToTalk`/`toggleMute`/`openSettings` | 全局快捷键 |

---

## 六、文档与目录

- [docs/BACKEND_INTEGRATION.md](docs/BACKEND_INTEGRATION.md)：后端对接（Agent 交互、接口地址、入参出参）；
- [docs/SOURCE_FILES.md](docs/SOURCE_FILES.md)：`src/` 逐文件功能说明；
- `src/main/` 主进程（窗口/IPC/LLM/语音/存储/插件/模型协议）；`src/renderer/` 渲染层（UI/Live2D/语音前端）；`src/shared/` 共享类型与默认配置；`plugins/` 插件目录；`assets/models/` 随包模型。

---

## 七、常见问题

- **角色不动**：确认显卡/WebGL 可用；无头环境需 `--enable-unsafe-swiftshader`；
- **脚被裁切/遮挡**：调大 设置→外观→脚底偏移；或开启「角色自动避让对话框」；
- **拖动窗口变大**：已内置尺寸守卫+禁最大化+禁手动调整，正常不会；若仍异常请反馈环境；
- **Edge TTS 无声**：检查网络（Edge TTS 需联网直连微软服务）；可改用 OpenAI TTS 或浏览器引擎；
- **历史重复/丢失**：历史由主进程单一写入；如异常可「清空全部」重建。

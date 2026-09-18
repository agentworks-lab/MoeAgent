# src 源码文件功能说明

> 本文档逐文件说明 `src/` 下每个源码文件的职责，便于快速定位与二次开发。
> 进程划分：**main**（Node 主进程）／**preload**（预加载桥）／**renderer**（Chromium 渲染进程）／**shared**（三端共享）。

## 架构总览

```
src/
├── main/       主进程：窗口/托盘/IPC/LLM/语音/存储/插件/模型协议
├── preload/    contextBridge 安全 API（window.assistant）
├── renderer/   React UI + Live2D 舞台 + 语音前端
└── shared/     类型 / 默认配置 / IPC 通道 / 情感解析与演示 LLM
```

渲染层通过 `bridge` 抽象访问主进程能力；Electron 与浏览器开发模式共用同一套 UI 代码。

---

## src/main/（主进程）

### index.ts
主进程入口与总装配。职责：
- 创建无边框、透明、置顶、`skipTaskbar` 的主窗口（macOS 隐藏 Dock）；
- 注册自定义协议 `l2dmodel://`，把 `assets/models` 目录（asar 外、用户可添加）供给渲染层加载模型（含 CORS 头与防目录穿越）；
- 窗口自动伸缩 `applyWindowMode`（空闲紧凑 / 面板展开，底边固定）；
- 托盘、全局快捷键、系统通知；
- 注册全部 IPC handler：配置、LLM 对话/中止/自检、语音 TTS/STT、模型列举、历史会话、插件工具、窗口控制（最小化/隐藏/紧凑/聚焦/退出）；
- 内置自测模式：`SMOKE_TEST=1`（全链路冒烟）、`E2E_BACKEND=1`（自研后端对接）、`E2E_VOICE=1`（语音链路）、`FEET_DIAG=1`（布局/截图诊断）。

### config.ts
`ConfigStore` 配置管理。配置以 JSON 存于 `userData/config.json`；读取时与默认值**深合并**（旧配置缺的新字段自动补齐）；支持部分嵌套写入、文件 watch 热加载与变更通知（`config:changed`）。

### storage.ts
`HistoryStore` 对话历史存储。优先 better-sqlite3：`sessions`/`messages` 表 + **FTS5 全文索引**（含插入/删除触发器同步索引）；原生模块不可用时回退 JSON 文件。提供 newSession / listSessions / renameSession / deleteSession / **clearAll** / addMessage / queryMessages / search(FTS) / exportAll。

### llm/client.ts
OpenAI 兼容 LLM 客户端（适配器模式）。基于官方 `openai` SDK，兼容 OpenAI/DeepSeek/Ollama/vLLM 等；支持 **SSE 流式输出**与 **Function Calling（tool_calls）** 捕获；`createClient` 按配置在 `OpenAiClient` 与 `DemoClient` 间切换；重导出情感标签提取工具。

### plugins/host.ts
`PluginHost` 插件宿主。扫描 `plugins/` 目录，用 `node:vm` **沙箱隔离**执行插件代码；支持 onLoad/onUnload/onMessage 生命周期与工具注册；插件工具作为 Function Calling 能力暴露给 LLM（如示例时间工具）。

### voice/tts.ts
`TtsService` 语音合成。双引擎：`openai`（POST `{baseUrl}/audio/speech`）与 `edge`（msedge-tts WebSocket 直连微软，默认）；返回 base64 音频 + mime；音色可配（edgeVoice / openaiTtsVoice）。

### voice/stt.ts
`SttService` 语音转写。调用 Whisper 兼容 `POST /audio/transcriptions`（multipart 上传音频）；地址/密钥留空时复用 LLM 配置。

---

## src/preload/

### index.ts
contextBridge 预加载桥。向渲染层暴露唯一安全 API `window.assistant`：配置读写与变更订阅、LLM 对话/中止/自检与流事件、语音转写/合成/自检、模型列举、历史会话增删改查/清空/导出、插件列举与工具调用、窗口控制与系统通知。开启 contextIsolation、关闭 nodeIntegration。

---

## src/renderer/（渲染进程）

### main.tsx
React 入口。挂载 `<App/>`，加载 i18n 与全局样式；浏览器开发模式下为 body 加背景类。

### index.html
页面骨架。含 **CSP**（放行 `l2dmodel:` 协议）与两个 Live2D 核心预加载：Cubism4 `live2dcubismcore.min.js`、Cubism2 `live2d.js`（提供 `window.Live2D`）。

### index.css
全局样式。Tailwind v4 入口、玻璃拟态 `.glass`、聊天滚动条、typing 点动画、浏览器模式背景等。

### App.tsx
主 UI 组件与总编排。状态：配置/会话/消息/忙/当前面板/角色可见/语音/工具栏折叠/面板偏移/避让区域/模型列表。职责：LLM 流式事件与情感标签处理、TTS 播放与口型、STT 与唤醒词、对话框拖拽（Pointer Events + 指针捕获）与双击复位、工具栏自动折叠、角色避让 freeArea 测量、窗口自动伸缩（setCompact + 落定后强制重排）、modelDir→模型 URL 解析、渲染角色层与 UI 层（工具栏/聊天/设置/历史面板）。

### bridge.ts
`AssistantBridge` 抽象层。Electron 下委托 `window.assistant`；浏览器开发模式提供内存实现（DemoClient 流式 + localStorage 历史/配置），使同一 UI 代码双环境可跑。

### i18n.ts
react-i18next 中/英双语词典（聊天/工具栏/设置/历史/语音/快捷键等全部文案）。

### components/Live2DCanvas.tsx
Live2D 画布组件。**舞台常驻**（挂载时创建一次 PIXI/WebGL 上下文），切换模型仅 `stage.loadModel` 热替换（不重建上下文，避免驱动下重建失败）；ResizeObserver + 窗口 resize 监听重排；视线追踪与点击命中转发；缩放/位置/脚底偏移/避让区域实时套用。

### components/ChatPanel.tsx
聊天面板。消息列表（流式打字点、情感徽章）、空态；输入区：textarea（autoFocus、Enter 发送/Shift+Enter 换行）、麦克风按钮、发送/停止按钮、语音提示条。

### components/HistoryPanel.tsx
历史面板。会话列表（当前会话高亮）、标题搜索、单条删除；**清空全部**采用应用内二次确认（不用原生 confirm，避免无边框窗口丢失键盘焦点），清空后主动 focusWindow 并新建会话兜底。

### components/SettingsPanel.tsx
图形化设置面板。分区：LLM（provider/baseUrl/key/model/systemPrompt/自检）、语音（引擎/Edge 音色下拉/Whisper/唤醒词/自检）、外观（模型选择、角色大小/水平位置/脚底偏移滑块、避让开关、窗口自动伸缩、工具栏自动折叠）、快捷键、插件列表。

### components/Toolbar.tsx
顶部工具栏。面板切换（聊天/历史/设置）、静音、角色显隐、最小化/隐藏到托盘/退出（Electron）；支持自动折叠（collapsed 透明度）。

### components/Icons.tsx
轻量内联 SVG 图标集（聊天/历史/设置/麦克/发送/停止/垃圾桶/关闭/插头等），无外部图标依赖。

### live2d/stage.ts
`Live2DStage` 舞台控制器。封装 pixi-live2d-display：**双运行时**（按 URL 后缀动态加载 cubism4/cubism2）；布局 `fitModel`（适配可用区域 × 用户倍率、脚底偏移、避让区域、底部对齐）；tween 平滑过渡；**每帧窗口尺寸自检**重排；表情/动作/视线/点击；口型同步钩子（cubism4 挂 afterMotionUpdate 注入 ParamA）；空闲动作组自动探测；`diagnostics()` 运行快照供排查与自动化。

### live2d/emotionMap.ts
表情-动作映射引擎配置表。情感标签 → Mao 表情文件（exp_01~08）+ 动作组 + 强度/时长；`resolveEmotion` 未知情感回退 neutral。

### voice/speech.ts
`SpeechRecognizer`。浏览器 Web Speech API 语音识别（zh-CN、interimResults），返回取消函数；`supported()` 能力探测。

### voice/recorder.ts
`AudioRecorder`。MediaRecorder 采集麦克风（回声消除/降噪/单声道），优先 Whisper 支持的容器（webm/opus 等），输出 base64 供转写。

### voice/ttsPlayer.ts
`TtsPlayer`。播放 Edge TTS 返回的 base64 音频；用 Web Audio `AnalyserNode` 实时分析波形幅度驱动 Live2D 口型参数；浏览器引擎用 speechSynthesis + 随机包络近似口型；对外暴露 speaking 状态回调。

---

## src/shared/（三端共享）

### types.ts
共享 TypeScript 类型：`AppConfig`（llm/voice/appearance/shortcuts 分区）、`ChatMessage`、`StreamEvent`、`ModelInfo`、`HistorySession`、`HistoryRecord`、`PluginInfo`、`EmotionMap` 等。

### defaults.ts
`DEFAULT_CONFIG` 默认配置（含默认 Edge TTS、默认模型 Mao、自动伸缩尺寸、脚底偏移等）与 `deepMergeConfig` 深合并（旧配置自动补齐新字段；null 与 undefined 语义区分）。

### ipc.ts
IPC 通道名常量表（唯一来源，main/preload 共用），避免字符串散落：配置、LLM、语音、模型、历史、插件、窗口、系统各通道。

### demo.ts
情感标签解析 + 内置演示 LLM。`extractEmotions`/`stripEmotionTags` 兼容 `[emotion:xxx]` 与裸 `[xxx]`（限已知情感名）两种格式；`DemoClient` 无网络模拟流式输出与情感标签，保证开箱即用闭环。

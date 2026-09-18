# Live2D 桌面助手 · 后端对接文档

> 面向后端/算法工程师：说明 Agent 交互协议、后端接口地址的配置方式、以及全部请求入参与响应出参。
>
> 适用版本：v1.0.0　最后更新：2026-09-16
>
> **契约已实测验证**：本文档 §3 / §4 / §5 描述的请求字段、SSE 出参格式与情感标签解析，均已通过「自研 mock 后端 + 真实 Electron 应用」端到端联调确认（13 项断言全部通过，含配置加载、连通性测试、43 个流式分片、情感标签检出、UI 标签剥离、历史持久化、配置热更新）。§9 提供参考实现可直接用于对接自测。

---

## 目录

1. [总体交互模型](#1-总体交互模型)
2. [后端接口地址在哪配置](#2-后端接口地址在哪配置)
3. [Agent 交互协议（LLM 后端必须实现）](#3-agent-交互协议llm-后端必须实现)
4. [情感标签约定（驱动表情/动作）](#4-情感标签约定驱动表情动作)
5. [Function Calling（工具调用）](#5-function-calling工具调用)
6. [语音接口（STT / TTS）](#6-语音接口stt--tts)
7. [应用内部 IPC 接口](#7-应用内部-ipc-接口)
8. [错误处理与超时](#8-错误处理与超时)
9. [最小可用后端参考实现](#9-最小可用后端参考实现)
10. [附录：配置字段全表](#10-附录配置字段全表)

---

## 1. 总体交互模型

客户端是 **Electron 桌面应用**，后端交互全部发生在**主进程**（Node.js 侧），通过官方 `openai` SDK 发起 HTTPS 请求。渲染进程（React UI）不直接访问后端，只通过 IPC 与主进程通信。

```
用户输入（文本 / 语音）
      │
      ▼
渲染进程 React UI
      │  IPC: llm:chat
      ▼
主进程 LLM Agent 编排器 ────────► 后端 API（OpenAI 兼容）
      │   ├─ Prompt 构建（系统提示词 + 上下文裁剪）      POST {baseUrl}/chat/completions
      │   ├─ SSE 流式解析                              stream: true
      │   ├─ 情感标签提取 [emotion:xxx]
      │   └─ Function Calling（插件工具）
      │  IPC 事件: llm:chat:stream
      ▼
渲染进程
   ├─ 文本逐字渲染（聊天气泡）
   ├─ 表情/动作映射引擎 → Live2D 模型
   └─ TTS 朗读 → 口型同步
```

**关键点**：后端只需实现标准 **OpenAI Chat Completions** 接口即可，客户端不要求任何私有协议。情感标签通过约定的文本标记 `[emotion:xxx]` 内嵌在回复正文中传递，因此**无需后端新增任何字段**。

---

## 2. 后端接口地址在哪配置

后端地址共有 **4 种配置入口**，优先级由低到高：默认值 → 配置文件 → 设置面板 / IPC → 环境变量（仅演示模式相关）。

### 2.1 图形化设置面板（推荐）

应用内 **工具栏 → 齿轮图标（设置）→ LLM 服务**：

| 面板字段 | 对应配置键 | 说明 |
|---------|-----------|------|
| 服务提供商 | `llm.provider` | `demo`（内置演示，不联网）/ `openai`（OpenAI 兼容 API） |
| API 地址 | `llm.baseUrl` | **后端接口基地址**，客户端会自动拼接 `/chat/completions` |
| API Key | `llm.apiKey` | 以 `Authorization: Bearer <key>` 发送；留空则不带该请求头 |
| 模型名称 | `llm.model` | 传给后端的 `model` 字段 |
| Temperature | `llm.temperature` | 0 ~ 2 |
| 最大 Tokens | `llm.maxTokens` | 映射为 `max_tokens` |
| 上下文窗口 | `llm.contextWindow` | 客户端侧裁剪，最多携带的历史消息**条数** |
| 系统提示词 | `llm.systemPrompt` | 角色人格 + 情感标签指令 |

点击 **「测试连接」** 会向后端发送一次最小化请求（`max_tokens: 8`，非流式）验证连通性，返回 `✓ 连接成功` 或 `✗ <错误原因>`。

> ⚠️ 只有 `provider` 选择为 `openai` 时，`baseUrl` / `apiKey` 才会生效。默认的 `demo` 模式完全离线，不发起任何网络请求。

### 2.2 配置文件（可热加载）

配置文件位于 Electron `userData` 目录下的 `config.json`：

| 操作系统 | 路径 |
|---------|------|
| Windows | `%APPDATA%\live2d-desktop-assistant\config.json` |
| macOS | `~/Library/Application Support/live2d-desktop-assistant/config.json` |
| Linux | `~/.config/live2d-desktop-assistant/config.json` |

示例（接入 DeepSeek）：

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    "model": "deepseek-chat",
    "temperature": 0.7,
    "topP": 1,
    "maxTokens": 1024,
    "systemPrompt": "你是 Mao……（需保留情感标签指令）",
    "contextWindow": 20
  }
}
```

**支持热加载**：主进程通过 `fs.watch` 监听该文件，直接编辑保存后**无需重启应用**即生效，并会主动推送 `config:changed` 事件通知渲染层刷新。

> 配置写入采用**深合并**语义：只需写入要修改的字段，未提供的字段保留原值。

### 2.3 IPC 编程式配置

渲染进程（或插件）可调用 `config:write`：

```js
await window.assistant.updateConfig({
  llm: { provider: 'openai', baseUrl: 'https://my-llm.internal/v1', apiKey: 'sk-...', model: 'qwen-max' },
});
```

### 2.4 常见后端 baseUrl 取值

| 后端 | `baseUrl` | 备注 |
|------|-----------|------|
| OpenAI 官方 | `https://api.openai.com/v1` | |
| DeepSeek | `https://api.deepseek.com/v1` | |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 兼容模式 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | |
| Moonshot | `https://api.moonshot.cn/v1` | |
| Ollama（本地） | `http://localhost:11434/v1` | 本地部署，无需 apiKey |
| vLLM / LMDeploy | `http://<host>:8000/v1` | 自托管推理服务 |
| one-api / new-api 网关 | `http://<host>:3000/v1` | 多模型聚合网关 |
| 自研后端 | `https://<your-host>/<path>` | 只需实现 §3 的接口契约 |

> `baseUrl` 末尾的 `/` 会被自动去除，写 `.../v1` 或 `.../v1/` 均可。

---

## 3. Agent 交互协议（LLM 后端必须实现）

### 3.1 端点

```
POST {baseUrl}/chat/completions
```

### 3.2 请求头

| Header | 值 | 是否必带 |
|--------|-----|---------|
| `Content-Type` | `application/json` | 是（SDK 自动） |
| `Authorization` | `Bearer {llm.apiKey}` | 仅当 `apiKey` 非空 |

### 3.3 请求体（入参）

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "你是 Mao，一只活泼可爱的猫娘桌面助手……" },
    { "role": "user", "content": "今天天气怎么样？" },
    { "role": "assistant", "content": "[emotion:thinking] 让我想想……" },
    { "role": "user", "content": "帮我查下时间" }
  ],
  "temperature": 0.7,
  "top_p": 1,
  "max_tokens": 1024,
  "stream": true,
  "tools": [ /* 可选，见 §5；无插件时不发送该字段 */ ]
}
```

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `model` | string | `llm.model` | 模型标识 |
| `messages` | array | 编排器构建 | 消息数组，见下方构建规则 |
| `temperature` | number | `llm.temperature` | 采样温度 |
| `top_p` | number | `llm.topP` | 核采样（默认 1，设置面板未暴露，可通过配置文件/IPC 调整） |
| `max_tokens` | number | `llm.maxTokens` | **注意：客户端发送 `max_tokens`，非 `max_completion_tokens`** |
| `stream` | boolean | 固定 `true` | 正式对话始终为流式；「测试连接」时为 `false` |
| `tools` | array | 插件注册表 | 仅当 `provider=openai` 且已加载含工具的插件时发送 |

**`messages` 构建规则**（编排器负责，后端无需关心）：

```
messages = [ {role:"system", content: llm.systemPrompt} ]        // 恒定置于首位
         + history.slice(-llm.contextWindow)                     // 上下文裁剪：仅保留最近 N 条
         + [ {role:"user", content: 本次用户输入} ]                // 当前消息
```

- 历史消息 `role` 取值：`system` / `user` / `assistant` / `tool`
- 超出 `contextWindow` 的早期消息被丢弃（系统提示词始终保留）
- 工具调用轮次中会追加 `{role:"tool", content:"<JSON字符串>"}` 消息

### 3.4 响应（出参）— SSE 流式

`Content-Type: text/event-stream`，标准 OpenAI chunk 格式：

```
data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"[emotion:happy] "},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"你好呀！"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**客户端消费的字段**：

| 路径 | 用途 |
|------|------|
| `choices[0].delta.content` | 增量文本，逐字推送到 UI 并累积为完整回复 |
| `choices[0].delta.tool_calls[].index` | 工具调用序号（多工具并行时区分） |
| `choices[0].delta.tool_calls[].function.name` | 工具名 |
| `choices[0].delta.tool_calls[].function.arguments` | 工具参数（**分片字符串**，客户端按序拼接后再 `JSON.parse`） |
| `data: [DONE]` | 流结束标记 |

其余字段（`id`、`usage`、`system_fingerprint` 等）客户端**不读取**，可自由填充或省略。

> 客户端通过官方 `openai` SDK 的 `for await (const chunk of stream)` 消费，任何符合 OpenAI SDK 流式解析规则的响应均可正常工作。

### 3.5 响应（出参）— 非流式（仅「测试连接」使用）

```json
{
  "id": "chatcmpl-1",
  "object": "chat.completion",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "pong" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11 }
}
```

测试请求体固定为：

```json
{ "model": "<llm.model>", "messages": [{ "role": "user", "content": "ping" }], "max_tokens": 8 }
```

判定逻辑：**HTTP 2xx 即视为连接成功**，不校验响应内容。

---

## 4. 情感标签约定（驱动表情/动作）

这是实现「文本 → 表情 → 动作」闭环的核心约定。后端（通过系统提示词约束模型）需在回复中内嵌情感标签。

### 4.1 标签格式

```
[emotion:<标签>]
```

- 正则：`/\[emotion:\s*([a-zA-Z_]+)\s*\]/g`
- 标签**只能包含 ASCII 字母和下划线**（不支持中文标签、数字、连字符）
- 可出现在回复任意位置，**建议置于开头**
- 允许出现多个标签，客户端会对每个新标签各触发一次表情切换（去重）

### 4.2 支持的标签与映射结果

| 标签 | 中文 | Live2D 表情文件 | 动作序列 | 持续时间 |
|------|------|----------------|---------|---------|
| `happy` | 开心 | `exp_02`（眼睛笑） | `TapBody` | 8s |
| `shy` | 害羞 | `exp_04`（星星眼） | — | 8s |
| `sad` | 难过 | `exp_05`（沮丧） | — | 10s |
| `thinking` | 思考 | `exp_03`（平静） | — | 8s |
| `angry` | 生气 | `exp_08`（愤怒） | `TapBody` | 6s |
| `surprised` | 惊讶 | `exp_07`（瞪眼） | — | 5s |
| `embarrassed` | 尴尬 | `exp_06`（脸红） | — | 6s |
| `neutral` | 平静 | `exp_01`（默认） | — | 常驻 |

- **未识别的标签** → 回退为 `neutral`（`exp_01`）
- **持续时间到期** → 自动回到 `exp_01`
- 映射表位于 `src/renderer/live2d/emotionMap.ts`，可自行扩展；更换角色模型时需同步调整表情文件名

### 4.3 系统提示词必须包含的指令

若要启用表情联动，`llm.systemPrompt` 中**必须**包含类似约束（默认配置已内置）：

```
重要：每次回复的开头必须包含一个情感标签，格式为 [emotion:标签]，
标签只能是 happy / sad / thinking / angry / surprised / shy / neutral 之一，用于驱动你的表情。
```

### 4.4 标签的处理链路

| 阶段 | 行为 |
|------|------|
| 流式接收中 | 在**最近 64 字符**的滑动窗口内扫描标签，命中即推送 `emotion` 事件（已发送的标签去重） |
| UI 展示 | 客户端剥离标签，**用户只看到纯文本**；气泡上方显示中文情感徽章（如「开心」） |
| 持久化 | 存入 SQLite 时 `content` 为纯文本，`emotion` 存入独立字段（取第一个标签） |
| 未流式检出 | 流结束后对完整文本再扫描一次兜底 |

> 后端**无需**对标签做任何特殊处理，原样输出即可。

---

## 5. Function Calling（工具调用）

工具由客户端**插件系统**提供（如内置的 `get_current_time`）。后端只需按 OpenAI Tools 规范返回 `tool_calls`。

### 5.1 启用条件

同时满足：
1. `llm.provider === 'openai'`
2. 至少加载了一个声明 `tools` 的插件

否则请求体中**不含** `tools` 字段，走纯文本流式。

### 5.2 客户端发送的工具定义

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_time",
        "description": "获取当前日期与时间",
        "parameters": {
          "type": "object",
          "properties": {
            "timezone": { "type": "string", "description": "IANA 时区，如 Asia/Shanghai" }
          }
        }
      }
    }
  ]
}
```

### 5.3 后端应返回的 tool_calls（流式分片）

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_current_time","arguments":""}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"timezone\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Asia/Shanghai\"}"}}]}}]}

data: [DONE]
```

> `index` 必填（多工具并行时用于区分）；`id`、`type` 客户端不读取但建议按规范返回；`arguments` 会分片传输，客户端按 `index` 累积拼接后 `JSON.parse`。

### 5.4 客户端执行工具后的后续请求

客户端在本地（vm 沙箱）执行工具，将结果作为 `tool` 消息追加，再次请求同一端点：

```json
{
  "model": "...",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "现在几点了？" },
    { "role": "assistant", "content": "[调用工具]" },
    { "role": "tool", "content": "{\"ok\":true,\"time\":\"2026/9/16 16:51:00\",\"timezone\":\"Asia/Shanghai\"}" }
  ],
  "stream": true,
  "tools": [ ... ]
}
```

后端据此生成最终自然语言回复（应包含 `[emotion:xxx]` 标签）。

**轮次上限**：最多 2 轮工具调用；若第 2 轮仍返回 `tool_calls`，客户端会发起第 3 次**不带工具**的请求强制收尾。

> ⚠️ `role: "tool"` 消息未携带 `tool_call_id`。若后端严格校验该字段，请在网关侧放宽或补充默认值。

### 5.5 自定义插件工具

在 `plugins/<插件目录>/plugin.json` 中声明：

```json
{
  "id": "my-weather",
  "name": "天气查询",
  "version": "1.0.0",
  "description": "查询城市天气",
  "main": "index.js",
  "tools": [
    {
      "name": "get_weather",
      "description": "查询指定城市的当前天气",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string", "description": "城市名" } },
        "required": ["city"]
      }
    }
  ]
}
```

`index.js` 实现 `tools.get_weather(args)`，返回值会被 `JSON.stringify` 后作为 `tool` 消息回传。插件运行于 `node:vm` 沙箱，仅可访问 `console`/`setTimeout`/`Date`/`Math`/`JSON`。

---

## 6. 语音接口（STT / TTS）

STT 与 TTS 均遵循 **OpenAI 语音接口规范**，可对接 OpenAI 官方或任意兼容实现（含自部署 Whisper / TTS 服务）。

> **凭据回退规则**：语音专用的 `whisperBaseUrl` / `whisperApiKey` / `openaiTtsBaseUrl` / `openaiTtsApiKey` **留空时自动复用 `llm.baseUrl` / `llm.apiKey`**。适合"同一个 OpenAI 兼容后端同时提供对话 + 语音"的常见部署，只需配一处地址与密钥。

### 6.1 STT — Whisper 兼容接口

| 项 | 值 |
|----|-----|
| 端点 | `POST {baseUrl}/audio/transcriptions` |
| baseUrl 取值 | `voice.whisperBaseUrl` → 回退 `llm.baseUrl` |
| 认证 | `Authorization: Bearer {voice.whisperApiKey → llm.apiKey}`（均为空则不带该头） |
| Content-Type | `multipart/form-data` |
| 超时 | 30 秒（硬编码） |

**入参（form-data）**：

| 字段 | 类型 | 值 |
|------|------|-----|
| `file` | 二进制文件 | 文件名按录音 mime 推断后缀：`audio.webm` / `audio.mp4` / `audio.ogg` / `audio.wav` / `audio.mp3` |
| `model` | string | `voice.whisperModel`，默认 `whisper-1` |
| `language` | string | 固定 `zh` |

**出参**：

```json
{ "text": "识别出的文本内容" }
```

客户端仅读取 `text` 字段并 `trim()`。非 2xx 返回 `{ text: "", error: "Whisper 请求失败 (HTTP <code>): <响应体前200字符>" }`。

**录音链路**：渲染进程用 `MediaRecorder` 采集（优先 `audio/webm;codecs=opus`，Safari 回退 `audio/mp4`），转 base64 后经 IPC `stt:transcribe` 交给主进程上传。录音小于 1 KB 视为无效（避免误触发）。

**配置项**（`voice.*`）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `sttEngine` | `webspeech` | `whisper`（走后端 API）/ `webspeech`（浏览器内置，不联网、零配置） |
| `whisperBaseUrl` | `https://api.openai.com/v1` | 留空则复用 `llm.baseUrl` |
| `whisperApiKey` | `""` | 留空则复用 `llm.apiKey` |
| `whisperModel` | `whisper-1` | 可换 `gpt-4o-transcribe` 等兼容模型 |

> 默认使用浏览器 Web Speech API（零后端依赖）。切换为 `whisper` 才会调用上述接口。

### 6.2 TTS — 三种引擎

| `voice.ttsEngine` | 后端 | 说明 |
|-------------------|------|------|
| `openai` | **OpenAI 兼容 HTTP API** | 见下方 6.2.1，推荐用于对接自研/云端语音服务 |
| `edge` | 微软 Edge TTS（WebSocket） | 免费高质量中文语音，由 `msedge-tts` 直连 `speech.platform.bing.com`，**不支持自定义地址**；仅桌面版可用 |
| `browser` | 渲染进程 `speechSynthesis` | 系统自带语音，零配置零网络（默认值） |

#### 6.2.1 OpenAI TTS

| 项 | 值 |
|----|-----|
| 端点 | `POST {baseUrl}/audio/speech` |
| baseUrl 取值 | `voice.openaiTtsBaseUrl` → 回退 `llm.baseUrl` |
| 认证 | `Authorization: Bearer {voice.openaiTtsApiKey → llm.apiKey}` |
| Content-Type | `application/json` |
| 超时 | 60 秒 |

**入参（JSON）**：

```json
{
  "model": "gpt-4o-mini-tts",
  "voice": "alloy",
  "input": "要合成的文本",
  "response_format": "mp3"
}
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `model` | `voice.openaiTtsModel` | 默认 `gpt-4o-mini-tts`，可填 `tts-1` / `tts-1-hd` 或自研模型名 |
| `voice` | `voice.openaiTtsVoice` | 默认 `alloy`；设置面板提供 alloy/ash/ballad/coral/echo/sage/shimmer/verse 快捷选择 |
| `input` | 待合成文本 | 已 `trim()`，情感标签已被剥离 |
| `response_format` | 固定 `mp3` | |

**出参**：直接返回**音频二进制**（非 JSON）。客户端读取 `Content-Type` 作为 mime（缺省按 `audio/mpeg` 处理），转 base64 经 IPC 交给渲染进程。

**播放与口型**：渲染进程用 `<audio>` 播放，并经 Web Audio `AnalyserNode` 取人声频段（前 1/3 频点）平均幅度，实时写入 Live2D 的 `ParamA`（Mao 的 LipSync 参数），实现音画同步。

> `edge` 引擎输出格式固定 `audio-24khz-48kbitrate-mono-mp3`，同样走上述口型链路。

#### 6.2.2 语音自检接口

设置面板提供两个自检按钮，也可通过 IPC 调用：

| IPC | 入参 | 出参 | 行为 |
|-----|------|------|------|
| `voice:testTts` | `engine?: string` | `{ ok, message }` | 合成一句「语音服务连接正常。」并返回体积；`browser` 引擎直接返回 ok |
| `voice:testStt` | — | `{ ok, message }` | 校验 STT 地址是否配置，回显将请求的完整端点与模型 |

### 6.3 对接自研语音服务的最小要求

- `POST {baseUrl}/audio/speech`：接受上述 JSON，返回音频字节流（建议 `Content-Type: audio/mpeg`）
- `POST {baseUrl}/audio/transcriptions`：接受 multipart（`file` / `model` / `language`），返回 `{ "text": "..." }`
- 两者可只实现其一：只用 TTS 时把 `sttEngine` 保持 `webspeech`；只用 STT 时把 `ttsEngine` 保持 `browser`
- Electron 主进程发起请求，**不受浏览器 CORS 限制**

---

## 7. 应用内部 IPC 接口

供二次开发 / 插件调用。渲染进程通过 `window.assistant.*` 访问（`contextBridge` 暴露，`contextIsolation: true`）。

### 7.1 LLM 相关

| Channel | 方向 | 入参 | 出参 |
|---------|------|------|------|
| `llm:chat` | R → M | `{ requestId: string, sessionId: string, history: ChatMessage[], text: string }` | `{ accepted: true }`（立即返回，结果走流式事件） |
| `llm:chat:stream` | M → R（事件） | — | `StreamEvent & { requestId }` |
| `llm:abort` | R → M | `requestId: string` | `true` |
| `llm:test` | R → M | — | `{ ok: boolean, message: string }` |

**`ChatMessage`**：

```ts
{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; emotion?: string; timestamp?: number }
```

**`StreamEvent`**：

```ts
{ type: 'token' | 'emotion' | 'done' | 'error' | 'tool'; data: string }
```

| `type` | `data` 含义 | 触发时机 |
|--------|------------|---------|
| `token` | 增量文本片段 | 每收到一个 SSE delta |
| `emotion` | 情感标签名（如 `happy`） | 检测到新标签时（已去重） |
| `tool` | `调用工具 <name>...` | 执行插件工具前 |
| `done` | **完整原始文本（含情感标签）** | 流正常结束；渲染层负责剥离标签 |
| `error` | 错误消息文本 | 请求失败（用户主动中断不触发） |

### 7.2 配置相关

| Channel | 入参 | 出参 |
|---------|------|------|
| `config:read` | — | `AppConfig` |
| `config:write` | `Partial<AppConfig>`（深合并） | 合并后的 `AppConfig` |
| `config:changed`（事件） | — | `AppConfig`（配置文件被外部修改或 IPC 写入时推送） |

### 7.3 语音 / 历史 / 插件 / 模型

| Channel | 入参 | 出参 |
|---------|------|------|
| `stt:transcribe` | `audioBase64: string, mime?: string` | `{ text: string, error?: string }` |
| `tts:synthesize` | `text: string, engine?: string` | `{ audioBase64, mime } \| null` |
| `voice:testTts` | `engine?: string` | `{ ok: boolean, message: string }` |
| `voice:testStt` | — | `{ ok: boolean, message: string }` |
| `history:sessions` | — | `HistorySession[]` |
| `history:newSession` | `title?: string` | `HistorySession` |
| `history:query` | `sessionId: string` | `HistoryRecord[]` |
| `history:add` | `Omit<HistoryRecord,'id'>` | — |
| `history:deleteSession` | `id: string` | — |
| `history:renameSession` | `id: string, title: string` | — |
| `history:export` | — | `{ sessions, messages }` |
| `model:list` | — | `ModelInfo[]` |
| `plugin:list` | — | `PluginInfo[]` |
| `plugin:invokeTool` | `pluginId, tool, args` | 工具返回值 |

---

## 8. 错误处理与超时

| 场景 | 客户端行为 |
|------|-----------|
| HTTP 非 2xx | 抛出异常 → 推送 `error` 事件，消息为 `LLM 请求失败 (HTTP <code>): <响应体前300字符>`（SDK 包装后消息可能为 SDK 原文） |
| 网络不可达 / DNS 失败 | 同上，推送底层错误消息 |
| SSE 中某行 JSON 不完整 | **静默跳过**该行，不中断流 |
| 后端返回非 OpenAI 格式 | SDK 解析异常 → `error` 事件 |
| 用户点击「停止」 | `AbortController.abort()` → 中止请求，**不推送** `error`，UI 标记为「（已停止）」 |
| 测试连接超时 | 15 秒硬超时 |
| STT 超时 | 30 秒硬超时 |
| LLM 对话超时 | **无客户端超时**，依赖后端或用户手动中止 |

**重试策略**：客户端**不自动重试**，由 SDK 默认行为决定（`openai` SDK 对 408/409/429/5xx 默认重试 2 次）。如需自定义，可在 `src/main/llm/client.ts` 的 `makeClient()` 中增加 `maxRetries` / `timeout` 选项。

**流式响应中断**：若后端在流中途断开连接，已接收的 token 会保留在 UI 中，但不会触发 `done` 事件，因此**该轮回复不会写入 SQLite 历史**。建议后端保证流的完整性或以 `[DONE]` 正常收尾。

---

## 9. 最小可用后端参考实现

### 9.1 Node.js（Express）

```js
const express = require('express');
const app = express();
app.use(express.json());

const EMOTIONS = ['happy', 'thinking', 'surprised', 'neutral'];

app.post('/v1/chat/completions', async (req, res) => {
  const { messages = [], stream = false, model = 'mock-1' } = req.body;
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const emotion = EMOTIONS[lastUser.length % EMOTIONS.length];
  const reply = `[emotion:${emotion}] 收到「${lastUser.slice(0, 20)}」，这是来自自研后端的回复。`;

  // 简单鉴权（可选）
  const auth = req.headers.authorization;
  if (process.env.API_KEY && auth !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
  }

  if (!stream) {
    return res.json({
      id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

  send({ role: 'assistant', content: '' });
  for (const ch of reply) {           // 逐字推送
    send({ content: ch });
    await new Promise(r => setTimeout(r, 30));
  }
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
});

app.listen(8000, () => console.log('Mock LLM on http://localhost:8000'));
```

客户端配置：`baseUrl = http://localhost:8000/v1`，`model = mock-1`，`apiKey` 留空或与 `API_KEY` 一致。

### 9.2 Python（FastAPI）

```python
import asyncio, json, time
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse

app = FastAPI()
EMOTIONS = ["happy", "thinking", "surprised", "neutral"]

@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    model = body.get("model", "mock-1")
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    emotion = EMOTIONS[len(last_user) % len(EMOTIONS)]
    reply = f"[emotion:{emotion}] 收到「{last_user[:20]}」，这是来自自研后端的回复。"

    if not stream:
        return JSONResponse({
            "id": f"chatcmpl-{int(time.time())}", "object": "chat.completion",
            "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    async def gen():
        base = {"id": f"chatcmpl-{int(time.time())}", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": model}
        def pkt(delta, finish=None):
            return f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}, ensure_ascii=False)}\n\n"
        yield pkt({"role": "assistant", "content": ""})
        for ch in reply:
            yield pkt({"content": ch})
            await asyncio.sleep(0.03)
        yield pkt({}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
```

启动：`uvicorn main:app --port 8000`，客户端 `baseUrl = http://localhost:8000/v1`。

### 9.3 后端实现自检清单

- [ ] `POST {baseUrl}/chat/completions` 可访问，路径拼接方式为 `baseUrl` + `/chat/completions`
- [ ] 支持 `stream: true` 并返回 `text/event-stream`，以 `data: [DONE]` 结尾
- [ ] 增量文本放在 `choices[0].delta.content`
- [ ] 支持 `stream: false` 的同步响应（用于「测试连接」），返回 `choices[0].message.content`
- [ ] 接受 `max_tokens`（而非仅 `max_completion_tokens`）
- [ ] 若模型输出包含 `[emotion:xxx]` 标签，原样透传不做过滤
- [ ] 若需支持工具调用：按 `delta.tool_calls[].{index, function.name, function.arguments}` 分片返回，并容忍 `role:"tool"` 消息缺少 `tool_call_id`
- [ ] CORS：客户端为 Electron 主进程发起的 Node 请求，**不受浏览器 CORS 限制**，无需配置跨域头
- [ ] HTTPS 证书有效（自签证书需额外处理，SDK 默认校验）

### 9.4 对接自测方法（可复现）

主进程内置了 E2E 验证钩子，可用于验证任意自研后端的对接是否成功：

```bash
# 1. 启动你的后端（示例用文档 §9.1 的 mock 服务）
node mock-llm-server.cjs          # 监听 http://localhost:8899/v1

# 2. 写入客户端配置（指向你的后端）
cat > ~/.config/live2d-desktop-assistant/config.json <<'EOF'
{ "llm": { "provider": "openai", "baseUrl": "http://localhost:8899/v1",
           "apiKey": "sk-test", "model": "mock-1" } }
EOF

# 3. 以 E2E 模式启动应用（Linux 无头环境需 xvfb-run）
npm run build:main
E2E_BACKEND=1 NO_TRANSPARENT=1 xvfb-run -a npx electron . --no-sandbox --enable-unsafe-swiftshader
```

输出 `ALL PASSED` 即表示后端对接完全正确。验证覆盖 13 项：配置加载、连通性测试、SSE 流式分片、情感事件推送、无错误事件、回复内容正确、`done` 含原始标签、UI 已剥离标签、UI 正确渲染、历史写入条数、持久化为纯文本、`emotion` 字段落库、配置深合并。

> `NO_TRANSPARENT=1` 仅用于 Linux/无头环境（Linux 透明窗口会禁用 GPU）；Windows/macOS 无需该变量。
> E2E 运行结束会自动删除测试用 `config.json`，避免残留失效地址。

**语音对接自测**（验证 §6 的 STT / TTS 契约）：

```bash
# 启动一个 OpenAI 兼容的语音服务（或用你自己的），然后：
npm run build:main
E2E_VOICE=1 VOICE_BASE=http://localhost:8898/v1 NO_TRANSPARENT=1 \
  xvfb-run -a npx electron . --no-sandbox --enable-unsafe-swiftshader
```

覆盖 9 项：OpenAI TTS 返回音频、mime 正确、Whisper STT 返回文本、TTS/STT 凭据回退复用 LLM 配置、渲染层经 IPC 取得音频与文本、`voice:testTts` 与 `voice:testStt` 自检。

---

## 10. 附录：配置字段全表

`AppConfig` 完整结构（`src/shared/types.ts`）：

```jsonc
{
  "llm": {
    "provider": "demo",                            // "demo" | "openai"
    "baseUrl": "https://api.openai.com/v1",        // ★ 后端接口地址
    "apiKey": "",                                  // ★ Bearer Token
    "model": "gpt-4o-mini",                        // ★ 模型名
    "temperature": 0.7,                            // → temperature
    "topP": 1,                                     // → top_p
    "maxTokens": 1024,                             // → max_tokens
    "systemPrompt": "你是 Mao……",                   // 人格 + 情感标签指令
    "contextWindow": 20                            // 客户端侧历史裁剪条数
  },
  "voice": {
    "enabled": true,                               // 语音总开关
    "muted": false,                                // 静音
    "sttEngine": "webspeech",                      // "whisper" | "webspeech"
    "whisperBaseUrl": "https://api.openai.com/v1", // ★ STT 后端地址（留空则复用 llm.baseUrl）
    "whisperApiKey": "",                           // ★ STT Token（留空则复用 llm.apiKey）
    "whisperModel": "whisper-1",                   // → model
    "ttsEngine": "browser",                        // "openai" | "edge" | "browser"
    "edgeVoice": "zh-CN-XiaoxiaoNeural",           // Edge TTS 音色
    "openaiTtsModel": "gpt-4o-mini-tts",           // ★ → /audio/speech 的 model
    "openaiTtsVoice": "alloy",                     // ★ → /audio/speech 的 voice
    "openaiTtsBaseUrl": "",                        // ★ TTS 地址（留空则复用 llm.baseUrl）
    "openaiTtsApiKey": "",                         // ★ TTS Token（留空则复用 llm.apiKey）
    "wakeWord": "你好Mao",                          // 唤醒词
    "wakeWordEnabled": false                       // 唤醒词开关
  },
  "appearance": {
    "modelDir": "Mao",                             // Live2D 模型目录名
    "modelScale": 1,                               // 角色大小倍率 0.3 ~ 2.5（模型级缩放，不失真）
    "modelX": 0.5,                                 // 角色水平位置 0~1（0=最左 0.5=居中 1=最右）
    "showToolbar": true,                           // 显示悬浮工具栏
    "autoHideToolbar": true,                       // 工具栏自动折叠（无操作时隐藏）
    "toolbarHideDelay": 4000,                      // 折叠延时（毫秒，最小 1000）
    "panelOffset": null,                           // 对话框拖拽偏移 {x,y}；null=默认底部居中
    "avoidPanel": true                             // 角色自动避让对话框（缩放+移动到未遮挡区域）
  },
  "shortcuts": {
    "toggleCharacter": "CommandOrControl+Shift+L",
    "pushToTalk": "CommandOrControl+Shift+T",
    "toggleMute": "CommandOrControl+Shift+M",
    "openSettings": "CommandOrControl+Shift+S"
  },
  "personality": "default"                         // 人格预设名（预留）
}
```

★ = 后端对接必需字段

### 相关源码位置

| 模块 | 文件 |
|------|------|
| 配置默认值（共享） | `src/shared/defaults.ts` |
| 配置存储与热加载 | `src/main/config.ts` |
| LLM 客户端（SDK 调用、SSE 解析、工具捕获） | `src/main/llm/client.ts` |
| Agent 编排（Prompt 构建、工具轮次、持久化） | `src/main/index.ts` |
| 演示模式客户端 | `src/shared/demo.ts` |
| 情感标签解析 | `src/shared/demo.ts`（`extractEmotions` / `stripEmotionTags`） |
| 情感 → 表情/动作映射表 | `src/renderer/live2d/emotionMap.ts` |
| STT 服务（Whisper 上传） | `src/main/voice/stt.ts` |
| TTS 服务（OpenAI / Edge） | `src/main/voice/tts.ts` |
| 录音采集（MediaRecorder → base64） | `src/renderer/voice/recorder.ts` |
| 浏览器语音识别与唤醒词 | `src/renderer/voice/speech.ts` |
| TTS 播放与口型同步 | `src/renderer/voice/ttsPlayer.ts` |
| Live2D 舞台（缩放/表情/动作/诊断） | `src/renderer/live2d/stage.ts` |
| IPC 通道常量 | `src/shared/ipc.ts` |
| 类型定义 | `src/shared/types.ts` |
| preload 桥接 API | `src/preload/index.ts` |
| 渲染层桥接（Electron / 浏览器双模式） | `src/renderer/bridge.ts` |
| 插件宿主（vm 沙箱） | `src/main/plugins/host.ts` |

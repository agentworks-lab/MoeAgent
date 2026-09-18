/**
 * IPC 通道定义 — 主进程与渲染进程之间的通信协议。
 * 详见开发文档「API 接口设计」章节。
 */
export const IPC = {
  // LLM 对话
  LLM_CHAT: 'llm:chat',
  LLM_CHAT_STREAM: 'llm:chat:stream', // 主进程 → 渲染进程 流式事件
  LLM_ABORT: 'llm:abort',
  LLM_TEST: 'llm:test',

  // 语音
  STT_TRANSCRIBE: 'stt:transcribe',
  TTS_SYNTHESIZE: 'tts:synthesize',
  TTS_STOP: 'tts:stop',
  VOICE_TEST_TTS: 'voice:testTts',
  VOICE_TEST_STT: 'voice:testStt',

  // Live2D 模型
  MODEL_LIST: 'model:list',
  MODEL_LOAD: 'model:load',
  MODEL_GET_DIR: 'model:getDir',

  // 配置
  CONFIG_READ: 'config:read',
  CONFIG_WRITE: 'config:write',
  CONFIG_CHANGED: 'config:changed',

  // 对话历史
  HISTORY_QUERY: 'history:query',
  HISTORY_ADD: 'history:add',
  HISTORY_SESSIONS: 'history:sessions',
  HISTORY_NEW_SESSION: 'history:newSession',
  HISTORY_DELETE_SESSION: 'history:deleteSession',
  HISTORY_RENAME_SESSION: 'history:renameSession',
  HISTORY_CLEAR_ALL: 'history:clearAll',
  HISTORY_EXPORT: 'history:export',

  // 窗口与系统
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_TOGGLE_TOOLBAR: 'window:toggleToolbar',
  WINDOW_SET_COMPACT: 'window:setCompact',
  WINDOW_MOVE_BY: 'window:moveBy',
  WINDOW_FOCUS: 'window:focus',
  APP_QUIT: 'app:quit',
  OPEN_SETTINGS: 'settings:open',
  SHORTCUT_FIRED: 'shortcut:fired',
  TRAY_NOTIFY: 'tray:notify',

  // 插件
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_INVOKE_TOOL: 'plugin:invokeTool',
  PLUGIN_TOOL_RESULT: 'plugin:toolResult',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

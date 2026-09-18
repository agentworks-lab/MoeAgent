import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  AppConfig,
  ChatMessage,
  HistoryRecord,
  HistorySession,
  ModelInfo,
  PluginInfo,
  StreamEvent,
} from '../shared/types';

/**
 * 通过 contextBridge 暴露安全 API（渲染进程通过 window.assistant 访问）。
 * 所有通道遵循开发文档「API 接口设计」中的 IPC 约定。
 */
const api = {
  // ---- 配置 ----
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_READ),
  updateConfig: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_WRITE, patch),
  onConfigChanged: (fn: (config: AppConfig) => void) => {
    const handler = (_e: unknown, config: AppConfig) => fn(config);
    ipcRenderer.on(IPC.CONFIG_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.CONFIG_CHANGED, handler);
  },

  // ---- LLM ----
  chat: (payload: { requestId: string; sessionId: string; history: ChatMessage[]; text: string; images?: string[] }) =>
    ipcRenderer.invoke(IPC.LLM_CHAT, payload),
  abortChat: (requestId: string) => ipcRenderer.invoke(IPC.LLM_ABORT, requestId),
  testLlm: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.LLM_TEST),
  onChatStream: (fn: (event: StreamEvent & { requestId: string }) => void) => {
    const handler = (_e: unknown, event: StreamEvent & { requestId: string }) => fn(event);
    ipcRenderer.on(IPC.LLM_CHAT_STREAM, handler);
    return () => ipcRenderer.removeListener(IPC.LLM_CHAT_STREAM, handler);
  },

  // ---- 语音 ----
  transcribe: (audioBase64: string, mime?: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke(IPC.STT_TRANSCRIBE, audioBase64, mime),
  synthesize: (text: string, engine?: string): Promise<{ audioBase64: string; mime: string } | null> =>
    ipcRenderer.invoke(IPC.TTS_SYNTHESIZE, text, engine),
  testTts: (engine?: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.VOICE_TEST_TTS, engine),
  testStt: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.VOICE_TEST_STT),

  // ---- 模型 ----
  listModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.MODEL_LIST),
  getModelDir: (): Promise<string> => ipcRenderer.invoke(IPC.MODEL_GET_DIR),

  // ---- 历史 ----
  listSessions: (): Promise<HistorySession[]> => ipcRenderer.invoke(IPC.HISTORY_SESSIONS),
  newSession: (title?: string): Promise<HistorySession> => ipcRenderer.invoke(IPC.HISTORY_NEW_SESSION, title),
  queryHistory: (sessionId: string): Promise<HistoryRecord[]> => ipcRenderer.invoke(IPC.HISTORY_QUERY, sessionId),
  addHistory: (record: Omit<HistoryRecord, 'id'>) => ipcRenderer.invoke(IPC.HISTORY_ADD, record),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.HISTORY_DELETE_SESSION, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.HISTORY_RENAME_SESSION, id, title),
  clearHistory: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR_ALL),
  exportHistory: () => ipcRenderer.invoke(IPC.HISTORY_EXPORT),

  // ---- 插件 ----
  listPlugins: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.PLUGIN_LIST),
  invokeTool: (pluginId: string, tool: string, args: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.PLUGIN_INVOKE_TOOL, pluginId, tool, args),

  // ---- 窗口 / 系统 ----
  minimize: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
  closeToTray: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
  setWindowMode: (mode: 'expanded' | 'compact' | 'bare'): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke(IPC.WINDOW_SET_COMPACT, mode),
  focusWindow: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_FOCUS),
  moveWindowBy: (dx: number, dy: number): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_MOVE_BY, dx, dy),
  quit: () => ipcRenderer.invoke(IPC.APP_QUIT),
  notify: (title: string, body: string) => ipcRenderer.invoke(IPC.TRAY_NOTIFY, title, body),
  onShortcut: (fn: (action: string) => void) => {
    const handler = (_e: unknown, action: string) => fn(action);
    ipcRenderer.on(IPC.SHORTCUT_FIRED, handler);
    return () => ipcRenderer.removeListener(IPC.SHORTCUT_FIRED, handler);
  },
  onOpenSettings: (fn: () => void) => {
    const handler = () => fn();
    ipcRenderer.on(IPC.OPEN_SETTINGS, handler);
    return () => ipcRenderer.removeListener(IPC.OPEN_SETTINGS, handler);
  },

  /** 是否运行在 Electron 环境（浏览器开发模式下为 false） */
  isElectron: true,
};

export type AssistantApi = typeof api;

contextBridge.exposeInMainWorld('assistant', api);

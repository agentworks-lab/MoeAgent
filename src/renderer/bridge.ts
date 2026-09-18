import type {
  AppConfig,
  ChatMessage,
  HistoryRecord,
  HistorySession,
  ModelInfo,
  PluginInfo,
  StreamEvent,
} from '../shared/types';
import { DemoClient, stripEmotionTags } from '../shared/demo';
import { DEFAULT_CONFIG, deepMergeConfig } from '../shared/defaults';

/**
 * 统一桥接层：渲染进程通过 AssistantBridge 访问主进程能力。
 * - Electron 环境：委托 window.assistant（preload contextBridge 暴露）
 * - 浏览器开发模式：使用内存实现（演示 LLM + localStorage 历史），
 *   便于在无桌面环境下验证完整交互闭环。
 */
export interface AssistantBridge {
  isElectron: boolean;
  getConfig(): Promise<AppConfig>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  onConfigChanged(fn: (config: AppConfig) => void): () => void;

  chat(payload: { requestId: string; sessionId: string; history: ChatMessage[]; text: string; images?: string[] }): Promise<unknown>;
  abortChat(requestId: string): Promise<unknown>;
  testLlm(): Promise<{ ok: boolean; message: string }>;
  onChatStream(fn: (event: StreamEvent & { requestId: string }) => void): () => void;

  transcribe(audioBase64: string, mime?: string): Promise<{ text: string; error?: string }>;
  synthesize(text: string, engine?: string): Promise<{ audioBase64: string; mime: string } | null>;
  testTts(engine?: string): Promise<{ ok: boolean; message: string }>;
  testStt(): Promise<{ ok: boolean; message: string }>;

  listModels(): Promise<ModelInfo[]>;

  listSessions(): Promise<HistorySession[]>;
  newSession(title?: string): Promise<HistorySession>;
  queryHistory(sessionId: string): Promise<HistoryRecord[]>;
  addHistory(record: Omit<HistoryRecord, 'id'>): Promise<unknown>;
  deleteSession(id: string): Promise<unknown>;
  renameSession(id: string, title: string): Promise<unknown>;
  clearHistory(): Promise<unknown>;

  listPlugins(): Promise<PluginInfo[]>;

  minimize(): Promise<unknown>;
  closeToTray(): Promise<unknown>;
  setWindowMode(mode: 'expanded' | 'compact' | 'bare'): Promise<{ x: number; y: number; width: number; height: number } | null>;
  focusWindow(): Promise<boolean>;
  moveWindowBy(dx: number, dy: number): Promise<boolean>;
  quit(): Promise<unknown>;
  notify(title: string, body: string): Promise<unknown>;
  onShortcut(fn: (action: string) => void): () => void;
  onOpenSettings(fn: () => void): () => void;
}

/* ---------------- Electron 实现 ---------------- */

declare global {
  interface Window {
    assistant?: import('../preload/index').AssistantApi;
  }
}

function createElectronBridge(api: import('../preload/index').AssistantApi): AssistantBridge {
  return {
    isElectron: true,
    getConfig: () => api.getConfig(),
    updateConfig: (patch) => api.updateConfig(patch as Partial<AppConfig>),
    onConfigChanged: (fn) => api.onConfigChanged(fn),
    chat: (payload) => api.chat(payload),
    abortChat: (id) => api.abortChat(id),
    testLlm: () => api.testLlm(),
    onChatStream: (fn) => api.onChatStream(fn),
    transcribe: (b64, mime) => api.transcribe(b64, mime),
    synthesize: (text, engine) => api.synthesize(text, engine),
    testTts: (engine) => api.testTts(engine),
    testStt: () => api.testStt(),
    listModels: () => api.listModels(),
    listSessions: () => api.listSessions(),
    newSession: (title) => api.newSession(title),
    queryHistory: (id) => api.queryHistory(id),
    addHistory: (r) => api.addHistory(r),
    deleteSession: (id) => api.deleteSession(id),
    renameSession: (id, title) => api.renameSession(id, title),
    clearHistory: () => api.clearHistory(),
    listPlugins: () => api.listPlugins(),
    minimize: () => api.minimize(),
    closeToTray: () => api.closeToTray(),
    setWindowMode: (mode) => api.setWindowMode(mode),
    focusWindow: () => api.focusWindow(),
    moveWindowBy: (dx, dy) => api.moveWindowBy(dx, dy),
    quit: () => api.quit(),
    notify: (t, b) => api.notify(t, b),
    onShortcut: (fn) => api.onShortcut(fn),
    onOpenSettings: (fn) => api.onOpenSettings(fn),
  };
}

/* ---------------- 浏览器（开发模式）实现 ---------------- */

const BROWSER_CONFIG_KEY = 'l2d_assistant_config';
const BROWSER_SESSIONS_KEY = 'l2d_assistant_sessions';
const BROWSER_MESSAGES_KEY = 'l2d_assistant_messages';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function createBrowserBridge(): AssistantBridge {
  // 与默认配置深合并：localStorage 中的旧配置缺失的新字段会自动补齐。
  // 注意用 ?? {} —— 传 null 会被 deepMergeConfig 当作「显式置空」而返回 null。
  let config: AppConfig = deepMergeConfig(DEFAULT_CONFIG, loadJson<unknown>(BROWSER_CONFIG_KEY, null) ?? {});

  const configListeners = new Set<(c: AppConfig) => void>();
  const streamListeners = new Set<(e: StreamEvent & { requestId: string }) => void>();
  const activeAborts = new Map<string, AbortController>();
  const demo = new DemoClient();

  return {
    isElectron: false,

    async getConfig() {
      return config;
    },
    async updateConfig(patch) {
      // 深合并，与主进程 ConfigStore 行为一致（允许只传部分嵌套字段）
      config = deepMergeConfig(config, patch);
      saveJson(BROWSER_CONFIG_KEY, config);
      configListeners.forEach((fn) => fn(config));
      return config;
    },
    onConfigChanged(fn) {
      configListeners.add(fn);
      return () => configListeners.delete(fn);
    },

    async chat(payload) {
      const controller = new AbortController();
      activeAborts.set(payload.requestId, controller);
      void (async () => {
        try {
          const messages: ChatMessage[] = [
            { role: 'system', content: config.llm.systemPrompt },
            ...payload.history,
            { role: 'user', content: payload.text },
          ];
          await demo.chatStream(
            messages,
            (ev) => streamListeners.forEach((fn) => fn({ ...ev, requestId: payload.requestId })),
            controller.signal
          );
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            streamListeners.forEach((fn) => fn({ type: 'error', data: (err as Error).message, requestId: payload.requestId }));
          }
        } finally {
          activeAborts.delete(payload.requestId);
        }
      })();
      return { accepted: true };
    },
    async abortChat(requestId) {
      activeAborts.get(requestId)?.abort();
      return true;
    },
    async testLlm() {
      return demo.test();
    },
    onChatStream(fn) {
      streamListeners.add(fn);
      return () => streamListeners.delete(fn);
    },

    async transcribe(audioBase64, mime) {
      // 浏览器模式直连 Whisper 兼容接口（需后端允许跨域，本地服务通常可用）
      const baseUrl = (config.voice.whisperBaseUrl || config.llm.baseUrl || '').trim();
      if (!baseUrl) return { text: '', error: '未配置 STT 地址' };
      try {
        const binary = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
        const ext = (mime || '').includes('mp4') ? 'mp4' : (mime || '').includes('ogg') ? 'ogg' : 'webm';
        const form = new FormData();
        form.append('file', new Blob([binary], { type: mime || 'audio/webm' }), `audio.${ext}`);
        form.append('model', config.voice.whisperModel || 'whisper-1');
        form.append('language', 'zh');
        const apiKey = (config.voice.whisperApiKey || config.llm.apiKey || '').trim();
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          body: form,
        });
        if (!res.ok) return { text: '', error: `HTTP ${res.status}` };
        const json = (await res.json()) as { text?: string };
        return { text: (json.text ?? '').trim() };
      } catch (err) {
        return { text: '', error: (err as Error).message };
      }
    },
    async synthesize(text, engine) {
      // 浏览器模式直连 OpenAI 兼容 TTS（需后端允许跨域）
      const use = engine ?? config.voice.ttsEngine;
      if (use !== 'openai') return null; // edge 需主进程；browser 由渲染层 speechSynthesis 处理
      const baseUrl = (config.voice.openaiTtsBaseUrl || config.llm.baseUrl || '').trim();
      if (!baseUrl) return null;
      try {
        const apiKey = (config.voice.openaiTtsApiKey || config.llm.apiKey || '').trim();
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.voice.openaiTtsModel || 'gpt-4o-mini-tts',
            voice: config.voice.openaiTtsVoice || 'alloy',
            input: text,
            response_format: 'mp3',
          }),
        });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (const b of buf) bin += String.fromCharCode(b);
        return {
          audioBase64: btoa(bin),
          mime: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
        };
      } catch {
        return null;
      }
    },
    async testTts(engine) {
      const use = engine ?? config.voice.ttsEngine;
      if (use === 'browser') return { ok: true, message: '浏览器语音引擎无需后端，可直接试听' };
      if (use === 'edge') return { ok: false, message: 'Edge TTS 仅在桌面版可用（需主进程）' };
      const audio = await this.synthesize('语音服务连接正常。', 'openai');
      return audio
        ? { ok: true, message: `合成成功（${Math.round((audio.audioBase64.length * 3) / 4 / 1024)} KB）` }
        : { ok: false, message: '合成失败，请检查地址/密钥/跨域设置' };
    },
    async testStt() {
      const baseUrl = (config.voice.whisperBaseUrl || config.llm.baseUrl || '').trim();
      if (!baseUrl) return { ok: false, message: '未配置 STT 地址' };
      return {
        ok: true,
        message: `将使用 ${baseUrl.replace(/\/+$/, '')}/audio/transcriptions（model=${config.voice.whisperModel}）`,
      };
    },

    async listModels() {
      return [{ name: 'Mao', dir: 'models/Mao', model3: 'models/Mao/Mao.model3.json', url: './models/Mao/Mao.model3.json' }];
    },

    async listSessions() {
      return loadJson<HistorySession[]>(BROWSER_SESSIONS_KEY, []).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async newSession(title = '新对话') {
      const now = Date.now();
      const session: HistorySession = {
        id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      const sessions = loadJson<HistorySession[]>(BROWSER_SESSIONS_KEY, []);
      sessions.push(session);
      saveJson(BROWSER_SESSIONS_KEY, sessions);
      return session;
    },
    async queryHistory(sessionId) {
      return loadJson<HistoryRecord[]>(BROWSER_MESSAGES_KEY, [])
        .filter((m) => m.sessionId === sessionId)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },
    async addHistory(record) {
      const messages = loadJson<HistoryRecord[]>(BROWSER_MESSAGES_KEY, []);
      messages.push({ ...record, createdAt: record.createdAt ?? Date.now() });
      saveJson(BROWSER_MESSAGES_KEY, messages);
      const sessions = loadJson<HistorySession[]>(BROWSER_SESSIONS_KEY, []);
      const s = sessions.find((x) => x.id === record.sessionId);
      if (s) {
        s.updatedAt = Date.now();
        s.messageCount = (s.messageCount ?? 0) + 1;
        if (record.role === 'user' && s.messageCount <= 1) s.title = stripEmotionTags(record.content).slice(0, 20) || s.title;
        saveJson(BROWSER_SESSIONS_KEY, sessions);
      }
      return true;
    },
    async deleteSession(id) {
      saveJson(BROWSER_SESSIONS_KEY, loadJson<HistorySession[]>(BROWSER_SESSIONS_KEY, []).filter((s) => s.id !== id));
      saveJson(BROWSER_MESSAGES_KEY, loadJson<HistoryRecord[]>(BROWSER_MESSAGES_KEY, []).filter((m) => m.sessionId !== id));
      return true;
    },
    async renameSession(id, title) {
      const sessions = loadJson<HistorySession[]>(BROWSER_SESSIONS_KEY, []);
      const s = sessions.find((x) => x.id === id);
      if (s) s.title = title;
      saveJson(BROWSER_SESSIONS_KEY, sessions);
      return true;
    },
    async clearHistory() {
      saveJson(BROWSER_SESSIONS_KEY, []);
      saveJson(BROWSER_MESSAGES_KEY, []);
      return true;
    },

    async listPlugins() {
      return [];
    },

    async minimize() {
      return true;
    },
    async closeToTray() {
      return true;
    },
    async setWindowMode() {
      return null;
    },
    async focusWindow() {
      window.focus();
      return true;
    },
    async moveWindowBy() {
      return true;
    },
    async quit() {
      window.close();
      return true;
    },
    async notify(title, body) {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body });
        }
      } catch {
        /* ignore */
      }
      return true;
    },
    onShortcut() {
      return () => undefined;
    },
    onOpenSettings() {
      return () => undefined;
    },
  };
}

export const bridge: AssistantBridge =
  typeof window !== 'undefined' && window.assistant ? createElectronBridge(window.assistant) : createBrowserBridge();

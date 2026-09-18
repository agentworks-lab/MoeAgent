import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  screen,
  Tray,
} from 'electron';
import { ConfigStore } from './config';
import { HistoryStore } from './storage';
import { createClient, extractEmotions, OpenAiClient, type LlmClientLike, type ToolDef } from './llm/client';
import { TtsService } from './voice/tts';
import { SttService } from './voice/stt';
import { PluginHost } from './plugins/host';
import { IPC } from '../shared/ipc';
import type { AppConfig, ChatMessage, ModelInfo, StreamEvent, WindowMode } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 当前档位的目标窗口尺寸；尺寸守卫据此还原任何非预期变化 */
let intendedSize = { width: 520, height: 680 };

const config = new ConfigStore();
const history = new HistoryStore();
const tts = new TtsService();
const stt = new SttService();
const pluginHost = new PluginHost();

const activeStreams = new Map<string, AbortController>();

const isDev = process.env.NODE_ENV === 'development';

function assetsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets');
}

/* ---------------- 模型资源协议 ---------------- */

/**
 * 自定义协议 l2dmodel://：把 assetsDir()/models 目录供给渲染层加载。
 * 模型位于 asar 之外的 resources/assets/models（用户可自行添加），渲染层无法用
 * 相对路径 ./models（只指向 asar 内只读副本）读到，故统一经本协议供给；
 * model3.json 内的相对引用（贴图/动作/声音）也会在同协议下正确解析。
 */
const MODEL_SCHEME = 'l2dmodel';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MODEL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function registerModelProtocol(): void {
  protocol.handle(MODEL_SCHEME, async (request) => {
    try {
      const root = path.join(assetsDir(), 'models');
      // standard scheme 会把首段路径当作 host，故用固定 host=models，rel 只从 pathname 取
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(root, rel));
      // 防目录穿越：必须落在 models 根目录内
      if (file !== root && !file.startsWith(root + path.sep)) {
        return new Response('Not Found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(file).toString());
      // 渲染层源与本协议不同源，XHR/fetch 加载模型与贴图需 CORS 放行
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      console.error('[l2dmodel] handler error:', request.url, err);
      return new Response('Bad Request', { status: 400 });
    }
  });
}

/* ---------------- 窗口 ---------------- */

function createWindow(): void {
  // Linux 下 transparent 窗口会禁用 GPU 加速（WebGL 不可用），
  // 因此提供 NO_TRANSPARENT=1 开关用于 Linux / 无头环境测试。
  // Windows / macOS 透明窗口支持 WebGL，保持默认透明以实现无边框角色悬浮。
  const useTransparent = process.env.NO_TRANSPARENT !== '1';
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    // 最小尺寸与 applyWindowMode 的钳制下限保持一致，确保「紧凑态」能真正缩小
    minWidth: 280,
    minHeight: 240,
    frame: false,
    transparent: useTransparent,
    backgroundColor: useTransparent ? undefined : '#0f172a',
    alwaysOnTop: true,
    // 不可手动调整大小：禁用 Windows Aero Snap/最大化吸附（拖到边缘/顶部时系统会把窗口放大）。
    // 程序化 setBounds（自动伸缩 expanded/compact）不受影响，仍正常工作。
    resizable: false,
    // 禁止最大化（含拖到屏幕顶部的吸附最大化）
    maximizable: false,
    // 隐藏任务栏图标：桌面助手仅通过系统托盘与悬浮窗呈现
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 尺寸守卫：任何非预期的窗口尺寸变化（系统吸附/最大化/杂散 resize）立即还原到当前档位目标尺寸。
  // 自动伸缩（applyWindowMode）会先更新 intendedSize 再 setBounds，故不受影响。
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    if (Math.abs(b.width - intendedSize.width) > 1 || Math.abs(b.height - intendedSize.height) > 1) {
      mainWindow.setBounds({ x: b.x, y: b.y, width: intendedSize.width, height: intendedSize.height });
    }
  });
  mainWindow.on('maximize', () => {
    mainWindow?.unmaximize();
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 居中偏右下显示
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  mainWindow.setPosition(Math.max(0, width - 560), Math.max(0, height - 720));
}

/* ---------------- 窗口自动伸缩 ---------------- */

/**
 * 在「空闲紧凑态」与「展开态」之间切换窗口尺寸。
 * 空闲时只保留角色与工具栏，尽量缩小占屏面积、减少对其它应用的遮挡。
 * 调整时保持窗口底边与水平中心不动，避免视觉跳动。
 */
function applyWindowMode(mode: WindowMode): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cfg = config.get();
  if (!cfg.appearance.autoResizeWindow) return;

  const a = cfg.appearance;
  const wantW = mode === 'expanded' ? a.expandedWidth : mode === 'compact' ? a.compactWidth : a.bareWidth;
  const wantH = mode === 'expanded' ? a.expandedHeight : mode === 'compact' ? a.compactHeight : a.bareHeight;

  const bounds = mainWindow.getBounds();
  const wa = screen.getDisplayMatching(bounds).workArea;
  const targetW = Math.round(Math.max(280, Math.min(wantW, wa.width)));
  const targetH = Math.round(Math.max(240, Math.min(wantH, wa.height)));

  const centerX = bounds.x + bounds.width / 2;
  const bottom = bounds.y + bounds.height;
  // 钳制到工作区内，避免窗口跑出屏幕
  const nx = Math.max(wa.x, Math.min(Math.round(centerX - targetW / 2), wa.x + wa.width - targetW));
  const ny = Math.max(wa.y, Math.min(Math.round(bottom - targetH), wa.y + wa.height - targetH));

  // 先记录目标尺寸，再设置；尺寸守卫据此区分「预期」与「非预期」变化
  intendedSize = { width: targetW, height: targetH };
  mainWindow.setBounds({ x: nx, y: ny, width: targetW, height: targetH });
}

/* ---------------- 托盘 ---------------- */

function createTray(): void {
  const iconPath = path.join(assetsDir(), 'icon.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Live2D 桌面助手 - Mao');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏角色',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    {
      label: '打开设置',
      click: () => {
        mainWindow?.show();
        mainWindow?.webContents.send(IPC.OPEN_SETTINGS);
      },
    },
    {
      label: '切换静音',
      click: () => {
        const next = !config.get().voice.muted;
        config.update({ voice: { muted: next } });
      },
    },
    { type: 'separator' },
    { label: '关于', click: () => notify('Live2D 桌面助手', '基于 Live2D Cubism + LLM Agent 的桌面伴侣 v1.0') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* ignore */
  }
}

/* ---------------- 快捷键 ---------------- */

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const sc = config.get().shortcuts;
  const bind = (accelerator: string, action: string) => {
    if (!accelerator) return;
    try {
      globalShortcut.register(accelerator, () => {
        mainWindow?.webContents.send(IPC.SHORTCUT_FIRED, action);
      });
    } catch (err) {
      console.warn(`[shortcut] 注册失败 ${accelerator}:`, err);
    }
  };
  bind(sc.toggleCharacter, 'toggleCharacter');
  bind(sc.pushToTalk, 'pushToTalk');
  bind(sc.toggleMute, 'toggleMute');
  bind(sc.openSettings, 'openSettings');
}

/* ---------------- LLM ---------------- */

function buildLlmMessages(cfg: AppConfig, historyMsgs: ChatMessage[], userText: string, images?: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: cfg.llm.systemPrompt }];
  const windowMsgs = historyMsgs.slice(-cfg.llm.contextWindow);
  messages.push(...windowMsgs);
  messages.push({ role: 'user', content: userText, ...(images && images.length > 0 ? { images } : {}) });
  return messages;
}

async function runLlmChat(
  requestId: string,
  sessionId: string,
  historyMsgs: ChatMessage[],
  userText: string,
  images?: string[]
): Promise<void> {
  const cfg = config.get();
  const client = createClient(cfg.llm);
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  const send = (event: StreamEvent) => {
    mainWindow?.webContents.send(IPC.LLM_CHAT_STREAM, { requestId, ...event });
  };

  // 持久化用户消息（含附带图片）
  history.addMessage({
    sessionId,
    role: 'user',
    content: userText,
    ...(images && images.length > 0 ? { images } : {}),
  });
  pluginHost.broadcast({ type: 'userMessage', sessionId, content: userText });

  try {
    const messages = buildLlmMessages(cfg, historyMsgs, userText, images);
    let fullText = '';
    await chatWithTools(client, cfg, messages, (ev) => {
      if (ev.type === 'token') fullText += ev.data;
      send(ev);
    }, controller.signal);

    const emotions = extractEmotions(fullText);
    const clean = fullText.replace(/\[emotion:\s*[a-zA-Z_]+\s*\]/g, '').trim();
    history.addMessage({ sessionId, role: 'assistant', content: clean, emotion: emotions[0] ?? null });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      send({ type: 'error', data: (err as Error).message });
    }
  } finally {
    activeStreams.delete(requestId);
  }
}

/**
 * 支持 Function Calling 的对话：若模型返回 tool_calls，
 * 通过插件宿主执行工具后携带结果再次请求（最多两轮）。
 */
async function chatWithTools(
  client: LlmClientLike,
  cfg: AppConfig,
  messages: ChatMessage[],
  onEvent: (ev: StreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const tools = pluginHost.allTools();

  // 演示模式或无工具：直接流式
  if (cfg.llm.provider !== 'openai' || tools.length === 0) {
    await client.chatStream(messages, onEvent, signal);
    return;
  }

  const raw = client instanceof OpenAiClient ? client : new OpenAiClient(cfg.llm);
  const toolDefs: ToolDef[] = tools.map(({ tool }) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  for (let round = 0; round < 2; round++) {
    const { text, toolCalls } = await raw.chatStreamWithTools(messages, toolDefs, onEvent, signal);
    if (toolCalls.length === 0) return;

    messages.push({ role: 'assistant', content: text || '[调用工具]' });
    for (const tc of toolCalls) {
      onEvent({ type: 'tool', data: `调用工具 ${tc.name}...` });
      let result: string;
      try {
        const provider = tools.find((t) => t.tool.name === tc.name);
        const out = provider
          ? await pluginHost.invokeTool(provider.pluginId, tc.name, tc.arguments)
          : { error: `未知工具 ${tc.name}` };
        result = JSON.stringify(out);
      } catch (err) {
        result = JSON.stringify({ error: (err as Error).message });
      }
      messages.push({ role: 'tool', content: result });
    }
  }
  // 两轮工具后强制纯文本收尾
  await raw.chatStream(messages, onEvent, signal);
}

/* ---------------- IPC ---------------- */

function registerIpc(): void {
  // 配置
  ipcMain.handle(IPC.CONFIG_READ, () => config.get());
  ipcMain.handle(IPC.CONFIG_WRITE, (_e, patch: unknown) => config.update(patch));

  // 对话历史
  ipcMain.handle(IPC.HISTORY_SESSIONS, () => history.listSessions());
  ipcMain.handle(IPC.HISTORY_NEW_SESSION, (_e, title?: string) => history.newSession(title));
  ipcMain.handle(IPC.HISTORY_QUERY, (_e, sessionId: string) => history.queryMessages(sessionId));
  ipcMain.handle(IPC.HISTORY_ADD, (_e, record) => history.addMessage(record));
  ipcMain.handle(IPC.HISTORY_DELETE_SESSION, (_e, id: string) => history.deleteSession(id));
  ipcMain.handle(IPC.HISTORY_RENAME_SESSION, (_e, id: string, title: string) => history.renameSession(id, title));
  ipcMain.handle(IPC.HISTORY_CLEAR_ALL, () => history.clearAll());
  ipcMain.handle(IPC.HISTORY_EXPORT, () => history.exportAll());

  // LLM
  ipcMain.handle(
    IPC.LLM_CHAT,
    (_e, payload: { requestId: string; sessionId: string; history: ChatMessage[]; text: string; images?: string[] }) => {
      void runLlmChat(payload.requestId, payload.sessionId, payload.history, payload.text, payload.images);
      return { accepted: true };
    }
  );
  ipcMain.handle(IPC.LLM_ABORT, (_e, requestId: string) => {
    activeStreams.get(requestId)?.abort();
    return true;
  });
  ipcMain.handle(IPC.LLM_TEST, async () => {
    const client = createClient(config.get().llm);
    return await client.test();
  });

  // 语音
  ipcMain.handle(IPC.STT_TRANSCRIBE, (_e, audioBase64: string, mime?: string) =>
    stt.transcribe(audioBase64, config.get(), mime)
  );
  ipcMain.handle(IPC.TTS_SYNTHESIZE, (_e, text: string, engine?: string) =>
    tts.synthesize(text, config.get(), engine)
  );
  ipcMain.handle(IPC.TTS_STOP, () => true);
  // 语音自检：合成一句短文本，验证 TTS 后端可用性
  ipcMain.handle(IPC.VOICE_TEST_TTS, async (_e, engine?: string) => {
    const cfg = config.get();
    const use = engine ?? cfg.voice.ttsEngine;
    if (use === 'browser') return { ok: true, message: '浏览器语音引擎无需后端，可直接试听' };
    const audio = await tts.synthesize('语音服务连接正常。', cfg, use);
    return audio
      ? { ok: true, message: `${use} 合成成功（${Math.round((audio.audioBase64.length * 3) / 4 / 1024)} KB）` }
      : { ok: false, message: `${use} 合成失败，请检查地址/密钥，详见主进程日志` };
  });
  // STT 配置自检
  ipcMain.handle(IPC.VOICE_TEST_STT, () => {
    const cfg = config.get();
    const baseUrl = (cfg.voice.whisperBaseUrl || cfg.llm.baseUrl || '').trim();
    if (!baseUrl) return { ok: false, message: '未配置 STT 地址' };
    return {
      ok: true,
      message: `将使用 ${baseUrl.replace(/\/+$/, '')}/audio/transcriptions（model=${cfg.voice.whisperModel}）`,
    };
  });

  // 模型
  ipcMain.handle(IPC.MODEL_LIST, (): ModelInfo[] => {
    const root = path.join(assetsDir(), 'models');
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(root, d.name);
        const files = fs.readdirSync(dir);
        // 兼容 Cubism4（.model3.json）与 Cubism2（.model.json），不假设与文件夹同名
        const modelFile = files.find((f) => f.endsWith('.model3.json')) ?? files.find((f) => f.endsWith('.model.json'));
        if (!modelFile) return null;
        const rel = path.relative(root, path.join(dir, modelFile)).split(path.sep).join('/');
        return { name: d.name, dir, model3: path.join(dir, modelFile), url: `${MODEL_SCHEME}://models/${rel}` };
      })
      .filter((x): x is ModelInfo => x !== null);
  });
  ipcMain.handle(IPC.MODEL_GET_DIR, () => path.join(assetsDir(), 'models'));

  // 插件
  ipcMain.handle(IPC.PLUGIN_LIST, () => pluginHost.list());
  ipcMain.handle(IPC.PLUGIN_INVOKE_TOOL, (_e, pluginId: string, tool: string, args: Record<string, unknown>) =>
    pluginHost.invokeTool(pluginId, tool, args)
  );

  // 窗口
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IPC.WINDOW_CLOSE, () => mainWindow?.hide());
  ipcMain.handle(IPC.WINDOW_SET_COMPACT, (_e, mode: WindowMode) => {
    applyWindowMode(mode);
    return mainWindow ? mainWindow.getBounds() : null;
  });
  ipcMain.handle(IPC.WINDOW_FOCUS, () => {
    mainWindow?.focus();
    return true;
  });
  ipcMain.handle(IPC.WINDOW_MOVE_BY, (_e, dx: number, dy: number) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const b = mainWindow.getBounds();
    mainWindow.setPosition(Math.round(b.x + dx), Math.round(b.y + dy));
    return true;
  });
  ipcMain.handle(IPC.APP_QUIT, () => app.quit());
  ipcMain.handle(IPC.TRAY_NOTIFY, (_e, title: string, body: string) => notify(title, body));
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  // macOS：隐藏 Dock 图标（Windows/Linux 由 skipTaskbar 处理）
  if (process.platform === 'darwin') {
    try {
      app.dock?.hide();
    } catch {
      /* ignore */
    }
  }
  registerIpc();
  registerModelProtocol();
  await pluginHost.loadAll();
  createWindow();
  createTray();
  registerShortcuts();
  config.watch();
  config.onChange(() => {
    registerShortcuts();
    mainWindow?.webContents.send(IPC.CONFIG_CHANGED, config.get());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // 桌面助手：关闭窗口仅隐藏到托盘，不退出（macOS 惯例一致）
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void pluginHost.dispose();
  tts.dispose();
  history.dispose();
  config.dispose();
});

/* ---------------- 冒烟测试（SMOKE_TEST=1 时自动验证核心链路） ---------------- */

if (process.env.SMOKE_TEST === '1') {
  app.whenReady().then(async () => {
    const results: string[] = [];
    const check = (name: string, ok: boolean, detail = '') => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };

    try {
      // 等待窗口加载完成
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (mainWindow && !mainWindow.webContents.isLoading()) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 15000);
      });
      await new Promise((r) => setTimeout(r, 2000));

      // 1. preload bridge 暴露
      const hasBridge = await mainWindow!.webContents.executeJavaScript('!!window.assistant');
      check('preload bridge', hasBridge === true);

      // 2. 配置读写
      const cfg = config.get();
      check('config read', cfg.llm.provider === 'demo');
      check('默认语音引擎为 Edge TTS', cfg.voice.ttsEngine === 'edge', cfg.voice.ttsEngine);
      check('默认开启窗口自动伸缩', cfg.appearance.autoResizeWindow === true);

      // 3. 会话与历史
      const session = history.newSession('冒烟测试');
      history.addMessage({ sessionId: session.id, role: 'user', content: '你好' });
      const msgs = history.queryMessages(session.id);
      check('history store', msgs.length === 1 && msgs[0].content === '你好');
      const found = history.search('你好');
      check('history search (FTS5)', found.length >= 1);

      // 删除会话（回归：旧版 FTS 删除触发器命令错误导致删除失败；并校验 FTS 索引同步清除）
      const delTarget = history.newSession('待删除');
      history.addMessage({ sessionId: delTarget.id, role: 'user', content: '删除测试' });
      history.deleteSession(delTarget.id);
      check(
        '删除会话(含FTS索引)',
        history.listSessions().find((s) => s.id === delTarget.id) === undefined && history.search('删除测试').length === 0
      );

      // 历史图片存取（images 列 JSON 往返）
      const imgSession = history.newSession('图片测试');
      history.addMessage({ sessionId: imgSession.id, role: 'user', content: '看图', images: ['data:image/png;base64,QUJD'] });
      const imgMsgs = history.queryMessages(imgSession.id);
      check(
        '历史图片存取',
        Array.isArray(imgMsgs[0]?.images) && (imgMsgs[0].images as string[])[0].startsWith('data:image/png')
      );
      history.deleteSession(imgSession.id);

      // 多模态消息转换（带图用户消息 → text + image_url content 数组）
      const { toApiMessages } = await import('./llm/client');
      const apiMsgs = toApiMessages([
        { role: 'user', content: 'hi', images: ['data:image/png;base64,AAA'] },
        { role: 'assistant', content: 'hello' },
      ]) as { role: string; content: unknown }[];
      const firstContent = apiMsgs[0].content as { type: string }[];
      check(
        '多模态消息转换',
        Array.isArray(firstContent) && firstContent[0].type === 'text' && firstContent[1].type === 'image_url' &&
          !Array.isArray(apiMsgs[1].content)
      );

      // 4. 插件工具调用
      const toolResult = await pluginHost.invokeTool('example-time-tool', 'get_current_time', {});
      check('plugin tool', (toolResult as { ok?: boolean }).ok === true);

      // 5. LLM 演示模式流式对话（含情感标签）
      const { createClient: cc } = await import('./llm/client');
      const client = cc(config.get().llm);
      let tokens = '';
      let emotion = '';
      await client.chatStream(
        [{ role: 'user', content: '你好' }],
        (ev) => {
          if (ev.type === 'token') tokens += ev.data;
          if (ev.type === 'emotion') emotion = ev.data;
        },
        AbortSignal.timeout(20000)
      );
      check('llm demo stream', tokens.length > 10, `${tokens.length} chars`);
      check('emotion tag', emotion === 'happy', emotion);

      // 6. 渲染层 UI 挂载
      const uiReady = await mainWindow!.webContents.executeJavaScript(
        `document.querySelectorAll('textarea').length > 0 && document.querySelectorAll('button').length > 3`
      );
      check('renderer UI', uiReady === true);

      // 6.5 Live2D 画布与模型加载状态
      const renderInfo = (await mainWindow!.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector('canvas');
        const c2 = document.createElement('canvas');
        return {
          canvasCount: document.querySelectorAll('canvas').length,
          canvasSize: canvas ? canvas.width + 'x' + canvas.height : 'none',
          placeholderShown: document.body.innerText.includes('占位形象'),
          rawWebgl: !!(c2.getContext('webgl2') || c2.getContext('webgl')),
        };
      })()`) ) as { canvasCount: number; canvasSize: string; placeholderShown: boolean; rawWebgl: boolean };
      check(
        'live2d canvas',
        renderInfo.canvasCount === 1,
        `${renderInfo.canvasSize} placeholder=${renderInfo.placeholderShown} rawWebgl=${renderInfo.rawWebgl}`
      );
      if (!renderInfo.placeholderShown && renderInfo.canvasCount === 1) {
        check('live2d webgl render', true, 'WebGL 可用，模型已渲染（无占位符）');
      }

      // 6.6 动画更新循环（防止 ticker 未驱动导致角色静止的回归）
      if (!renderInfo.placeholderShown) {
        const anim = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const stage = window.__live2dStage;
          if (!stage || !stage.diagnostics().loaded) return { ok: false, reason: 'stage 未就绪' };
          const t0 = stage.diagnostics();
          await new Promise(r => setTimeout(r, 1500));
          const t1 = stage.diagnostics();
          return {
            ok: true,
            deltaElapsed: Number(t1.elapsedTime) - Number(t0.elapsedTime),
            tickerAttached: t1.tickerAttached,
            motionGroup: t1.currentMotionGroup,
            angle0: Number(t0.ParamAngleZ),
            angle1: Number(t1.ParamAngleZ),
          };
        })()`)) as {
          ok: boolean;
          reason?: string;
          deltaElapsed: number;
          tickerAttached: boolean;
          motionGroup: string | null;
          angle0: number;
          angle1: number;
        };
        check('动画 ticker 已挂载', anim.ok === true && anim.tickerAttached === true, anim.reason ?? '');
        check(
          '模型时钟持续推进（角色在动）',
          anim.ok === true && anim.deltaElapsed > 800,
          `Δ=${Math.round(anim.deltaElapsed)}ms / 1500ms`
        );
        check(
          'idle 动作组运行中',
          anim.ok === true && anim.motionGroup === 'Idle',
          `group=${anim.motionGroup}`
        );

        // 表情映射驱动验证
        const expr = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const stage = window.__live2dStage;
          const before = stage.diagnostics().currentExpressionIndex;
          stage.applyEmotion('angry');
          await new Promise(r => setTimeout(r, 1000));
          const after = stage.diagnostics().currentExpressionIndex;
          stage.setLipSync(0.8); stage.startSpeaking();
          await new Promise(r => setTimeout(r, 250));
          const lip = Number(stage.diagnostics().ParamA);
          stage.stopSpeaking();
          return { before, after, lip };
        })()`)) as { before: number | null; after: number | null; lip: number };
        check('情感映射切换表情', expr.after !== null && expr.after !== expr.before, `${expr.before} → ${expr.after}`);
        check('口型参数被驱动', Math.abs(expr.lip - 0.8) < 0.2, `ParamA=${expr.lip.toFixed(3)}`);

        // 6.7 UI 层叠命中测试：canvas 开启 pointer-events 后不得遮挡控件
        const hit = (await mainWindow!.webContents.executeJavaScript(`(() => {
          const ta = document.querySelector('textarea');
          const btn = document.querySelectorAll('button')[0];
          const canvas = document.querySelector('canvas');
          const tag = (el) => el ? el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0,2).join('.') : 'null';
          const at = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
            return { el: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; };
          const hitTa = at(ta);
          const hitBtn = at(btn);
          const pt = document.elementFromPoint(260, 200);
          return {
            taOk: hitTa && hitTa.el === ta,
            taRect: hitTa ? hitTa.rect : null,
            taHitTag: hitTa ? tag(hitTa.el) : 'null',
            btnOk: !!hitBtn && (hitBtn.el === btn || !!(hitBtn.el && hitBtn.el.closest('button'))),
            btnHitTag: hitBtn ? tag(hitBtn.el) : 'null',
            charIsCanvas: pt === canvas,
            charHitTag: tag(pt),
            canvasPE: canvas ? getComputedStyle(canvas).pointerEvents : 'n/a',
            canvasRect: canvas ? (() => { const r = canvas.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null,
          };
        })()`)) as {
          taOk: boolean; taRect: number[] | null; taHitTag: string;
          btnOk: boolean; btnHitTag: string;
          charIsCanvas: boolean; charHitTag: string;
          canvasPE: string; canvasRect: number[] | null;
        };
        console.log('[命中测试详情]', JSON.stringify(hit));
        check('输入框未被 canvas 遮挡', hit.taOk === true, `命中=${hit.taHitTag} rect=${JSON.stringify(hit.taRect)}`);
        check('工具栏按钮未被遮挡', hit.btnOk === true, `命中=${hit.btnHitTag}`);
        check('角色区域命中 canvas（可点击）', hit.charIsCanvas === true, `命中=${hit.charHitTag} pe=${hit.canvasPE} canvas=${JSON.stringify(hit.canvasRect)}`);

        // 6.8 真实点击角色 → 命中测试 → 触发 TapBody 动作
        //     先停止当前动作回到 Idle，再动态扫描可命中点（Mao 的 hit area 仅覆盖头/躯干），
        //     确保验证的是 Idle → TapBody 的真实跃迁。
        const tapRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const stage = window.__live2dStage;
          stage.stopMotions();
          let before = null;
          for (let i = 0; i < 20; i++) {
            await new Promise(res => setTimeout(res, 200));
            before = stage.diagnostics().currentMotionGroup;
            if (before === 'Idle') break;
          }
          // 沿模型中线自上而下扫描，找到第一个可命中的点
          const r = stage.diagnostics().modelRect;
          const cx = r.x + r.width / 2;
          let cy = -1, hitNames = [];
          for (let y = r.y; y <= r.y + r.height; y += 8) {
            const names = stage.hitTest(cx, y);
            if (names && names.length) { cy = y; hitNames = names; break; }
          }
          if (cy < 0) return { rect: r, point: [-1, -1], hitNames: [], before, after: before };
          stage.tap(cx, cy);
          await new Promise(res => setTimeout(res, 500));
          const d1 = stage.diagnostics();
          return { rect: r, point: [Math.round(cx), cy], hitNames, before, after: d1.currentMotionGroup };
        })()`)) as {
          rect: { x: number; y: number; width: number; height: number };
          point: number[];
          hitNames: string[];
          before: string | null;
          after: string | null;
        };
        check(
          '角色 hit area 可被命中',
          tapRes.hitNames.length > 0,
          `${tapRes.hitNames.join(',') || '无'} @(${tapRes.point.join(',')})`
        );
        check(
          '点击角色触发动作(Idle→TapBody)',
          tapRes.before === 'Idle' && tapRes.after === 'TapBody',
          `${tapRes.before} → ${tapRes.after}`
        );

        // 6.9 面板限高后，设置面板底部按钮不得被裁切
        const panelRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const btns = [...document.querySelectorAll('button')];
          const settingsBtn = btns.find(b => (b.getAttribute('title') || '').match(/设置|Settings/));
          if (settingsBtn) settingsBtn.click();
          await new Promise(r => setTimeout(r, 700));
          const all = [...document.querySelectorAll('button')];
          const saveBtn = all.find(b => (b.textContent || '').match(/保存|Save/));
          if (!saveBtn) return { opened: false };
          const rect = saveBtn.getBoundingClientRect();
          const hitEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const scrollArea = document.querySelector('.chat-scroll');
          const result = {
            opened: true,
            inViewport: rect.bottom <= window.innerHeight && rect.top >= 0,
            hittable: hitEl === saveBtn || !!(hitEl && hitEl.closest('button') === saveBtn),
            rect: [Math.round(rect.top), Math.round(rect.bottom)],
            vh: window.innerHeight,
            scrollable: !!scrollArea && scrollArea.scrollHeight > scrollArea.clientHeight,
          };
          // 切回聊天面板，避免影响后续对话测试（设置面板内也有 textarea）
          const backBtn = [...document.querySelectorAll('button')]
            .find(b => (b.getAttribute('title') || '').match(/对话|Chat/));
          if (backBtn) backBtn.click();
          await new Promise(r => setTimeout(r, 400));
          return result;
        })()`)) as {
          opened: boolean; inViewport?: boolean; hittable?: boolean;
          rect?: number[]; vh?: number; scrollable?: boolean;
        };
        check('设置面板已打开', panelRes.opened === true);
        check(
          '设置面板底部按钮未被裁切',
          panelRes.inViewport === true && panelRes.hittable === true,
          `rect=${JSON.stringify(panelRes.rect)} vh=${panelRes.vh} 内部可滚动=${panelRes.scrollable}`
        );

        // 6.10 角色大小可设置（模型级缩放，宽度应按倍率变化）
        const scaleRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const stage = window.__live2dStage;
          const w0 = stage.diagnostics().modelRect.width;
          await window.assistant.updateConfig({ appearance: { modelScale: 2 } });
          await new Promise(r => setTimeout(r, 600));
          const w1 = stage.diagnostics().modelRect.width;
          await window.assistant.updateConfig({ appearance: { modelScale: 0.5 } });
          await new Promise(r => setTimeout(r, 600));
          const w2 = stage.diagnostics().modelRect.width;
          await window.assistant.updateConfig({ appearance: { modelScale: 1 } });
          await new Promise(r => setTimeout(r, 400));
          return { w0, w1, w2, r1: w1 / w0, r2: w2 / w0 };
        })()`)) as { w0: number; w1: number; w2: number; r1: number; r2: number };
        check(
          '角色放大 2x 生效',
          Math.abs(scaleRes.r1 - 2) < 0.05,
          `宽 ${scaleRes.w0} → ${scaleRes.w1} (${scaleRes.r1.toFixed(2)}x)`
        );
        check(
          '角色缩小 0.5x 生效',
          Math.abs(scaleRes.r2 - 0.5) < 0.05,
          `宽 ${scaleRes.w0} → ${scaleRes.w2} (${scaleRes.r2.toFixed(2)}x)`
        );

        // 6.11 对话框可拖拽移动并持久化
        const dragRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const handle = document.querySelector('[title*="拖动"]');
          if (!handle) return { ok: false, reason: '未找到拖拽手柄' };
          const panel = handle.closest('.glass');
          const before = getComputedStyle(panel).transform;
          const r = handle.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: cx, clientY: cy }));
          handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: cx - 60, clientY: cy - 40 }));
          await new Promise(res => setTimeout(res, 100));
          handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: cx - 60, clientY: cy - 40 }));
          await new Promise(res => setTimeout(res, 500));
          const after = getComputedStyle(panel).transform;
          const cfg = await window.assistant.getConfig();
          const rect = panel.getBoundingClientRect();
          return {
            ok: true, before, after,
            moved: before !== after,
            persisted: cfg.appearance.panelOffset,
            inWindow: rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
          };
        })()`)) as {
          ok: boolean; reason?: string; before?: string; after?: string;
          moved?: boolean; persisted?: { x: number; y: number } | null; inWindow?: boolean;
        };
        check('拖拽手柄存在', dragRes.ok === true, dragRes.reason ?? '');
        check('对话框可拖动', dragRes.moved === true, `${dragRes.before} → ${dragRes.after}`);
        check(
          '位置已持久化',
          !!dragRes.persisted && (dragRes.persisted.x !== 0 || dragRes.persisted.y !== 0),
          JSON.stringify(dragRes.persisted)
        );
        check('拖动后仍在窗口内', dragRes.inWindow === true);

        // 复位并确认
        await mainWindow!.webContents.executeJavaScript(`(async () => {
          const handle = document.querySelector('[title*="拖动"]');
          handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
        })()`);
        const resetOffset = (await mainWindow!.webContents
          .executeJavaScript(`window.assistant.getConfig().then(c => c.appearance.panelOffset)`)
          .catch(() => null)) as { x: number; y: number } | null;
        check('双击复位位置', resetOffset === null, JSON.stringify(resetOffset));

        // 6.11b 窗口自动伸缩：紧凑态缩小 / 展开态恢复，且底边保持不动
        const resizeBefore = mainWindow!.getBounds();
        await mainWindow!.webContents.executeJavaScript(`window.assistant.setWindowMode('compact')`);
        await new Promise((r) => setTimeout(r, 250));
        const resizeCompact = mainWindow!.getBounds();
        await mainWindow!.webContents.executeJavaScript(`window.assistant.setWindowMode('bare')`);
        await new Promise((r) => setTimeout(r, 250));
        const resizeBare = mainWindow!.getBounds();
        check(
          '仅角色态进一步缩小',
          resizeBare.width < resizeCompact.width && resizeBare.height < resizeCompact.height,
          `${resizeCompact.width}x${resizeCompact.height} → ${resizeBare.width}x${resizeBare.height}`
        );
        await mainWindow!.webContents.executeJavaScript(`window.assistant.setWindowMode('expanded')`);
        await new Promise((r) => setTimeout(r, 250));
        const resizeExpanded = mainWindow!.getBounds();
        check(
          '紧凑态缩小窗口',
          resizeCompact.width < resizeBefore.width && resizeCompact.height < resizeBefore.height,
          `${resizeBefore.width}x${resizeBefore.height} → ${resizeCompact.width}x${resizeCompact.height}`
        );
        check(
          '展开态恢复窗口',
          resizeExpanded.width > resizeCompact.width && resizeExpanded.height > resizeCompact.height,
          `${resizeCompact.width}x${resizeCompact.height} → ${resizeExpanded.width}x${resizeExpanded.height}`
        );
        check(
          '伸缩时底边保持不动',
          Math.abs(resizeCompact.y + resizeCompact.height - (resizeBefore.y + resizeBefore.height)) <= 2,
          `底边 ${resizeBefore.y + resizeBefore.height} → ${resizeCompact.y + resizeCompact.height}`
        );

        // 6.12 工具栏自动折叠与恢复
        const toolbarRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          await window.assistant.updateConfig({ appearance: { autoHideToolbar: true, toolbarHideDelay: 1000 } });
          // 关闭面板（聊天面板打开时工具栏不折叠）
          const chatBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').match(/对话|Chat/));
          if (chatBtn) chatBtn.click();
          await new Promise(r => setTimeout(r, 2500));
          const bar = document.querySelector('.titlebar-drag');
          const collapsed = bar ? bar.className.includes('opacity-0') : false;
          // 移动鼠标应恢复
          window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
          await new Promise(r => setTimeout(r, 400));
          const bar2 = document.querySelector('.titlebar-drag');
          const restored = bar2 ? !bar2.className.includes('opacity-0') : false;
          // 重新打开聊天面板，供后续对话测试使用
          const reopen = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').match(/对话|Chat/));
          if (reopen) reopen.click();
          await new Promise(r => setTimeout(r, 500));
          return { collapsed, restored };
        })()`)) as { collapsed: boolean; restored: boolean };
        check('无操作后工具栏自动折叠', toolbarRes.collapsed === true);
        check('移动鼠标后工具栏恢复', toolbarRes.restored === true);

        // 6.13 角色避让：面板打开时，角色矩形与面板矩形的重叠面积应≈0
        const overlap = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          // 等补间动画收敛
          await new Promise(r => setTimeout(r, 1500));
          const stage = window.__live2dStage;
          const m = stage.diagnostics().modelRect;
          const handle = document.querySelector('[title*="拖动"]');
          const panel = handle ? handle.closest('.glass') : null;
          if (!panel) return { ok: false, reason: '未找到面板' };
          const p = panel.getBoundingClientRect();
          const ox = Math.max(0, Math.min(m.x + m.width, p.right) - Math.max(m.x, p.left));
          const oy = Math.max(0, Math.min(m.y + m.height, p.bottom) - Math.max(m.y, p.top));
          const area = ox * oy;
          return {
            ok: true,
            model: [Math.round(m.x), Math.round(m.y), Math.round(m.width), Math.round(m.height)],
            panel: [Math.round(p.left), Math.round(p.top), Math.round(p.right), Math.round(p.bottom)],
            overlapPx: Math.round(area),
            ratio: area / Math.max(1, m.width * m.height),
            inWindow: m.y >= -1 && m.y + m.height <= window.innerHeight + 1,
          };
        })()`)) as {
          ok: boolean; reason?: string; model?: number[]; panel?: number[];
          overlapPx?: number; ratio?: number; inWindow?: boolean;
        };
        check('找到对话框面板', overlap.ok === true, overlap.reason ?? '');
        check(
          '角色未被对话框遮挡',
          overlap.ok === true && (overlap.ratio ?? 1) < 0.01,
          `重叠 ${overlap.overlapPx}px² (${((overlap.ratio ?? 0) * 100).toFixed(2)}%) 角色=${JSON.stringify(overlap.model)} 面板=${JSON.stringify(overlap.panel)}`
        );
        check('避让后角色仍在窗口内', overlap.inWindow === true);

        // 6.14 关闭避让 / 关闭面板后，角色应恢复占满窗口
        // 注：本用例只验证「避让」逻辑，故临时关闭窗口自动伸缩，
        // 避免关闭面板时窗口缩到紧凑态而干扰角色尺寸测量。
        const restore = (await mainWindow!.webContents.executeJavaScript(`(async () => {
          const stage = window.__live2dStage;
          const avoided = stage.diagnostics().modelRect.width;
          await window.assistant.updateConfig({ appearance: { avoidPanel: false, autoResizeWindow: false } });
          await new Promise(r => setTimeout(r, 1600));
          const noAvoid = stage.diagnostics().modelRect.width;
          // 恢复避让并关闭面板
          await window.assistant.updateConfig({ appearance: { avoidPanel: true, autoResizeWindow: false } });
          const chatBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').match(/对话|Chat/));
          if (chatBtn) chatBtn.click();
          await new Promise(r => setTimeout(r, 1600));
          const panelClosed = stage.diagnostics().modelRect.width;
          // 复原：重新打开聊天面板并恢复窗口自动伸缩
          if (chatBtn) chatBtn.click();
          await window.assistant.updateConfig({ appearance: { autoResizeWindow: true } });
          await new Promise(r => setTimeout(r, 600));
          return { avoided, noAvoid, panelClosed };
        })()`)) as { avoided: number; noAvoid: number; panelClosed: number };
        check(
          '关闭避让后角色恢复全尺寸',
          restore.noAvoid > restore.avoided * 1.5,
          `${Math.round(restore.avoided)} → ${Math.round(restore.noAvoid)}px`
        );
        check(
          '关闭面板后角色恢复全尺寸',
          restore.panelClosed > restore.avoided * 1.5,
          `${Math.round(restore.avoided)} → ${Math.round(restore.panelClosed)}px`
        );
      }

      // 7. 渲染层发起真实对话（走完整 IPC 链路）
      const msgBefore = history.exportAll().messages.length;
      const chatOk = await mainWindow!.webContents.executeJavaScript(`
        (async () => {
          const ta = document.querySelector('textarea');
          if (!ta) return { ok: false, reason: '未找到输入框（聊天面板可能未打开）' };
          const before = document.querySelectorAll('.msg-in').length;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '你好呀');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await new Promise(r => setTimeout(r, 6000));
          const after = document.querySelectorAll('.msg-in').length;
          return { ok: after > before, reason: after + ' 条消息（原 ' + before + ' 条）' };
        })()
      `);
      check('full IPC chat roundtrip', (chatOk as { ok: boolean }).ok === true, (chatOk as { reason?: string }).reason ?? '');

      // 9. 消息复制按钮与图片附件入口存在
      const uiFeat = (await mainWindow!.webContents.executeJavaScript(`(() => {
        const titles = [...document.querySelectorAll('button')].map(b => b.getAttribute('title') || '');
        return {
          copy: titles.filter(x => /复制|Copy/.test(x)).length,
          attach: titles.some(x => /添加图片|Attach/.test(x)),
          fileInput: !!document.querySelector('input[type="file"][accept="image/*"]'),
        };
      })()`)) as { copy: number; attach: boolean; fileInput: boolean };
      check('消息复制按钮存在', uiFeat.copy > 0, `${uiFeat.copy} 个`);
      check('图片附件入口存在', uiFeat.attach === true && uiFeat.fileInput === true);

      // 历史无重复持久化：roundtrip 仅新增 user+assistant 共 2 条（Electron 下主进程单一写入）
      const msgAfter = history.exportAll().messages.length;
      check('历史无重复持久化', msgAfter - msgBefore === 2, `+${msgAfter - msgBefore} 条`);

      // 拖拽工具栏（非按钮区）移动整个窗口
      const beforePos = mainWindow!.getBounds();
      await mainWindow!.webContents.executeJavaScript(`(async () => {
        const bar = document.querySelector('.titlebar-drag');
        const r = bar.getBoundingClientRect();
        const cx = r.left + 4, cy = r.top + r.height / 2;
        bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientX: cx, clientY: cy, screenX: cx, screenY: cy }));
        bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: cx, clientY: cy, screenX: cx + 30, screenY: cy + 20 }));
        await new Promise(res => setTimeout(res, 150));
        bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: cx, clientY: cy, screenX: cx + 30, screenY: cy + 20 }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const afterPos = mainWindow!.getBounds();
      check(
        '拖拽工具栏移动窗口',
        afterPos.x !== beforePos.x || afterPos.y !== beforePos.y,
        `${beforePos.x},${beforePos.y} → ${afterPos.x},${afterPos.y}`
      );

      // 拖动过程尺寸采样：检测是否有整体放大（inner/画布/角色矩形变化）
      const dragMetrics = (await mainWindow!.webContents.executeJavaScript(`(async () => {
        const bar = document.querySelector('.titlebar-drag');
        const r = bar.getBoundingClientRect();
        const cx = r.left + 4, cy = r.top + r.height / 2;
        const cv = () => document.querySelector('canvas').getBoundingClientRect();
        const sample = () => {
          const c = cv();
          return { iw: window.innerWidth, ih: window.innerHeight, cw: Math.round(c.width), ch: Math.round(c.height), m: window.__live2dStage.diagnostics().modelRect };
        };
        const before = sample();
        bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, clientX: cx, clientY: cy, screenX: cx, screenY: cy }));
        const mids = [];
        for (let i = 1; i <= 5; i++) {
          bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, clientX: cx, clientY: cy, screenX: cx + i * 10, screenY: cy + i * 8 }));
          await new Promise((res) => setTimeout(res, 80));
          mids.push(sample());
        }
        bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, clientX: cx, clientY: cy, screenX: cx + 50, screenY: cy + 40 }));
        await new Promise((res) => setTimeout(res, 300));
        return { before, mids, after: sample() };
      })()`)) as { before: Record<string, unknown>; mids: Record<string, unknown>[]; after: Record<string, unknown> };
      console.log('[FEET_DIAG:dragmetrics]', JSON.stringify(dragMetrics));

      // 8. 一键清空全部历史
      history.clearAll();
      check('一键清空历史', history.listSessions().length === 0 && history.queryMessages(session.id).length === 0);
    } catch (err) {
      check('unexpected error', false, (err as Error).message);
    }

    console.log('\n========== SMOKE TEST RESULTS ==========');
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(`=========================================\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`);
    // 清理测试期间写入的配置，保证下次运行从默认状态开始
    try {
      fs.rmSync(path.join(app.getPath('userData'), 'config.json'), { force: true });
    } catch {
      /* ignore */
    }
    app.exit(failed === 0 ? 0 : 1);
  });
}

/* ---------------- 脚部遮挡诊断（FEET_DIAG=1：截图 + 几何输出） ---------------- */

if (process.env.FEET_DIAG === '1') {
  app.whenReady().then(async () => {
    const waitLoad = () =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (mainWindow && !mainWindow.webContents.isLoading()) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 15000);
      });

    const snap = async (tag: string) => {
      const wc = mainWindow!.webContents;
      const geo = await wc.executeJavaScript(`(async () => {
        const stage = window.__live2dStage;
        const d = stage ? stage.diagnostics() : null;
        const cfg = await window.assistant.getConfig();
        const handle = document.querySelector('[title*="拖动"]');
        const panel = handle ? handle.closest('.glass') : null;
        const p = panel ? panel.getBoundingClientRect() : null;
        return {
          model: d ? d.modelRect : null,
          freeArea: d ? d.freeArea : null,
          avoidPanel: cfg.appearance.avoidPanel,
          panel: p ? [Math.round(p.left), Math.round(p.top), Math.round(p.right), Math.round(p.bottom)] : null,
          vw: window.innerWidth, vh: window.innerHeight,
        };
      })()`);
      const img = await wc.capturePage();
      const buf = img.toPNG();
      const file = `/tmp/feet-${tag}.png`;
      fs.writeFileSync(file, buf);
      const b = mainWindow!.getBounds();
      console.log(`[FEET_DIAG:${tag}] win=${b.width}x${b.height} vh=${geo.vh} avoid=${geo.avoidPanel} freeArea=${JSON.stringify(geo.freeArea)} model=${JSON.stringify(geo.model)} panel=${JSON.stringify(geo.panel)} -> ${file}`);
    };

    await waitLoad();
    await new Promise((r) => setTimeout(r, 3500));
    await snap('open');

    // 关闭面板 → 触发紧凑态
    await mainWindow!.webContents.executeJavaScript(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').match(/对话|Chat/));
      if (btn) btn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await snap('closed');

    // 热替换验证：同一舞台切换到 Mao（Cubism4），确认不重建 WebGL 上下文仍正常渲染
    await mainWindow!.webContents.executeJavaScript(
      `window.__live2dStage.loadModel('l2dmodel://models/Mao/Mao.model3.json')`
    );
    await new Promise((r) => setTimeout(r, 2000));
    await snap('swapped');

    // 清空历史后输入可用性：覆写 confirm → 打开历史 → 点「清空全部」→ 回聊天检测 textarea
    const inputRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
      const histBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').match(/历史|History/));
      if (histBtn) histBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const clearBtn = [...document.querySelectorAll('button')].find(b => /清空|Clear all/i.test(b.textContent || ''));
      if (!clearBtn) {
        return {
          ok: false,
          reason: 'no clear button',
          histFound: !!histBtn,
          buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || b.getAttribute('title') || '?').trim()).slice(0, 24),
        };
      }
      clearBtn.click(); // 第一次：进入二次确认
      await new Promise(r => setTimeout(r, 300));
      clearBtn.click(); // 第二次：确认清空
      await new Promise(r => setTimeout(r, 800));
      const ta = document.querySelector('textarea');
      if (!ta) return { ok: false, reason: 'no textarea after clear' };
      ta.focus();
      const focused = document.activeElement === ta;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '测试输入');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const rect = ta.getBoundingClientRect();
      return { ok: true, focused, value: ta.value, rect: [Math.round(rect.width), Math.round(rect.height)], inPanel: !!ta.closest('.glass') };
    })()`)) as { ok: boolean; reason?: string; focused?: boolean; value?: string; rect?: number[]; inPanel?: boolean };
    console.log('[FEET_DIAG:input]', JSON.stringify(inputRes));

    app.exit(0);
  });
}

/* ---------------- 后端对接 E2E 验证（E2E_BACKEND=1） ----------------
 * 前提：已通过 config.json 将 llm.provider 设为 openai、baseUrl 指向自研后端。
 * 验证「配置加载 → SDK 调用 → SSE 流式 → 情感标签 → UI → 持久化」全链路。
 */
if (process.env.E2E_BACKEND === '1') {
  app.whenReady().then(async () => {
    const results: string[] = [];
    const check = (name: string, ok: boolean, detail = '') => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };

    try {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (mainWindow && !mainWindow.webContents.isLoading()) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 15000);
      });
      await new Promise((r) => setTimeout(r, 3000));
      const wc = mainWindow!.webContents;

      const cfg = config.get();
      check('config.json 加载', cfg.llm.provider === 'openai', `${cfg.llm.provider} @ ${cfg.llm.baseUrl}`);

      const test = await createClient(cfg.llm).test();
      check('llm:test 连通性', test.ok === true, test.message);

      const chat = (await wc.executeJavaScript(`(async () => {
        const sid = (await window.assistant.newSession('E2E')).id;
        const requestId = 'e2e_' + Date.now();
        const events = [];
        const unsub = window.assistant.onChatStream((ev) => { if (ev.requestId === requestId) events.push(ev); });
        await window.assistant.chat({ requestId, sessionId: sid, history: [], text: '你好呀，今天过得怎么样？' });
        await new Promise(r => setTimeout(r, 10000));
        unsub();
        const done = events.find(e => e.type === 'done');
        const recs = await window.assistant.queryHistory(sid);
        return {
          tokens: events.filter(e => e.type === 'token').length,
          emotions: events.filter(e => e.type === 'emotion').map(e => e.data),
          errors: events.filter(e => e.type === 'error').map(e => e.data),
          doneData: done ? done.data : null,
          uiText: document.body.innerText,
          recordCount: recs.length,
          last: (() => { const a = recs.filter(r => r.role === 'assistant'); return a.length ? a[a.length - 1] : null; })(),
        };
      })()`)) as {
        tokens: number;
        emotions: string[];
        errors: string[];
        doneData: string | null;
        uiText: string;
        recordCount: number;
        last: { role: string; content: string; emotion: string | null } | null;
      };

      check('SSE 流式分片', chat.tokens > 5, `${chat.tokens} chunks`);
      check('emotion 事件推送', chat.emotions.length >= 1, chat.emotions.join(','));
      check('无 error 事件', chat.errors.length === 0, chat.errors.join('|'));
      check('回复来自自研后端', (chat.doneData ?? '').includes('自研后端'));
      check('done 含原始标签', (chat.doneData ?? '').includes('[emotion:'));
      check('UI 已剥离标签', !chat.uiText.includes('[emotion:'));
      check('UI 显示后端回复', chat.uiText.includes('自研后端'));

      check('本轮写入 2 条历史', chat.recordCount === 2, `${chat.recordCount} 条`);
      check(
        '历史持久化为纯文本',
        !!chat.last && chat.last.content.includes('自研后端') && !chat.last.content.includes('[emotion:'),
        chat.last ? chat.last.content.slice(0, 30) : 'missing'
      );
      check(
        '历史 emotion 字段',
        !!chat.last && chat.last.emotion === chat.emotions[0],
        chat.last ? String(chat.last.emotion) : 'missing'
      );

      const model = await wc.executeJavaScript(
        `window.assistant.updateConfig({ llm: { model: 'mock-2' } }).then(c => c.llm.model)`
      );
      check('config:write 深合并', model === 'mock-2', String(model));
    } catch (err) {
      check('unexpected error', false, (err as Error).message);
    }

    console.log('\n========== E2E BACKEND RESULTS ==========');
    for (const line of results) console.log(line);
    const failedE2E = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(`===========================================\n${failedE2E === 0 ? 'ALL PASSED' : `${failedE2E} FAILED`}`);

    // 清理测试配置，避免残留指向已停止的后端
    try {
      fs.rmSync(path.join(app.getPath('userData'), 'config.json'), { force: true });
    } catch {
      /* ignore */
    }
    app.exit(failedE2E === 0 ? 0 : 1);
  });
}

/* ---------------- 语音对接 E2E 验证（E2E_VOICE=1） ----------------
 * 前提：本地已启动 OpenAI 兼容的语音 mock（默认 http://localhost:8898/v1）。
 * 验证 Whisper STT 与 OpenAI TTS 的请求构造、鉴权、响应解析与凭据回退。
 */
if (process.env.E2E_VOICE === '1') {
  app.whenReady().then(async () => {
    const results: string[] = [];
    const check = (name: string, ok: boolean, detail = '') => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };
    const VOICE_BASE = process.env.VOICE_BASE ?? 'http://localhost:8898/v1';
    const KEY = 'sk-voice-test';

    try {
      // 显式配置语音后端
      config.update({
        voice: {
          sttEngine: 'whisper',
          whisperBaseUrl: VOICE_BASE,
          whisperApiKey: KEY,
          whisperModel: 'whisper-1',
          ttsEngine: 'openai',
          openaiTtsBaseUrl: VOICE_BASE,
          openaiTtsApiKey: KEY,
          openaiTtsModel: 'gpt-4o-mini-tts',
          openaiTtsVoice: 'alloy',
        },
      });
      const cfg = config.get();

      // 1. TTS：OpenAI 兼容 /audio/speech
      const audio = await tts.synthesize('你好，这是语音合成测试。', cfg, 'openai');
      check('OpenAI TTS 返回音频', !!audio && (audio?.audioBase64.length ?? 0) > 100,
        audio ? `${Math.round((audio.audioBase64.length * 3) / 4)} 字节, mime=${audio.mime}` : 'null');
      check('TTS mime 正确', audio?.mime === 'audio/mpeg', String(audio?.mime));

      // 2. STT：Whisper /audio/transcriptions（用一段伪音频验证链路与字段）
      const fakeAudio = Buffer.from('RIFF....WAVEfmt ').toString('base64');
      const sttRes = await stt.transcribe(fakeAudio, cfg, 'audio/webm');
      check('Whisper STT 返回文本', !sttRes.error && !!sttRes.text, sttRes.error ?? `"${sttRes.text}"`);

      // 3. 凭据回退：清空语音专用配置，应复用 llm.baseUrl / llm.apiKey
      config.update({
        llm: { baseUrl: VOICE_BASE, apiKey: KEY, provider: 'openai', model: 'mock-1' },
        voice: { whisperBaseUrl: '', whisperApiKey: '', openaiTtsBaseUrl: '', openaiTtsApiKey: '' },
      });
      const cfg2 = config.get();
      const audio2 = await tts.synthesize('回退测试。', cfg2, 'openai');
      check('TTS 回退复用 LLM 凭据', !!audio2 && (audio2?.audioBase64.length ?? 0) > 100);
      const stt2 = await stt.transcribe(fakeAudio, cfg2, 'audio/webm');
      check('STT 回退复用 LLM 凭据', !stt2.error && !!stt2.text, stt2.error ?? `"${stt2.text}"`);

      // 4. 渲染进程链路（IPC + bridge）
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (mainWindow && !mainWindow.webContents.isLoading()) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 15000);
      });
      await new Promise((r) => setTimeout(r, 2000));
      const rendererRes = (await mainWindow!.webContents.executeJavaScript(`(async () => {
        const audio = await window.assistant.synthesize('渲染层测试', 'openai');
        const stt = await window.assistant.transcribe('${fakeAudio}', 'audio/webm');
        const testTts = await window.assistant.testTts('openai');
        const testStt = await window.assistant.testStt();
        return {
          audioBytes: audio ? Math.round(audio.audioBase64.length * 3 / 4) : 0,
          audioMime: audio ? audio.mime : null,
          sttText: stt.text, sttError: stt.error || null,
          testTts, testStt,
        };
      })()`)) as {
        audioBytes: number; audioMime: string | null;
        sttText: string; sttError: string | null;
        testTts: { ok: boolean; message: string };
        testStt: { ok: boolean; message: string };
      };
      check('渲染层 TTS 经 IPC 拿到音频', rendererRes.audioBytes > 100, `${rendererRes.audioBytes} 字节 ${rendererRes.audioMime}`);
      check('渲染层 STT 经 IPC 拿到文本', !!rendererRes.sttText && !rendererRes.sttError,
        rendererRes.sttError ?? `"${rendererRes.sttText}"`);
      check('testTts 自检通过', rendererRes.testTts.ok === true, rendererRes.testTts.message);
      check('testStt 自检通过', rendererRes.testStt.ok === true, rendererRes.testStt.message);
    } catch (err) {
      check('unexpected error', false, (err as Error).message);
    }

    console.log('\n========== E2E VOICE RESULTS ==========');
    for (const line of results) console.log(line);
    const failedV = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(`=========================================\n${failedV === 0 ? 'ALL PASSED' : `${failedV} FAILED`}`);
    try {
      fs.rmSync(path.join(app.getPath('userData'), 'config.json'), { force: true });
    } catch {
      /* ignore */
    }
    app.exit(failedV === 0 ? 0 : 1);
  });
}

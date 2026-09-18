import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppConfig, ChatMessage, HistorySession, ModelInfo, StreamEvent, WindowMode } from '../shared/types';
import { stripEmotionTags } from '../shared/demo';
import { bridge } from './bridge';
import type { Live2DStage } from './live2d/stage';
import { SpeechRecognizer, WakeWordDetector } from './voice/speech';
import { AudioRecorder } from './voice/recorder';
import { TtsPlayer } from './voice/ttsPlayer';
import Live2DCanvas from './components/Live2DCanvas';
import ChatPanel, { type UiMessage } from './components/ChatPanel';
import SettingsPanel from './components/SettingsPanel';
import HistoryPanel from './components/HistoryPanel';
import Toolbar, { type PanelKind } from './components/Toolbar';

let requestSeq = 0;

/** WebGL 不可用时的占位形象表情映射 */
const EMOTION_EMOJI: Record<string, string> = {
  happy: '😸',
  sad: '😿',
  thinking: '🐱',
  angry: '😾',
  surprised: '🙀',
  shy: '😽',
  embarrassed: '😳',
  neutral: '🐱',
};

type Rect = { x: number; y: number; width: number; height: number };

/** 矩形相等比较，避免每次测量都产生新引用触发无谓更新 */
function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<HistorySession | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activePanel, setActivePanel] = useState<PanelKind>('chat');
  const [characterVisible, setCharacterVisible] = useState(true);
  const [micActive, setMicActive] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceHint, setVoiceHint] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [stageSupported, setStageSupported] = useState(true);
  /** 可用模型列表（用于把 modelDir 解析为真实 model3.json 的加载 URL） */
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentEmotion, setCurrentEmotion] = useState('happy');
  /** 工具栏自动折叠：无操作一段时间后隐藏 */
  const [toolbarVisible, setToolbarVisible] = useState(true);
  /** 对话框拖拽偏移（像素，相对默认底部居中位置） */
  const [panelOffset, setPanelOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  /** 角色可用区域（避让对话框）；null 表示不避让 */
  const [freeArea, setFreeArea] = useState<Rect | null>(null);

  const stageRef = useRef<Live2DStage | null>(null);
  const busyRef = useRef(false);
  /** 供自动折叠逻辑读取当前面板状态（避免频繁重建监听器） */
  const activePanelRef = useRef<PanelKind>(null);
  activePanelRef.current = activePanel;
  /** 供拖拽结束回调读取最新偏移（避免闭包捕获旧值） */
  const panelOffsetRef = useRef(panelOffset);
  panelOffsetRef.current = panelOffset;
  /** 面板拖动中：暂停避让重排，松手后一次性重排，避免拖动中角色缩放跳动 */
  const panelDraggingRef = useRef(false);
  const requestIdRef = useRef<string | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  const sessionRef = useRef<HistorySession | null>(null);
  configRef.current = config;
  sessionRef.current = session;

  const micSupported = useMemo(() => SpeechRecognizer.supported() || AudioRecorder.supported(), []);
  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const wakeDetectorRef = useRef<WakeWordDetector | null>(null);

  /** TTS 播放器：口型同步回调直接驱动 Live2D 参数 */
  const ttsPlayer = useMemo(
    () =>
      new TtsPlayer(
        (v) => stageRef.current?.setLipSync(v),
        (isSpeaking) => {
          setSpeaking(isSpeaking);
          if (isSpeaking) stageRef.current?.startSpeaking();
          else stageRef.current?.stopSpeaking();
        }
      ),
    []
  );

  /* ---------------- 初始化 ---------------- */

  useEffect(() => {
    let unsubConfig: (() => void) | undefined;
    let unsubStream: (() => void) | undefined;
    let unsubShortcut: (() => void) | undefined;
    let unsubOpenSettings: (() => void) | undefined;

    void (async () => {
      const cfg = await bridge.getConfig();
      setConfig(cfg);
      // 恢复上次拖拽的对话框位置
      if (cfg?.appearance?.panelOffset) setPanelOffset(cfg.appearance.panelOffset);

      // 加载可用模型列表（供 modelDir → 真实 model3.json URL 解析）
      bridge.listModels().then(setModels).catch(() => undefined);

      // 恢复或创建会话
      const sessions = await bridge.listSessions();
      const s = sessions[0] ?? (await bridge.newSession());
      setSession(s);
      const history = await bridge.queryHistory(s.id);
      setMessages(
        history.map((h) => ({
          role: h.role,
          content: h.content,
          emotion: h.emotion ?? undefined,
          ...(h.images && h.images.length > 0 ? { images: h.images } : {}),
        }))
      );

      // LLM 流式事件订阅
      unsubStream = bridge.onChatStream(handleStreamEvent);

      // 配置热更新
      unsubConfig = bridge.onConfigChanged((next) => setConfig(next));

      // 全局快捷键
      unsubShortcut = bridge.onShortcut((action) => {
        if (action === 'toggleCharacter') setCharacterVisible((v) => !v);
        else if (action === 'toggleMute') toggleMute();
        else if (action === 'openSettings') setActivePanel('settings');
        else if (action === 'pushToTalk') toggleMic();
      });
      unsubOpenSettings = bridge.onOpenSettings(() => setActivePanel('settings'));
    })();

    return () => {
      unsubConfig?.();
      unsubStream?.();
      unsubShortcut?.();
      unsubOpenSettings?.();
      ttsPlayer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 唤醒词检测 ---------------- */

  useEffect(() => {
    if (!config) return;
    const shouldRun = config.voice.enabled && config.voice.wakeWordEnabled && micSupported;
    if (shouldRun && !wakeDetectorRef.current) {
      const detector = new WakeWordDetector();
      wakeDetectorRef.current = detector;
      detector.start(config.voice.wakeWord, () => {
        setActivePanel('chat');
        void bridge.notify('Mao', '我在！有什么可以帮你？');
        stageRef.current?.applyEmotion('happy');
      });
    } else if (!shouldRun && wakeDetectorRef.current) {
      wakeDetectorRef.current.stop();
      wakeDetectorRef.current = null;
    }
  }, [config?.voice.enabled, config?.voice.wakeWordEnabled, config?.voice.wakeWord, micSupported]);

  /* ---------------- 工具栏自动折叠 ---------------- */

  useEffect(() => {
    if (!config?.appearance.showToolbar || !config.appearance.autoHideToolbar) {
      setToolbarVisible(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      setToolbarVisible(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 面板打开时保持工具栏可见，否则聊天面板会失去唯一的关闭入口
        if (!activePanelRef.current) setToolbarVisible(false);
      }, Math.max(1000, config.appearance.toolbarHideDelay));
    };
    const onActivity = () => arm();
    arm();
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, onActivity));
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, onActivity));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.appearance.showToolbar, config?.appearance.autoHideToolbar, config?.appearance.toolbarHideDelay]);

  /* ---------------- 窗口自动伸缩 ---------------- */

  // 窗口自动伸缩：仅两档——面板打开=展开；无面板=最小(bare)。
  // 不随工具栏显隐变化，避免拖动/释放前后窗口变大-缩小振荡；尺寸瞬时 snap。
  useEffect(() => {
    if (!config?.appearance.autoResizeWindow) return;
    const mode: WindowMode = activePanel ? 'expanded' : 'bare';
    void bridge.setWindowMode(mode).then(() => {
      // 窗口尺寸落定后强制重排角色与避让区域，避免残留旧尺寸导致裁切
      setTimeout(() => {
        stageRef.current?.resize();
        measureFreeArea();
      }, 120);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel, config?.appearance.autoResizeWindow]);

  /* ---------------- LLM 流式事件处理 ---------------- */

  const handleStreamEvent = useCallback((event: StreamEvent & { requestId: string }) => {
    if (event.requestId !== requestIdRef.current) return;

    if (event.type === 'token') {
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return msgs;
        return [...msgs.slice(0, -1), { ...last, content: last.content + event.data }];
      });
    } else if (event.type === 'emotion') {
      // 情感标签 → 表情动作映射引擎
      stageRef.current?.applyEmotion(event.data);
      setCurrentEmotion(event.data);
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return msgs;
        return [...msgs.slice(0, -1), { ...last, emotion: event.data }];
      });
    } else if (event.type === 'done') {
      const clean = stripEmotionTags(event.data);
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return msgs;
        return [...msgs.slice(0, -1), { ...last, content: clean, streaming: false }];
      });
      busyRef.current = false;
      setBusy(false);

      // 持久化助手消息（仅浏览器模式；Electron 下由主进程 runLlmChat 统一写入，避免重复）
      const sid = sessionRef.current?.id;
      if (sid && !bridge.isElectron) void bridge.addHistory({ sessionId: sid, role: 'assistant', content: clean });

      // TTS 朗读（语音未禁用且未静音）
      const cfg = configRef.current;
      if (cfg && cfg.voice.enabled && !cfg.voice.muted && clean) {
        void speak(clean);
      }
    } else if (event.type === 'error') {
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return msgs;
        return [
          ...msgs.slice(0, -1),
          { ...last, content: `⚠ ${event.data}`, streaming: false, emotion: 'sad' },
        ];
      });
      stageRef.current?.applyEmotion('sad');
      busyRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- TTS ---------------- */

  const speak = useCallback(
    async (text: string) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const engine = cfg.voice.ttsEngine;
      // openai：任何环境都可用（主进程或浏览器直连）；edge：需主进程
      if (engine === 'openai' || (engine === 'edge' && bridge.isElectron)) {
        const audio = await bridge.synthesize(text, engine);
        if (audio) {
          await ttsPlayer.playBase64(audio.audioBase64, audio.mime);
          return;
        }
      }
      // 回退：浏览器语音合成
      await ttsPlayer.playBrowser(text);
    },
    [ttsPlayer]
  );

  /* ---------------- 发送消息 ---------------- */

  const send = useCallback(
    async (text: string, images?: string[]) => {
      if (busyRef.current || !sessionRef.current || !configRef.current) return;
      const sid = sessionRef.current.id;
      const imgs = images && images.length > 0 ? images : undefined;

      // 首个消息作为会话标题
      const historyCount = messages.filter((m) => m.role === 'user').length;
      if (historyCount === 0) {
        void bridge.renameSession(sid, text.slice(0, 20));
      }

      setMessages((msgs) => [
        ...msgs,
        { role: 'user', content: text, ...(imgs ? { images: imgs } : {}) },
        { role: 'assistant', content: '', streaming: true },
      ]);
      // 持久化用户消息（仅浏览器模式；Electron 下由主进程 runLlmChat 统一写入，避免重复）
      if (!bridge.isElectron) {
        void bridge.addHistory({ sessionId: sid, role: 'user', content: text, ...(imgs ? { images: imgs } : {}) });
      }

      busyRef.current = true;
      setBusy(true);
      stageRef.current?.applyEmotion('thinking');
      ttsPlayer.stop();

      const requestId = `req_${Date.now()}_${requestSeq++}`;
      requestIdRef.current = requestId;

      const history: ChatMessage[] = messages
        .filter((m) => !m.streaming && (m.content || (m.images && m.images.length > 0)))
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
        }));

      await bridge.chat({ requestId, sessionId: sid, history, text, images: imgs });
    },
    [messages, ttsPlayer]
  );

  const stopGeneration = useCallback(() => {
    if (requestIdRef.current) void bridge.abortChat(requestIdRef.current);
    busyRef.current = false;
    setBusy(false);
    setMessages((msgs) => {
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...msgs.slice(0, -1), { ...last, streaming: false, content: last.content || '（已停止）' }];
      }
      return msgs;
    });
  }, []);

  /* ---------------- 语音输入 ---------------- */

  /**
   * 麦克风开关，按 sttEngine 分流：
   *  - whisper   ：MediaRecorder 录音 → base64 → 后端 /audio/transcriptions 转写
   *  - webspeech ：浏览器内置 Web Speech API 实时识别（离线可用、零配置）
   */
  const toggleMic = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg) return;

    // 正在录音 → 停止
    if (micActive) {
      if (cfg.voice.sttEngine === 'whisper') {
        setMicActive(false);
        void (async () => {
          setTranscribing(true);
          stageRef.current?.applyEmotion('thinking');
          const audio = await recorderRef.current?.stop();
          if (audio) {
            const res = await bridge.transcribe(audio.base64, audio.mime);
            if (res.text) {
              void send(res.text);
            } else {
              setVoiceHint(res.error || '未识别到语音内容');
              stageRef.current?.applyEmotion('sad');
            }
          } else {
            setVoiceHint('录音过短，请按住说话久一点');
          }
          setTranscribing(false);
        })();
      } else {
        recognizerRef.current?.stop();
        setMicActive(false);
      }
      return;
    }

    // 开始录音
    stageRef.current?.applyEmotion('surprised');
    setVoiceHint('');

    if (cfg.voice.sttEngine === 'whisper') {
      const recorder = recorderRef.current ?? new AudioRecorder();
      recorderRef.current = recorder;
      void recorder.start().then((ok) => {
        if (ok) {
          setMicActive(true);
          setVoiceHint('正在录音，再次点击结束');
        } else {
          setVoiceHint('无法访问麦克风，请检查系统权限');
        }
      });
      return;
    }

    const recognizer = recognizerRef.current ?? new SpeechRecognizer();
    recognizerRef.current = recognizer;
    const ok = recognizer.start(
      (text, isFinal) => {
        if (isFinal) {
          setMicActive(false);
          if (text.trim()) void send(text.trim());
        } else {
          setVoiceHint(text);
        }
      },
      () => {
        setMicActive(false);
        setVoiceHint('');
      }
    );
    if (ok) setMicActive(true);
    else setVoiceHint('当前环境不支持语音识别');
  }, [micActive, send]);

  const toggleMute = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg) return;
    const muted = !cfg.voice.muted;
    if (muted) ttsPlayer.stop();
    void bridge.updateConfig({ voice: { ...cfg.voice, muted } });
    setConfig({ ...cfg, voice: { ...cfg.voice, muted } });
  }, [ttsPlayer]);

  /* ---------------- 其他交互 ---------------- */

  const openSession = useCallback(async (s: HistorySession) => {
    setSession(s);
    const history = await bridge.queryHistory(s.id);
    setMessages(
      history.map((h) => ({
        role: h.role,
        content: h.content,
        emotion: h.emotion ?? undefined,
        ...(h.images && h.images.length > 0 ? { images: h.images } : {}),
      }))
    );
    setActivePanel('chat');
  }, []);

  const newChat = useCallback(async () => {
    // 复位进行中的生成与语音提示，避免残留 busy/提示阻塞新会话输入
    stopGeneration();
    setVoiceHint('');
    setTranscribing(false);
    const s = await bridge.newSession();
    setSession(s);
    setMessages([]);
    setActivePanel('chat');
  }, [stopGeneration]);

  const saveConfig = useCallback(async (next: AppConfig) => {
    await bridge.updateConfig(next);
    setConfig(next);
  }, []);

  const onModelTap = useCallback(() => {
    stageRef.current?.playMotion('TapBody');
  }, []);

  /* ---------------- 对话框拖拽移动 ---------------- */

  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 按住面板标题栏拖动；带边界钳制，保证面板始终完整留在窗口内。
   *
   * 注意：必须全程使用 Pointer Events 并配合 setPointerCapture。
   * 若在 pointerdown 上 preventDefault，浏览器会抑制后续的兼容性 mouse 事件
   * （mouseup 不再触发），导致拖拽无法释放。指针捕获还能保证光标移出窗口
   * 甚至松手在窗口外时依然收到 pointerup。
   */
  const onPanelDragStart = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // 点在按钮上时不触发拖拽
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    // 拖动开始：冻结角色重排，避免拖动中避让实时重算导致角色缩放跳动
    panelDraggingRef.current = true;
    stageRef.current?.setFrozen(true);
    // 捕获指针：后续 pointermove / pointerup 全部派发到该元素
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* 某些环境不支持时退化为普通监听 */
    }
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...panelOffsetRef.current };
    // 面板未偏移时的默认位置，用于计算可移动范围
    const defLeft = rect.left - base.x;
    const defTop = rect.top - base.y;
    const defRight = rect.right - base.x;
    const defBottom = rect.bottom - base.y;
    const minX = -defLeft;
    const maxX = Math.max(minX, window.innerWidth - defRight);
    const minY = -defTop;
    const maxY = Math.max(minY, window.innerHeight - defBottom);

    const onMove = (ev: PointerEvent) => {
      const nx = Math.min(maxX, Math.max(minX, base.x + (ev.clientX - startX)));
      const ny = Math.min(maxY, Math.max(minY, base.y + (ev.clientY - startY)));
      setPanelOffset({ x: nx, y: ny });
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try {
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      // 拖动结束：解冻并一次性重排避让
      panelDraggingRef.current = false;
      stageRef.current?.setFrozen(false);
      measureFreeArea();
      // 持久化位置
      const cfg = configRef.current;
      if (cfg) void bridge.updateConfig({ appearance: { ...cfg.appearance, panelOffset: panelOffsetRef.current } });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, []);

  /** 双击标题栏复位到默认位置 */
  const resetPanelPosition = useCallback(() => {
    setPanelOffset({ x: 0, y: 0 });
    const cfg = configRef.current;
    if (cfg) void bridge.updateConfig({ appearance: { ...cfg.appearance, panelOffset: null } });
  }, []);

  /* ---------------- 角色避让对话框 ---------------- */

  /** 测量面板位置，算出角色可用的空白带（面板上方或下方中较高的一侧） */
  const measureFreeArea = useCallback(() => {
    if (panelDraggingRef.current) return; // 拖动中不重排，松手后再测
    const cfg = configRef.current;
    const panel = panelRef.current;
    if (!cfg?.appearance.avoidPanel || !activePanelRef.current || !panel) {
      setFreeArea((prev) => (prev === null ? prev : null));
      return;
    }
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 10;
    // 空白带低于此高度说明面板几乎占满窗口，放弃避让（否则角色过小）；
    // 否则始终用较高的一侧避让，保证脚不被对话框盖住。
    const MIN_BAND = 40;
    const aboveH = r.top - MARGIN * 2;
    const belowH = vh - r.bottom - MARGIN * 2;

    let next: { x: number; y: number; width: number; height: number } | null = null;
    if (aboveH >= belowH) {
      if (aboveH >= MIN_BAND) next = { x: 0, y: MARGIN, width: vw, height: aboveH };
    } else if (belowH >= MIN_BAND) {
      next = { x: 0, y: r.bottom + MARGIN, width: vw, height: belowH };
    }
    setFreeArea((prev) => (sameRect(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    // 等布局稳定后再测量
    const raf = requestAnimationFrame(() => measureFreeArea());
    // 配置/舞台就绪后再补测一次，避免首测过早（面板或配置未就绪）导致 freeArea 停留 null 而不避让
    const t = setTimeout(() => measureFreeArea(), 600);
    const onResize = () => measureFreeArea();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [activePanel, panelOffset, config?.appearance.avoidPanel, stageSupported, measureFreeArea]);

  /* ---------------- 渲染 ---------------- */

  if (!config || !session) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 text-sm">加载中…</div>
    );
  }

  // 从模型列表解析加载 URL：经自定义协议指向真实 model3.json，
  // 不假设与文件夹同名（避免 runtime/hibiki.model3.json 这类包 404 不显示）；
  // 列表未就绪时回退到旧的同名拼接路径。
  const modelDir = config.appearance.modelDir;
  const modelHit = models.find(
    (m) => m.name === modelDir || m.dir === modelDir || m.dir.endsWith(`/${modelDir}`) || m.dir.endsWith(`\\${modelDir}`)
  );
  const modelUrl = modelHit?.url ?? `./models/${modelDir}/${modelDir}.model3.json`;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Live2D 角色层：缩放由舞台按模型级处理（重新渲染，放大不失真） */}
      <div className="absolute inset-0">
        <Live2DCanvas
          modelUrl={modelUrl}
          visible={characterVisible}
          scale={config.appearance.modelScale}
          posX={config.appearance.modelX}
          footInset={config.appearance.footInset}
          freeArea={freeArea}
          onReady={(stage) => {
            stageRef.current = stage;
            setStageSupported(stage.supported);
            if (stage.supported) stage.applyEmotion('happy');
          }}
          onModelTap={onModelTap}
        />
        {/* WebGL 不可用时的占位形象（如无头浏览器环境） */}
        {!stageSupported && characterVisible && (
          <div className="absolute inset-x-0 bottom-6 flex flex-col items-center gap-2 pointer-events-none">
            <div
              className="transition-all duration-300"
              style={{ fontSize: `${Math.round(64 * config.appearance.modelScale)}px` }}
            >
              {EMOTION_EMOJI[currentEmotion] ?? '🐱'}
            </div>
            <span className="text-[10px] text-slate-500">当前环境不支持 WebGL，显示占位形象</span>
          </div>
        )}
      </div>

      {/* 说话状态指示 */}
      {speaking && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 glass rounded-full px-3 py-1 text-[11px] text-indigo-200 flex items-center gap-1.5 pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
          Mao 正在说话…
        </div>
      )}

      {/* UI 层 */}
      <div className="absolute inset-0 flex flex-col pointer-events-none">
        {/* 顶部工具栏（可自动折叠） */}
        {config.appearance.showToolbar && (
          <div className="flex justify-center pt-3">
            <Toolbar
              activePanel={activePanel}
              muted={config.voice.muted}
              characterVisible={characterVisible}
              isElectron={bridge.isElectron}
              onWindowDragState={(d) => stageRef.current?.setFrozen(d)}
              collapsed={!toolbarVisible}
              onTogglePanel={(p) => setActivePanel((cur) => (cur === p ? null : p))}
              onToggleMute={toggleMute}
              onToggleCharacter={() => setCharacterVisible((v) => !v)}
              onMinimize={() => void bridge.minimize()}
              onClose={() => void bridge.closeToTray()}
              onQuit={() => void bridge.quit()}
            />
          </div>
        )}

        {/* 面板区域：底部对齐并限高，确保角色上半身始终可见且可点击 */}
        {activePanel && (
          <div className="flex-1 min-h-0 px-3 pb-3 pt-2 flex flex-col justify-end">
            <div
              ref={panelRef}
              className="glass rounded-2xl overflow-hidden flex flex-col basis-[50%] shrink-0 min-h-0 pointer-events-auto"
              style={{ transform: `translate(${panelOffset.x}px, ${panelOffset.y}px)` }}
            >
              {/* 拖拽手柄：按住可移动对话框，双击复位 */}
              <div
                onPointerDown={onPanelDragStart}
                onDoubleClick={resetPanelPosition}
                title="按住拖动移动对话框，双击复位"
                className="h-4 shrink-0 flex items-center justify-center cursor-move hover:bg-slate-500/25 transition-colors"
              >
                <span className="w-10 h-1 rounded-full bg-slate-400/50" />
              </div>
              {activePanel === 'chat' && (
                <>
                  <div
                    onPointerDown={onPanelDragStart}
                    onDoubleClick={resetPanelPosition}
                    className="flex items-center justify-between px-4 py-1.5 border-b border-slate-600/40 cursor-move"
                  >
                    <span className="text-xs text-slate-300 font-medium truncate">🐱 {session.title}</span>
                    <button onClick={newChat} className="text-[11px] text-indigo-300 hover:text-indigo-200 shrink-0 ml-2">
                      + 新对话
                    </button>
                  </div>
                  <ChatPanel
                    messages={messages}
                    busy={busy}
                    micActive={micActive}
                    micSupported={micSupported}
                    hint={transcribing ? '正在转写语音…' : voiceHint}
                    onSend={(text, images) => void send(text, images)}
                    onStop={stopGeneration}
                    onMicToggle={toggleMic}
                  />
                </>
              )}
              {activePanel === 'settings' && (
                <SettingsPanel config={config} onSave={(c) => void saveConfig(c)} onClose={() => setActivePanel(null)} />
              )}
              {activePanel === 'history' && (
                <HistoryPanel
                  currentSessionId={session.id}
                  onOpenSession={(s) => void openSession(s)}
                  onClose={() => setActivePanel(null)}
                  onCurrentDeleted={() => void newChat()}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

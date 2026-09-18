import type { AppConfig } from './types';

/**
 * 应用默认配置（主进程 ConfigStore 与渲染层浏览器兜底共用）。
 */
export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'demo',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    topP: 1,
    maxTokens: 1024,
    systemPrompt:
      '你是 Mao，一只活泼可爱的猫娘桌面助手。请用简短、亲切、带一点俏皮的方式回答用户。\n' +
      '重要：每次回复的开头必须包含一个情感标签，格式为 [emotion:标签]，' +
      '标签只能是 happy / sad / thinking / angry / surprised / shy / neutral 之一，用于驱动你的表情。',
    contextWindow: 20,
  },
  voice: {
    enabled: true,
    muted: false,
    sttEngine: 'webspeech',
    whisperBaseUrl: 'https://api.openai.com/v1',
    whisperApiKey: '',
    whisperModel: 'whisper-1',
    // 默认 Edge TTS：免费、高质量中文语音，无需任何后端配置
    ttsEngine: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    openaiTtsModel: 'gpt-4o-mini-tts',
    openaiTtsVoice: 'alloy',
    openaiTtsBaseUrl: '',
    openaiTtsApiKey: '',
    wakeWord: '你好Mao',
    wakeWordEnabled: false,
  },
  appearance: {
    modelDir: 'Mao',
    modelScale: 1,
    modelX: 0.5,
    showToolbar: true,
    autoHideToolbar: true,
    toolbarHideDelay: 4000,
    panelOffset: null,
    avoidPanel: true,
    // 窗口自动伸缩：空闲时只保留角色+工具栏，尽量减少对其它应用的遮挡
    autoResizeWindow: true,
    compactWidth: 360,
    compactHeight: 420,
    // 无面板时的最小窗口：需容纳工具栏宽度，工具栏显隐不再改变窗口尺寸
    bareWidth: 320,
    bareHeight: 360,
    expandedWidth: 520,
    expandedHeight: 680,
    // 脚底留白：角色脚底距可用区域底边，避免脚被窗口底边裁切或贴边被遮
    footInset: 12,
  },
  shortcuts: {
    toggleCharacter: 'CommandOrControl+Shift+L',
    pushToTalk: 'CommandOrControl+Shift+T',
    toggleMute: 'CommandOrControl+Shift+M',
    openSettings: 'CommandOrControl+Shift+S',
  },
  personality: 'default',
};

/**
 * 深合并：用 patch 覆盖 base 中同名字段，未提供的字段保留 base 值。
 *
 * ⚠️ 语义约定：`null` 视为「显式置空」并会覆盖 base（例如 panelOffset 复位为 null），
 * 只有 `undefined` 才表示「未提供、保留原值」。
 * 因此调用方若想表达「没有补丁」，必须传 `{}` 而不是 `null`。
 */
export function deepMergeConfig<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T)) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const bv = (base as Record<string, unknown>)[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) ? deepMergeConfig(bv, v) : v;
  }
  return out as T;
}

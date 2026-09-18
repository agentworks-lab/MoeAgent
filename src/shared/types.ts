/** 共享类型定义 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** 情感标签（仅 assistant 消息） */
  emotion?: string;
  /** 附带图片（data URL 数组），用于多模态视觉输入 */
  images?: string[];
  timestamp?: number;
}

export interface LlmSettings {
  /** 后端类型：openai 兼容 API 或内置演示模式（无需网络） */
  provider: 'openai' | 'demo';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  /** 上下文窗口：最多携带的历史消息条数 */
  contextWindow: number;
}

export interface VoiceSettings {
  /** 语音总开关 */
  enabled: boolean;
  muted: boolean;
  /** STT 引擎：whisper API 或浏览器 Web Speech API */
  sttEngine: 'whisper' | 'webspeech';
  whisperBaseUrl: string;
  whisperApiKey: string;
  whisperModel: string;
  /** TTS 引擎：Edge TTS / 浏览器 speechSynthesis / OpenAI TTS */
  ttsEngine: 'edge' | 'browser' | 'openai';
  edgeVoice: string;
  /** OpenAI TTS 模型与音色（baseUrl / apiKey 留空时复用 llm 配置） */
  openaiTtsModel: string;
  openaiTtsVoice: string;
  openaiTtsBaseUrl: string;
  openaiTtsApiKey: string;
  /** 唤醒词 */
  wakeWord: string;
  wakeWordEnabled: boolean;
}

export interface AppearanceSettings {
  modelDir: string;
  /** 角色缩放倍率（作用于 Live2D 模型本身，重新渲染故不失真） */
  modelScale: number;
  /** 角色水平位置 0~1（0=最左，0.5=居中，1=最右） */
  modelX: number;
  showToolbar: boolean;
  /** 工具栏自动折叠：无操作一段时间后隐藏，移动鼠标即恢复 */
  autoHideToolbar: boolean;
  /** 自动折叠的无操作时长（毫秒） */
  toolbarHideDelay: number;
  /** 对话框位置偏移（像素，相对默认底部居中位置）；null 表示使用默认位置 */
  panelOffset: { x: number; y: number } | null;
  /** 角色自动避让：面板打开时把角色缩放/移动到未被遮挡的区域 */
  avoidPanel: boolean;
  /** 窗口自动伸缩：空闲（无面板）时收缩到最小，打开面板时展开，尽量少遮挡其它应用 */
  autoResizeWindow: boolean;
  /** 空闲态窗口尺寸 */
  compactWidth: number;
  compactHeight: number;
  /** 仅角色态窗口尺寸（工具栏隐藏且无面板时） */
  bareWidth: number;
  bareHeight: number;
  /** 展开态（面板打开）窗口尺寸 */
  expandedWidth: number;
  expandedHeight: number;
  /** 脚底偏移（像素）：角色脚底距可用区域底边的留白，可按屏幕微调避免脚被裁/被遮 */
  footInset: number;
}

/** 窗口模式：expanded=面板打开 / compact=空闲带工具栏 / bare=工具栏隐藏后仅角色 */
export type WindowMode = 'expanded' | 'compact' | 'bare';

export interface ShortcutSettings {
  toggleCharacter: string;
  pushToTalk: string;
  toggleMute: string;
  openSettings: string;
}

export interface AppConfig {
  llm: LlmSettings;
  voice: VoiceSettings;
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  /** 人格预设名称 → 系统提示词 */
  personality: string;
}

export interface HistoryRecord {
  id?: number;
  sessionId: string;
  role: Role;
  content: string;
  emotion?: string | null;
  /** 附带图片（data URL 数组，JSON 存储） */
  images?: string[];
  createdAt?: number;
}

export interface HistorySession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ModelInfo {
  name: string;
  dir: string;
  model3: string;
  /** 渲染层可直接加载的模型 URL（自定义协议 / 相对路径） */
  url: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  tools: PluginToolDef[];
  enabled: boolean;
}

export interface PluginToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'token' | 'emotion' | 'done' | 'error' | 'tool';
  data: string;
}

/** 情感标签 → 表情/动作映射规则 */
export interface EmotionRule {
  expression: string;
  motion?: string;
  /** 表情强度 0~1 */
  intensity?: number;
  /** 表情持续时间（毫秒），到期后回到 neutral */
  duration?: number;
}

export type EmotionMap = Record<string, EmotionRule>;

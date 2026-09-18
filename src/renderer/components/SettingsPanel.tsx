import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, ModelInfo, PluginInfo } from '../../shared/types';
import { bridge } from '../bridge';
import { IconPlug, IconX } from './Icons';

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  onClose: () => void;
}

/** Edge TTS 常用中文音色（便于按角色挑选匹配音色） */
const EDGE_VOICES: { id: string; label: string }[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温暖亲切）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女·活泼可爱）' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦（女·甜美）' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨（女·温柔知性）' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵（女·沉稳）' },
  { id: 'zh-CN-XiaoruiNeural', label: '晓睿（女·成熟）' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双（女·童声）' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱（女·轻柔）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男·少年）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男·稳重）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男·活力）' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男·童声）' },
];

/** 图形化设置面板：LLM / 语音 / 外观 / 快捷键 / 插件 */
export default function SettingsPanel({ config, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppConfig>(config);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [voiceResult, setVoiceResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [voiceTesting, setVoiceTesting] = useState(false);
  /** 是否展开 Edge 音色自定义输入（当前值不在常用列表或用户选择自定义时） */
  const [edgeCustom, setEdgeCustom] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void bridge.listModels().then(setModels).catch(() => undefined);
    void bridge.listPlugins().then(setPlugins).catch(() => undefined);
  }, []);

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    // 先临时应用草稿再测试
    await bridge.updateConfig({ llm: draft.llm });
    const r = await bridge.testLlm();
    setTestResult(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
    setTesting(false);
  };

  /** TTS 自检：先应用草稿配置，再合成一句短文本 */
  const testVoiceTts = async () => {
    setVoiceTesting(true);
    setVoiceResult(null);
    await bridge.updateConfig({ voice: draft.voice, llm: draft.llm });
    const r = await bridge.testTts(draft.voice.ttsEngine);
    setVoiceResult(r);
    setVoiceTesting(false);
  };

  /** STT 配置自检 */
  const testVoiceStt = async () => {
    setVoiceResult(null);
    await bridge.updateConfig({ voice: draft.voice, llm: draft.llm });
    const r = await bridge.testStt();
    setVoiceResult(r);
  };

  const inputCls =
    'w-full rounded-md bg-slate-700/60 border border-slate-500/40 px-2.5 py-1.5 text-sm text-slate-100 focus:border-indigo-400/60';
  const labelCls = 'block text-xs text-slate-400 mb-1';
  const sectionCls = 'text-sm font-semibold text-indigo-300 mb-2 mt-5 first:mt-0';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-600/40">
        <h2 className="text-sm font-semibold text-slate-100">{t('settings.title')}</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
          <IconX size={16} />
        </button>
      </div>

      <div className="chat-scroll flex-1 overflow-y-auto px-4 py-3">
        {/* LLM */}
        <div className={sectionCls}>{t('settings.llm')}</div>
        <label className={labelCls}>{t('settings.provider')}</label>
        <select
          className={inputCls}
          value={draft.llm.provider}
          onChange={(e) => set('llm', { ...draft.llm, provider: e.target.value as 'demo' | 'openai' })}
        >
          <option value="demo">{t('settings.providerDemo')}</option>
          <option value="openai">{t('settings.providerOpenai')}</option>
        </select>

        {draft.llm.provider === 'openai' && (
          <div className="mt-2 space-y-2">
            <div>
              <label className={labelCls}>{t('settings.baseUrl')}</label>
              <input className={inputCls} value={draft.llm.baseUrl} onChange={(e) => set('llm', { ...draft.llm, baseUrl: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('settings.apiKey')}</label>
              <input
                type="password"
                className={inputCls}
                value={draft.llm.apiKey}
                onChange={(e) => set('llm', { ...draft.llm, apiKey: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={testConnection}
                disabled={testing}
                className="text-xs px-3 py-1.5 rounded-md bg-slate-600/60 hover:bg-slate-500/60 text-slate-200 disabled:opacity-50"
              >
                {testing ? t('settings.testing') : t('settings.testConnection')}
              </button>
              {testResult && <span className={`text-xs self-center ${testResult.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{testResult}</span>}
            </div>
          </div>
        )}

        <div className="mt-2">
          <label className={labelCls}>{t('settings.model')}</label>
          <input className={inputCls} value={draft.llm.model} onChange={(e) => set('llm', { ...draft.llm, model: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelCls}>{t('settings.temperature')} ({draft.llm.temperature})</label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={draft.llm.temperature}
              onChange={(e) => set('llm', { ...draft.llm, temperature: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </div>
          <div>
            <label className={labelCls}>{t('settings.maxTokens')}</label>
            <input
              type="number"
              className={inputCls}
              value={draft.llm.maxTokens}
              onChange={(e) => set('llm', { ...draft.llm, maxTokens: Number(e.target.value) || 1024 })}
            />
          </div>
        </div>
        <div className="mt-2">
          <label className={labelCls}>{t('settings.contextWindow')}</label>
          <input
            type="number"
            className={inputCls}
            value={draft.llm.contextWindow}
            onChange={(e) => set('llm', { ...draft.llm, contextWindow: Number(e.target.value) || 20 })}
          />
        </div>
        <div className="mt-2">
          <label className={labelCls}>{t('settings.systemPrompt')}</label>
          <textarea
            rows={4}
            className={`${inputCls} resize-none`}
            value={draft.llm.systemPrompt}
            onChange={(e) => set('llm', { ...draft.llm, systemPrompt: e.target.value })}
          />
        </div>

        {/* 语音 */}
        <div className={sectionCls}>{t('settings.voice')}</div>
        <label className="flex items-center gap-2 text-sm text-slate-200 mb-2">
          <input
            type="checkbox"
            checked={draft.voice.enabled}
            onChange={(e) => set('voice', { ...draft.voice, enabled: e.target.checked })}
            className="accent-indigo-500"
          />
          {t('settings.voiceEnabled')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>{t('settings.ttsEngine')}</label>
            <select
              className={inputCls}
              value={draft.voice.ttsEngine}
              onChange={(e) => set('voice', { ...draft.voice, ttsEngine: e.target.value as 'edge' | 'browser' | 'openai' })}
            >
              <option value="browser">{t('settings.ttsBrowser')}</option>
              <option value="openai">{t('settings.ttsOpenai')}</option>
              <option value="edge">{t('settings.ttsEdge')}</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('settings.sttEngine')}</label>
            <select
              className={inputCls}
              value={draft.voice.sttEngine}
              onChange={(e) => set('voice', { ...draft.voice, sttEngine: e.target.value as 'whisper' | 'webspeech' })}
            >
              <option value="webspeech">{t('settings.sttWebspeech')}</option>
              <option value="whisper">{t('settings.sttWhisper')}</option>
            </select>
          </div>
        </div>

        {/* OpenAI TTS */}
        {draft.voice.ttsEngine === 'openai' && (
          <div className="mt-2 space-y-2 rounded-md bg-slate-700/30 border border-slate-600/40 p-2">
            <div className="text-[11px] text-slate-400">{t('settings.openaiTtsHint')}</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{t('settings.openaiTtsModel')}</label>
                <input
                  className={inputCls}
                  value={draft.voice.openaiTtsModel}
                  onChange={(e) => set('voice', { ...draft.voice, openaiTtsModel: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>{t('settings.openaiTtsVoice')}</label>
                <select
                  className={inputCls}
                  value={draft.voice.openaiTtsVoice}
                  onChange={(e) => set('voice', { ...draft.voice, openaiTtsVoice: e.target.value })}
                >
                  {['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('settings.openaiTtsBaseUrl')}</label>
              <input
                className={inputCls}
                placeholder={t('settings.reuseLlm')}
                value={draft.voice.openaiTtsBaseUrl}
                onChange={(e) => set('voice', { ...draft.voice, openaiTtsBaseUrl: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>{t('settings.openaiTtsApiKey')}</label>
              <input
                type="password"
                className={inputCls}
                placeholder={t('settings.reuseLlm')}
                value={draft.voice.openaiTtsApiKey}
                onChange={(e) => set('voice', { ...draft.voice, openaiTtsApiKey: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* Whisper STT */}
        {draft.voice.sttEngine === 'whisper' && (
          <div className="mt-2 space-y-2 rounded-md bg-slate-700/30 border border-slate-600/40 p-2">
            <div className="text-[11px] text-slate-400">{t('settings.whisperHint')}</div>
            <div>
              <label className={labelCls}>{t('settings.whisperBaseUrl')}</label>
              <input
                className={inputCls}
                placeholder={t('settings.reuseLlm')}
                value={draft.voice.whisperBaseUrl}
                onChange={(e) => set('voice', { ...draft.voice, whisperBaseUrl: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{t('settings.whisperApiKey')}</label>
                <input
                  type="password"
                  className={inputCls}
                  placeholder={t('settings.reuseLlm')}
                  value={draft.voice.whisperApiKey}
                  onChange={(e) => set('voice', { ...draft.voice, whisperApiKey: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>{t('settings.whisperModel')}</label>
                <input
                  className={inputCls}
                  value={draft.voice.whisperModel}
                  onChange={(e) => set('voice', { ...draft.voice, whisperModel: e.target.value })}
                />
              </div>
            </div>
          </div>
        )}

        {draft.voice.ttsEngine === 'edge' && (
          <div className="mt-2">
            <label className={labelCls}>{t('settings.edgeVoice')}</label>
            <select
              className={inputCls}
              value={
                edgeCustom || !EDGE_VOICES.some((v) => v.id === draft.voice.edgeVoice)
                  ? '__custom__'
                  : draft.voice.edgeVoice
              }
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setEdgeCustom(true);
                } else {
                  setEdgeCustom(false);
                  set('voice', { ...draft.voice, edgeVoice: e.target.value });
                }
              }}
            >
              {EDGE_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
              <option value="__custom__">{t('settings.edgeVoiceCustom')}</option>
            </select>
            {(edgeCustom || !EDGE_VOICES.some((v) => v.id === draft.voice.edgeVoice)) && (
              <input
                className={`${inputCls} mt-1`}
                value={draft.voice.edgeVoice}
                onChange={(e) => set('voice', { ...draft.voice, edgeVoice: e.target.value })}
              />
            )}
          </div>
        )}

        {/* 语音自检 */}
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            onClick={testVoiceTts}
            disabled={voiceTesting}
            className="text-xs px-3 py-1.5 rounded-md bg-slate-600/60 hover:bg-slate-500/60 text-slate-200 disabled:opacity-50"
          >
            {t('settings.testTts')}
          </button>
          {draft.voice.sttEngine === 'whisper' && (
            <button
              onClick={testVoiceStt}
              className="text-xs px-3 py-1.5 rounded-md bg-slate-600/60 hover:bg-slate-500/60 text-slate-200"
            >
              {t('settings.testStt')}
            </button>
          )}
          {voiceResult && (
            <span className={`text-xs self-center ${voiceResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {voiceResult.ok ? '✓' : '✗'} {voiceResult.message}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelCls}>{t('settings.wakeWord')}</label>
            <input className={inputCls} value={draft.voice.wakeWord} onChange={(e) => set('voice', { ...draft.voice, wakeWord: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300 mt-5">
            <input
              type="checkbox"
              checked={draft.voice.wakeWordEnabled}
              onChange={(e) => set('voice', { ...draft.voice, wakeWordEnabled: e.target.checked })}
              className="accent-indigo-500"
            />
            {t('settings.wakeWordEnabled')}
          </label>
        </div>

        {/* 外观 */}
        <div className={sectionCls}>{t('settings.appearance')}</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>{t('settings.modelSelect')}</label>
            <select
              className={inputCls}
              value={draft.appearance.modelDir}
              onChange={(e) => set('appearance', { ...draft.appearance, modelDir: e.target.value })}
            >
              {models.length === 0 && <option value={draft.appearance.modelDir}>{draft.appearance.modelDir}</option>}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('settings.modelScale')} ({draft.appearance.modelScale.toFixed(2)}x)</label>
            <input
              type="range"
              min={0.3}
              max={2.5}
              step={0.05}
              value={draft.appearance.modelScale}
              onChange={(e) => set('appearance', { ...draft.appearance, modelScale: Number(e.target.value) })}
              className="w-full accent-indigo-500 mt-2"
            />
          </div>
        </div>
        <div className="mt-2">
          <label className={labelCls}>
            {t('settings.modelX')} ({Math.round(draft.appearance.modelX * 100)}%)
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.appearance.modelX}
            onChange={(e) => set('appearance', { ...draft.appearance, modelX: Number(e.target.value) })}
            className="w-full accent-indigo-500"
          />
        </div>
        <div className="mt-2">
          <label className={labelCls}>{t('settings.footInset')} ({draft.appearance.footInset}px)</label>
          <input
            type="range"
            min={0}
            max={120}
            step={2}
            value={draft.appearance.footInset}
            onChange={(e) => set('appearance', { ...draft.appearance, footInset: Number(e.target.value) })}
            className="w-full accent-indigo-500"
          />
        </div>
        <div className="flex gap-2 mt-1">
          {[0.5, 1, 1.5, 2].map((s) => (
            <button
              key={s}
              onClick={() => set('appearance', { ...draft.appearance, modelScale: s })}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                Math.abs(draft.appearance.modelScale - s) < 0.001
                  ? 'bg-indigo-600/40 border-indigo-400/50 text-indigo-100'
                  : 'bg-slate-700/50 border-slate-600/40 text-slate-300 hover:bg-slate-600/50'
              }`}
            >
              {s}x
            </button>
          ))}
          <button
            onClick={() => set('appearance', { ...draft.appearance, modelScale: 1, modelX: 0.5 })}
            className="text-[11px] px-2 py-1 rounded border bg-slate-700/50 border-slate-600/40 text-slate-300 hover:bg-slate-600/50"
          >
            {t('settings.resetSize')}
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-200 mt-3">
          <input
            type="checkbox"
            checked={draft.appearance.avoidPanel}
            onChange={(e) => set('appearance', { ...draft.appearance, avoidPanel: e.target.checked })}
            className="accent-indigo-500"
          />
          {t('settings.avoidPanel')}
        </label>
        <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{t('settings.avoidPanelHint')}</p>

        <label className="flex items-center gap-2 text-sm text-slate-200 mt-3">
          <input
            type="checkbox"
            checked={draft.appearance.autoResizeWindow}
            onChange={(e) => set('appearance', { ...draft.appearance, autoResizeWindow: e.target.checked })}
            className="accent-indigo-500"
          />
          {t('settings.autoResizeWindow')}
        </label>
        <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{t('settings.autoResizeWindowHint')}</p>

        <label className="flex items-center gap-2 text-sm text-slate-200 mt-3">
          <input
            type="checkbox"
            checked={draft.appearance.showToolbar}
            onChange={(e) => set('appearance', { ...draft.appearance, showToolbar: e.target.checked })}
            className="accent-indigo-500"
          />
          {t('settings.showToolbar')}
        </label>
        {draft.appearance.showToolbar && (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-200 mt-2">
              <input
                type="checkbox"
                checked={draft.appearance.autoHideToolbar}
                onChange={(e) => set('appearance', { ...draft.appearance, autoHideToolbar: e.target.checked })}
                className="accent-indigo-500"
              />
              {t('settings.autoHideToolbar')}
            </label>
            {draft.appearance.autoHideToolbar && (
              <div className="mt-2">
                <label className={labelCls}>
                  {t('settings.toolbarHideDelay')} ({(draft.appearance.toolbarHideDelay / 1000).toFixed(1)}s)
                </label>
                <input
                  type="range"
                  min={1000}
                  max={15000}
                  step={500}
                  value={draft.appearance.toolbarHideDelay}
                  onChange={(e) => set('appearance', { ...draft.appearance, toolbarHideDelay: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>
            )}
          </>
        )}

        {/* 快捷键 */}
        <div className={sectionCls}>{t('settings.shortcuts')}</div>
        {(
          [
            ['toggleCharacter', t('settings.shortcutToggle')],
            ['pushToTalk', t('settings.shortcutTalk')],
            ['toggleMute', t('settings.shortcutMute')],
            ['openSettings', t('settings.shortcutSettings')],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="mb-2">
            <label className={labelCls}>{label}</label>
            <input
              className={inputCls}
              value={draft.shortcuts[key]}
              onChange={(e) => set('shortcuts', { ...draft.shortcuts, [key]: e.target.value })}
            />
          </div>
        ))}

        {/* 插件 */}
        <div className={sectionCls}>{t('settings.plugins')}</div>
        {plugins.length === 0 ? (
          <p className="text-xs text-slate-400">{t('settings.noPlugins')}</p>
        ) : (
          <div className="space-y-2">
            {plugins.map((p) => (
              <div key={p.id} className="flex items-start gap-2 rounded-md bg-slate-700/40 border border-slate-600/40 p-2">
                <IconPlug size={14} className="text-indigo-300 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-200">
                    {p.name} <span className="text-slate-500">v{p.version}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{p.description}</div>
                  {p.tools.length > 0 && (
                    <div className="text-[10px] text-indigo-300/80 mt-0.5">
                      工具: {p.tools.map((tl) => tl.name).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-600/40">
        {saved && <span className="text-xs text-emerald-400">{t('settings.saved')}</span>}
        <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md bg-slate-600/60 hover:bg-slate-500/60 text-slate-200">
          {t('settings.cancel')}
        </button>
        <button onClick={save} className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white">
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}

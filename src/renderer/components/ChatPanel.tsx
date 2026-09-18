import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../shared/types';
import { IconCopy, IconImage, IconMic, IconSend, IconStop, IconX } from './Icons';

export interface UiMessage extends ChatMessage {
  streaming?: boolean;
}

interface Props {
  messages: UiMessage[];
  busy: boolean;
  micActive: boolean;
  micSupported: boolean;
  /** 语音状态提示（录音中 / 转写中 / 错误信息） */
  hint?: string;
  onSend: (text: string, images?: string[]) => void;
  onStop: () => void;
  onMicToggle: () => void;
}

const EMOTION_LABEL: Record<string, string> = {
  happy: '开心',
  sad: '难过',
  thinking: '思考',
  angry: '生气',
  surprised: '惊讶',
  shy: '害羞',
  embarrassed: '尴尬',
  neutral: '平静',
};

/** 单条消息最多附带图片数与单张大小上限（base64 会进 IPC/数据库，需限制） */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 读取图片文件为 data URL（限制类型与大小） */
function readImageFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null);
    if (file.size > MAX_IMAGE_BYTES) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 聊天面板：流式渲染回复、展示情感标签、文本/语音/图片输入、消息复制 */
export default function ChatPanel({ messages, busy, micActive, micSupported, hint, onSend, onStop, onMicToggle }: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pendingImages]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const submit = () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || busy) return;
    setInput('');
    const imgs = pendingImages.length > 0 ? pendingImages : undefined;
    setPendingImages([]);
    onSend(text, imgs);
  };

  const addImages = async (files: FileList | File[]) => {
    const list = [...files].slice(0, MAX_IMAGES - pendingImages.length);
    const urls: string[] = [];
    for (const f of list) {
      const url = await readImageFile(f);
      if (url) urls.push(url);
    }
    if (urls.length > 0) setPendingImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
  };

  const copyMessage = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return (
    <div
      className="flex flex-col flex-1 min-h-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) void addImages(e.dataTransfer.files);
      }}
    >
      {/* 消息列表 */}
      <div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-2">
            <span className="text-3xl">🐱</span>
            <p className="text-sm">{t('chat.empty')}</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg-in group/msg flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="relative max-w-[85%]">
              <div
                className={`rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  m.role === 'user'
                    ? 'bg-indigo-600/90 text-white rounded-br-sm'
                    : 'bg-slate-700/80 text-slate-100 rounded-bl-sm'
                }`}
              >
                {m.role === 'assistant' && m.emotion && (
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">
                      {EMOTION_LABEL[m.emotion] ?? m.emotion}
                    </span>
                  </div>
                )}
                {m.images && m.images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {m.images.map((src, j) => (
                      <img
                        key={j}
                        src={src}
                        alt=""
                        className="w-16 h-16 object-cover rounded-md border border-white/20"
                      />
                    ))}
                  </div>
                )}
                {m.content}
                {m.streaming && (
                  <span className="inline-flex ml-1 gap-0.5 align-middle">
                    <span className="typing-dot w-1 h-1 rounded-full bg-slate-300 inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-slate-300 inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-slate-300 inline-block" />
                  </span>
                )}
              </div>
              {/* 复制按钮：悬停显示；放在气泡外侧靠面板内的一边，避免被裁切遮挡
                  （助手消息左对齐→按钮在右侧；用户消息右对齐→按钮在左侧） */}
              {m.content && !m.streaming && (
                <button
                  onClick={() => void copyMessage(m.content, i)}
                  title={copiedIdx === i ? t('chat.copied') : t('chat.copy')}
                  className={`absolute top-1 text-slate-400 hover:text-slate-200 transition-opacity ${
                    m.role === 'assistant' ? '-right-7' : '-left-7'
                  } ${copiedIdx === i ? 'opacity-100 text-emerald-400' : 'opacity-0 group-hover/msg:opacity-100'}`}
                >
                  <IconCopy size={13} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 输入区 */}
      <div className="p-3 border-t border-slate-600/40">
        {hint && (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-indigo-200 bg-indigo-500/15 border border-indigo-400/25 rounded-md px-2 py-1">
            {micActive && <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse shrink-0" />}
            <span className="truncate">{hint}</span>
          </div>
        )}
        {/* 待发送图片预览 */}
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt="" className="w-14 h-14 object-cover rounded-md border border-slate-500/40" />
                <button
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-600 hover:bg-red-500 text-white flex items-center justify-center"
                >
                  <IconX size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {micSupported && (
            <button
              onClick={onMicToggle}
              title={t('toolbar.mic')}
              className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                micActive ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-600/60 text-slate-200 hover:bg-slate-500/60'
              }`}
            >
              <IconMic size={16} />
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            title={t('chat.attach')}
            disabled={pendingImages.length >= MAX_IMAGES}
            className="shrink-0 w-9 h-9 rounded-lg bg-slate-600/60 text-slate-200 hover:bg-slate-500/60 flex items-center justify-center disabled:opacity-40"
          >
            <IconImage size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addImages(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (files.length > 0) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            placeholder={micActive ? t('voice.listening') : t('chat.placeholder')}
            rows={1}
            className="flex-1 resize-none rounded-lg bg-slate-700/60 border border-slate-500/40 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 focus:border-indigo-400/60 max-h-24"
          />
          {busy ? (
            <button
              onClick={onStop}
              title={t('chat.stop')}
              className="shrink-0 w-9 h-9 rounded-lg bg-red-500/80 hover:bg-red-500 text-white flex items-center justify-center"
            >
              <IconStop size={16} />
            </button>
          ) : (
            <button
              onClick={submit}
              title={t('chat.send')}
              className="shrink-0 w-9 h-9 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center"
            >
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

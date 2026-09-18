import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistorySession } from '../../shared/types';
import { bridge } from '../bridge';
import { IconSearch, IconTrash, IconX } from './Icons';

interface Props {
  currentSessionId: string;
  onOpenSession: (session: HistorySession) => void;
  onClose: () => void;
  /** 当前会话被删除/清空时回调（用于新建会话兜底） */
  onCurrentDeleted?: () => void;
}

/** 对话历史面板：会话列表 + 搜索（FTS5 由主进程提供） */
export default function HistoryPanel({ currentSessionId, onOpenSession, onClose, onCurrentDeleted }: Props) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [keyword, setKeyword] = useState('');
  /** 应用内二次确认态（避免原生 confirm 模态在无边框窗口下丢失键盘焦点） */
  const [confirmClear, setConfirmClear] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  const refresh = () => {
    void bridge.listSessions().then(setSessions);
  };

  useEffect(refresh, []);

  const filtered = keyword
    ? sessions.filter((s) => s.title.toLowerCase().includes(keyword.toLowerCase()))
    : sessions;

  const remove = async (id: string) => {
    await bridge.deleteSession(id);
    if (id === currentSessionId) onCurrentDeleted?.();
    refresh();
  };

  // 应用内二次确认：不使用原生 window.confirm。
  // 无边框透明窗口下系统模态关闭后可能不归还键盘焦点，导致随后「无法输入」。
  const onClearClick = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    setConfirmClear(false);
    await bridge.clearHistory();
    onCurrentDeleted?.();
    // 主动把 OS 焦点抢回窗口，确保键盘输入可用
    void bridge.focusWindow();
    refresh();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-600/40">
        <h2 className="text-sm font-semibold text-slate-100">{t('history.title')}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void onClearClick()}
            disabled={sessions.length === 0}
            title={t('history.clearConfirm')}
            className={`text-[11px] transition-colors disabled:opacity-40 ${
              confirmClear ? 'text-red-400 font-medium' : 'text-slate-400 hover:text-red-400'
            }`}
          >
            {confirmClear ? t('history.clearConfirmBtn') : t('history.clearAll')}
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <IconX size={16} />
          </button>
        </div>
      </div>

      <div className="px-4 py-2">
        <div className="flex items-center gap-2 rounded-md bg-slate-700/60 border border-slate-500/40 px-2.5 py-1.5">
          <IconSearch size={13} className="text-slate-400 shrink-0" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('history.search')}
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-400"
          />
        </div>
      </div>

      <div className="chat-scroll flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
        {filtered.length === 0 && <p className="text-xs text-slate-400 text-center mt-8">{t('history.empty')}</p>}
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`group flex items-center gap-2 rounded-md px-2.5 py-2 cursor-pointer transition-colors ${
              s.id === currentSessionId ? 'bg-indigo-600/30 border border-indigo-400/30' : 'bg-slate-700/40 hover:bg-slate-600/50 border border-transparent'
            }`}
            onClick={() => onOpenSession(s)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-200 truncate">{s.title}</div>
              <div className="text-[10px] text-slate-500">
                {new Date(s.updatedAt).toLocaleString()} · {s.messageCount} 条
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void remove(s.id);
              }}
              title={t('history.delete')}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 transition-opacity"
            >
              <IconTrash size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { bridge } from '../bridge';
import {
  IconChat,
  IconEyeOff,
  IconHistory,
  IconMinus,
  IconSettings,
  IconVolume,
  IconVolumeX,
  IconX,
} from './Icons';

export type PanelKind = 'chat' | 'history' | 'settings' | null;

interface Props {
  activePanel: PanelKind;
  muted: boolean;
  characterVisible: boolean;
  isElectron: boolean;
  /** 窗口拖拽状态回调（true=开始拖动/false=结束），供上层冻结角色重排 */
  onWindowDragState?: (dragging: boolean) => void;
  /** 折叠态：淡出并上移，同时禁用交互（自动折叠时使用） */
  collapsed?: boolean;
  onTogglePanel: (panel: Exclude<PanelKind, null>) => void;
  onToggleMute: () => void;
  onToggleCharacter: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onQuit: () => void;
}

/** 悬浮工具栏：面板切换 + 静音 + 角色显隐 + 窗口控制 */
export default function Toolbar({
  activePanel,
  muted,
  characterVisible,
  isElectron,
  onWindowDragState,
  collapsed = false,
  onTogglePanel,
  onToggleMute,
  onToggleCharacter,
  onMinimize,
  onClose,
  onQuit,
}: Props) {
  const { t } = useTranslation();

  const btn = (active: boolean) =>
    `w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
      active ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-600/60 hover:text-white'
    }`;

  /** 按住工具栏（除按钮外）拖动整个窗口：指针捕获 + 增量移动。
   *  必须用屏幕绝对坐标 screenX/screenY 计算增量：窗口移动会改变视口原点，
   *  若用 clientX/clientY 会形成反馈环（窗口动→client 坐标反向变→抖动/拉伸）。 */
  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isElectron || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const handle = e.currentTarget;
    onWindowDragState?.(true);
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    let lastX = e.screenX;
    let lastY = e.screenY;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      lastX = ev.screenX;
      lastY = ev.screenY;
      if (dx !== 0 || dy !== 0) void bridge.moveWindowBy(dx, dy);
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
      onWindowDragState?.(false);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      onPointerDown={onDragStart}
      className={`titlebar-drag glass rounded-2xl px-2 py-1.5 flex items-center gap-1 transition-all duration-300 ${
        collapsed ? 'opacity-0 -translate-y-4 pointer-events-none' : 'opacity-100 translate-y-0 pointer-events-auto'
      }`}
      aria-hidden={collapsed}
    >
      <div className="titlebar-no-drag flex items-center gap-1">
        <button className={btn(activePanel === 'chat')} onClick={() => onTogglePanel('chat')} title={t('toolbar.chat')}>
          <IconChat size={15} />
        </button>
        <button className={btn(activePanel === 'history')} onClick={() => onTogglePanel('history')} title={t('toolbar.history')}>
          <IconHistory size={15} />
        </button>
        <button className={btn(activePanel === 'settings')} onClick={() => onTogglePanel('settings')} title={t('toolbar.settings')}>
          <IconSettings size={15} />
        </button>

        <div className="w-px h-5 bg-slate-500/40 mx-1" />

        <button className={btn(false)} onClick={onToggleMute} title={muted ? t('toolbar.unmute') : t('toolbar.mute')}>
          {muted ? <IconVolumeX size={15} /> : <IconVolume size={15} />}
        </button>
        <button className={btn(false)} onClick={onToggleCharacter} title={t('toolbar.hideCharacter')}>
          <IconEyeOff size={15} />
        </button>

        {isElectron && (
          <>
            <div className="w-px h-5 bg-slate-500/40 mx-1" />
            <button className={btn(false)} onClick={onMinimize} title={t('toolbar.minimize')}>
              <IconMinus size={15} />
            </button>
            <button className={btn(false)} onClick={onClose} title={t('toolbar.close')}>
              <IconX size={15} />
            </button>
            <button className={btn(false)} onClick={onQuit} title={t('toolbar.quit')}>
              <IconX size={15} className="text-red-400" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { QevoBotMark } from './QevoBotMark';
import { navigate, Route } from '../lib/router';
import type { NavCounters } from '../hooks/useNavCounters';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { ApiError } from '../lib/api';
import { dayLabel, stickersApi, stickersChanged, type Sticker } from '../lib/stickers-api';
import { askFor, guessIntent, INTENT_LABEL, type IntentKind } from '../lib/voice-intent';

type Tab = { key: string; label: string; icon: 'target' | 'board' | 'chat' | 'pin'; go: () => void; match: (r: Route) => boolean };

/*
  #4997, шаг 0.1: пять кнопок вместо шести — Фокус · Проекты · [QEVO Bot по центру] · Чаты · Стикеры.
  «Миты» — вкладкой «Встречи» внутри «Чатов» (как «Чаты и встречи» на компьютере), «Ещё» — в
  меню по аватарке вверху справа. Плавающего микрофона больше нет: его заменяет удержание бота.
*/
const LEFT: Tab[] = [
  { key: 'focus', label: 'Фокус', icon: 'target', go: () => navigate({ section: 'focus' }), match: (r) => r.section === 'focus' },
  { key: 'projects', label: 'Проекты', icon: 'board', go: () => navigate({ section: 'projects' }), match: (r) => r.section === 'projects' || r.section === 'tasks' },
];
const RIGHT: Tab[] = [
  { key: 'chat', label: 'Чаты', icon: 'chat', go: () => navigate({ section: 'chat' }), match: (r) => r.section === 'chat' && r.chatId !== 'anthill' },
  { key: 'stickers', label: 'Стикеры', icon: 'pin', go: () => navigate({ section: 'stickers' }), match: (r) => r.section === 'stickers' },
];

/** Плашка над кнопкой бота: «Слушаю…», «Стикер на завтра» — стилем здесь, стартовый CSS и так на пределе. */
const HOLD: React.CSSProperties = {
  position: 'fixed', left: 12, right: 12, bottom: 'calc(var(--bottom-nav-h) + 22px)', zIndex: 60, padding: '12px 14px',
  borderRadius: 'var(--radius)', background: 'var(--bg-elev)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)', fontSize: 'var(--fs-sm)',
};

/** Удержание дольше этого — голос, короче — просто открыть бота. */
const HOLD_MS = 350;

export function BottomNav({ route, unread, counters }: {
  route: Route;
  unread: number;
  counters: NavCounters;
  onMore?: () => void;
}) {
  const badge = (key: string): number => (key === 'chat' ? unread
    : key === 'focus' ? counters.focus.decide
      : key === 'projects' ? counters.tasks?.unread ?? 0
        : 0);
  const tab = (t: Tab) => {
    const n = badge(t.key);
    return (
      <button key={t.key} data-tour={`tab-${t.key}`} className={`bottom-nav-item${t.match(route) ? ' active' : ''}`}
        onClick={t.go} aria-current={t.match(route) ? 'page' : undefined}>
        <span className="bottom-nav-icon">
          <Icon name={t.icon} size={22} />
          {n > 0 && <span className="bottom-nav-badge">{n > 99 ? '99+' : n}</span>}
        </span>
        <span className="bottom-nav-label">{t.label}</span>
      </button>
    );
  };
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      {LEFT.map(tab)}
      <BotButton active={route.section === 'chat' && route.chatId === 'anthill'} />
      {RIGHT.map(tab)}
    </nav>
  );
}

/**
 * Центральная кнопка QEVO Bot (шаг 0.2). Нажать — открыть бота. Удерживать — сразу запись:
 * отпустил — сохраню, смахнул вверх — отмена. Сказанное разбираем по смыслу: «поставь задачу…» —
 * окно задачи, вопрос — боту, всё остальное («завтра в 10 позвонить Ивану») — стикер.
 */
function BotButton({ active }: { active: boolean }) {
  const [holding, setHolding] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [made, setMade] = useState<Sticker | null>(null);
  const [err, setErr] = useState('');
  const timer = useRef(0);
  const startY = useRef(0);
  const held = useRef(false);
  const cancelled = useRef(false);

  const voice = useVoiceInput((text) => {
    if (cancelled.current) return;
    route(text);
  });

  // #5006: красная плашка ошибки не висит вечно
  const { error: voiceError, clearError } = voice;
  useEffect(() => {
    if (!voiceError) return;
    const t = window.setTimeout(clearError, 6000);
    return () => window.clearTimeout(t);
  }, [voiceError, clearError]);

  /*
    #5007/#5008: сказанное не раскладываем молча — спрашиваем «что сделать?», догадка выделена.
    Раньше по умолчанию был стикер, и «поставь задачу Сергею…» превращалось в стикер.
  */
  const [choice, setChoice] = useState<{ text: string; guess: IntentKind } | null>(null);
  const route = (text: string) => {
    const t = text.trim();
    if (t) setChoice({ text: t, guess: guessIntent(t) });
  };
  const askBot = (q: string) => {
    (window as { qevoAsk?: string }).qevoAsk = q;
    navigate({ section: 'chat', chatId: 'anthill' });
    window.setTimeout(() => window.dispatchEvent(new Event('qevo:bot-ask')), 300);
  };
  const run = async (kind: IntentKind, t: string) => {
    setChoice(null);
    if (kind === 'task') {
      window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: t.replace(/^(постав|созда|заведи)\S*\s+(мне\s+)?задач\S*\s*/i, '') || t } }));
      return;
    }
    if (kind !== 'sticker') { askBot(askFor(kind, t)); return; }
    try {
      const s = await stickersApi.create({ text: t.replace(/^(напомни(те)?(\s+мне)?|не\s+забыть|стикер)\s*[:,—-]?\s*/i, '') || t, source: 'voice', fallback: 'today' });
      stickersChanged();
      setMade(s);
      window.setTimeout(() => setMade((m) => (m?.id === s.id ? null : m)), 6000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось сохранить'); window.setTimeout(() => setErr(''), 4000); }
  };

  const down = (e: React.PointerEvent) => {
    held.current = false; cancelled.current = false; setCancel(false);
    startY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    timer.current = window.setTimeout(() => {
      held.current = true; setHolding(true);
      try { navigator.vibrate?.(15); } catch { /* без вибрации */ }
      void voice.start();
    }, HOLD_MS);
  };
  const moveP = (e: React.PointerEvent) => {
    if (!held.current) return;
    const up = startY.current - e.clientY > 60;
    cancelled.current = up; setCancel(up);
  };
  const upP = () => {
    window.clearTimeout(timer.current);
    if (!held.current) { navigate({ section: 'chat', chatId: 'anthill' }); return; }
    held.current = false; setHolding(false);
    // #5006: смахнули вверх — отмена: запись выбрасываем, не распознаём и не ругаемся
    if (cancelled.current) voice.cancel(); else voice.stop();
  };

  return (
    <>
      <button className={`bn-bot${active ? ' active' : ''}${voice.recording ? ' is-rec' : ''}`} data-tour="tab-bot"
        aria-label="QEVO-бот — нажать: открыть, удерживать: сказать"
        onPointerDown={down} onPointerMove={moveP} onPointerUp={upP}
        onPointerCancel={() => { window.clearTimeout(timer.current); if (held.current) { cancelled.current = true; held.current = false; setHolding(false); voice.cancel(); } }}
        onContextMenu={(e) => e.preventDefault()}>
        <span className="bn-bot-ring" style={{
          width: 60, height: 60, marginTop: -22, borderRadius: '50%', display: 'grid', placeItems: 'center', touchAction: 'none',
          background: voice.recording ? '#e5484d' : 'var(--accent)', border: '3px solid var(--bg-elev)', boxShadow: 'var(--shadow-lg)',
        }}>
          {voice.recording ? <span style={{ color: '#fff', display: 'grid' }}><Icon name="mic" size={26} /></span> : <QevoBotMark size={34} />}
        </span>
      </button>
      {(holding || voice.recording) && (
        <div style={HOLD} role="status">
          <b>{cancel ? 'Отпустите — отменю' : 'Слушаю…'}</b>
          <div className="dim">Отпустите — спрошу, что сделать · смахните вверх — отменить</div>
        </div>
      )}
      {voice.transcribing && <div style={HOLD} role="status">Распознаю…</div>}
      {/* #5006: ошибка закрывается крестиком или нажатием и сама гаснет через 6 с */}
      {(err || (voice.error && !voice.recording)) && (
        <div className="error-text" style={{ ...HOLD, display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }} role="alert"
          onClick={() => { setErr(''); voice.clearError(); }}>
          <span style={{ flex: 1 }}>{err || voice.error}</span>
          <button type="button" aria-label="Закрыть" title="Закрыть" onClick={(e) => { e.stopPropagation(); setErr(''); voice.clearError(); }}
            style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 20, lineHeight: 1, padding: '0 2px', cursor: 'pointer' }}>×</button>
        </div>
      )}
      {choice && (
        <div style={HOLD} role="dialog" aria-label="Что сделать">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <b style={{ flex: 1 }}>Что сделать?</b>
            <button type="button" aria-label="Закрыть" onClick={() => setChoice(null)}
              style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 20, lineHeight: 1, padding: '0 2px', cursor: 'pointer' }}>×</button>
          </div>
          <div className="dim" style={{ margin: '4px 0 10px' }}>«{choice.text}»</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(['task', 'sticker', 'event', 'message', 'ask'] as IntentKind[]).map((k) => (
              <button key={k} type="button" className={`ui-btn ui-btn-sm ${k === choice.guess ? 'ui-btn-primary' : 'ui-btn-outline'}`}
                onClick={() => void run(k, choice.text)}>{INTENT_LABEL[k]}</button>
            ))}
          </div>
        </div>
      )}
      {made && (
        <div style={HOLD} role="status">
          <b>📌 Стикер на {made.date ? dayLabel(made.date) : 'без даты'}{made.time ? `, ${made.time}` : ''}</b>
          <div>{made.text}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { setMade(null); navigate({ section: 'stickers' }); }}>Изменить</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { const id = made.id; setMade(null); void stickersApi.mark([id], 'delete').then(stickersChanged); }}>Отменить</button>
          </div>
        </div>
      )}
    </>
  );
}

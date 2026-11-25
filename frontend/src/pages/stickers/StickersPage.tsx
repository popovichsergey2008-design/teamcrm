import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import {
  addDays, dayLabel, dayMonth, nextWeekday, openQuickSticker, parseYmd, STICKER_COLORS, stickersApi, stickersChanged, STICKERS_CHANGED,
  weekdayShort, ymd, type Sticker, type StickerBoard, type StickerColor,
} from '../../lib/stickers-api';
import { StickerToTask } from './StickerToTask';
import '../../components/stickers/stickers.css';
import './stickers-page.css';

type Undo = { text: string; run: () => Promise<unknown> } | null;
type Col = { key: string; title: string; date: string | null; kind: 'overdue' | 'day' | 'later' | 'ideas'; items: Sticker[] };

/** Лёгкий наклон «как настоящие» — от номера, чтобы не прыгал при перерисовке. */
const tilt = (id: string) => `${((Number(id) * 37) % 5) - 2}deg`.replace('-0deg', '0deg');
const nowHm = (plusMin = 0) => { const d = new Date(Date.now() + plusMin * 60_000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * Раздел «Стикеры» (#4997, пункты 3–5, 9). Доска по датам: «Просрочено» (если есть), «Сегодня»,
 * «Завтра», дни недели, «Позже», «Идеи без даты»; режим «Месяц»; на телефоне — лента по дням.
 * Стикеры личные — видит только автор. Любое действие отменяется 5 секунд.
 */
export function StickersPage() {
  const [data, setData] = useState<StickerBoard | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [q, setQ] = useState('');
  const [onlyColor, setOnlyColor] = useState<StickerColor | null>(null);
  const [legend, setLegend] = useState(false);
  const [undo, setUndo] = useState<Undo>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<'done' | 'trash' | null>(null);
  const [toTask, setToTask] = useState<Sticker | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const undoTimer = useRef(0);

  const load = useCallback(() => stickersApi.board().then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить')), []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(STICKERS_CHANGED, on);
    const mq = window.matchMedia('(max-width: 720px)');
    const onMq = () => setNarrow(mq.matches);
    mq.addEventListener('change', onMq);
    return () => { window.removeEventListener(STICKERS_CHANGED, on); mq.removeEventListener('change', onMq); };
  }, [load]);

  /** Действие с отменой: сразу на сервер, 5 секунд — «Отменить». */
  const act = useCallback(async (run: () => Promise<unknown>, text: string, revert: () => Promise<unknown>) => {
    try {
      await run();
      await load();
      window.clearTimeout(undoTimer.current);
      setUndo({ text, run: revert });
      undoTimer.current = window.setTimeout(() => setUndo(null), 5000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  }, [load]);

  const move = useCallback((s: Sticker, date: string | null, time?: string | null) => {
    if (s.date === date && (time === undefined || time === s.time)) return;
    const patch = { date, ...(time !== undefined ? { time } : {}) };
    void act(() => stickersApi.update(s.id, patch),
      date ? `Перенесено на ${dayLabel(date)}${time ? ` · ${time}` : ''}` : 'Перенесено в «Идеи без даты»',
      () => stickersApi.update(s.id, { date: s.date, time: s.time }));
  }, [act]);
  const done = useCallback((ids: string[]) => {
    void act(() => stickersApi.mark(ids, 'done'), ids.length > 1 ? `Готово: ${ids.length}` : 'Готово', () => stickersApi.mark(ids, 'undone'));
    setSelected(new Set());
  }, [act]);
  const remove = useCallback((ids: string[]) => {
    void act(() => stickersApi.mark(ids, 'delete'), `Удалено: ${ids.length}`, () => stickersApi.mark(ids, 'restore'));
    setSelected(new Set());
  }, [act]);
  const recolor = (s: Sticker, color: StickerColor) => void stickersApi.update(s.id, { color }).then(load);
  const retext = (s: Sticker, text: string) => void stickersApi.update(s.id, { text }).then(load).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не сохранилось'));

  const today = data?.today ?? ymd(new Date());
  const items = useMemo(() => (data?.items ?? []).filter((s) =>
    (!onlyColor || s.color === onlyColor)
    && (!q.trim() || `${s.text} ${s.body ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [data, onlyColor, q]);

  // колонки недели: сегодня, завтра и дни до ближайшего воскресенья (в выходные — хотя бы три дня)
  const cols = useMemo<Col[]>(() => {
    const days: string[] = [today];
    while (weekdayShort(days[days.length - 1]) !== 'вс') days.push(addDays(days[days.length - 1], 1));
    while (days.length < 3) days.push(addDays(days[days.length - 1], 1));
    const last = days[days.length - 1];
    const overdue = items.filter((s) => s.date && s.date < today);
    const out: Col[] = [];
    if (overdue.length) out.push({ key: 'overdue', title: 'Просрочено', date: null, kind: 'overdue', items: overdue });
    days.forEach((d, i) => out.push({
      key: d, date: d, kind: 'day', items: items.filter((s) => s.date === d),
      title: i === 0 ? `Сегодня · ${weekdayShort(d)} ${parseYmd(d).getDate()}` : i === 1 ? `Завтра · ${weekdayShort(d)} ${parseYmd(d).getDate()}`
        : `${weekdayShort(d).replace(/^./, (c) => c.toUpperCase())} ${parseYmd(d).getDate()}`,
    }));
    out.push({ key: 'later', title: 'Позже', date: addDays(last, 1), kind: 'later', items: items.filter((s) => s.date && s.date > last) });
    out.push({ key: 'ideas', title: 'Идеи без даты', date: null, kind: 'ideas', items: items.filter((s) => !s.date) });
    return out;
  }, [items, today]);

  const cardProps = { today, onDone: (s: Sticker) => done([s.id]), onRemove: (s: Sticker) => remove([s.id]), onMove: move, onRecolor: recolor,
    onText: retext, onTask: setToTask, selected, onSelect: (s: Sticker) => setSelected((v) => { const n = new Set(v); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; }) };

  return (
    <div className="stk-page">
      <div className="stk-head">
        <div>
          <div className="stk-crumb dim">Стикеры</div>
          <h1 className="stk-title">Мои стикеры</h1>
        </div>
        <span className="stk-private dim"><Icon name="lock" size={13} /> видите только вы</span>
      </div>
      <div className="stk-bar">
        <Button variant="primary" onClick={() => openQuickSticker()}><Icon name="plus" size={15} /> Стикер</Button>
        {!narrow && (
          <span className="kv2-seg" role="group" aria-label="Вид">
            <button className="kv2-seg-btn" aria-pressed={mode === 'week'} onClick={() => setMode('week')}>Неделя</button>
            <button className="kv2-seg-btn" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>Месяц</button>
          </span>
        )}
        <label className="stk-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по стикерам" aria-label="Поиск по стикерам" />
        </label>
        <span className="stk-legend-wrap">
          <button className="stk-legend-btn" onClick={() => setLegend((v) => !v)} aria-expanded={legend}>
            {STICKER_COLORS.map((c) => <span key={c} className={`stk-ldot st-${c}${onlyColor && onlyColor !== c ? ' is-off' : ''}`} />)}
            {onlyColor ? data?.colors.find((c) => c.key === onlyColor)?.name : 'Цвета'} <Icon name="chevron-down" size={12} />
          </button>
          {legend && data && <ColorLegend colors={data.colors} only={onlyColor} onOnly={(c) => { setOnlyColor(c); setLegend(false); }}
            onRename={(names) => void stickersApi.colors(names).then((colors) => setData((d) => (d ? { ...d, colors } : d)))} onClose={() => setLegend(false)} />}
        </span>
      </div>
      {err && <div className="error-text" role="alert">{err}</div>}
      {selected.size > 0 && (
        <div className="stk-selbar">
          Выбрано: {selected.size}
          <Button size="sm" variant="outline" onClick={() => done([...selected])}><Icon name="check" size={13} /> Готово</Button>
          <Button size="sm" variant="outline" onClick={() => remove([...selected])}><Icon name="trash" size={13} /> Удалить</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Снять выбор</Button>
        </div>
      )}

      {!data ? <div className="dim">Загружаю…</div> : narrow ? (
        <MobileRibbon cols={cols} today={today} card={cardProps} onOverdue={() => void act(() => stickersApi.overdueToToday(), 'Всё просроченное — на сегодня', () => load())} />
      ) : mode === 'week' ? (
        <div className="stk-board">
          {cols.map((c) => (
            <DropCol key={c.key} col={c} today={today} onDrop={(s) => {
              if (c.kind === 'overdue') return;
              move(s, c.kind === 'ideas' ? null : c.date);
            }} findSticker={(id) => data.items.find((s) => s.id === id)}>
              {c.items.map((s) => <StickerNote key={s.id} s={s} showDate={c.kind !== 'day'} {...cardProps} />)}
              {c.kind === 'overdue' && (
                <button className="stk-overdue-all" onClick={() => void act(() => stickersApi.overdueToToday(), 'Всё просроченное — на сегодня', async () => {
                  for (const s of c.items) await stickersApi.update(s.id, { date: s.date });
                })}>Всё просроченное → на сегодня</button>
              )}
              {c.kind === 'day' && !c.items.length && <button className="stk-add" onClick={() => openQuickSticker()} aria-label="Добавить стикер"><Icon name="plus" size={14} /></button>}
            </DropCol>
          ))}
        </div>
      ) : (
        <MonthGrid items={items} today={today} onMove={move} card={cardProps} />
      )}

      <div className="stk-foot">
        <button className="st-link stk-arch" onClick={() => setArchive('done')}>Сделано за 30 дней</button>
        <button className="st-link stk-arch" onClick={() => setArchive('trash')}>Корзина</button>
        <span className="dim">Shift+клик — выбрать несколько · перетащите стикер на другой день · Alt+N — новый стикер с любого экрана</span>
      </div>
      {archive && <Archive kind={archive} onClose={() => { setArchive(null); void load(); }} />}
      {toTask && <StickerToTask sticker={toTask} onClose={() => setToTask(null)} onDone={() => { setToTask(null); void load(); }} />}
      {undo && (
        <div className="stk-undo" role="status">
          {undo.text}
          <button onClick={() => { const u = undo; setUndo(null); void u.run().then(load); }}>Отменить</button>
        </div>
      )}
    </div>
  );
}

type CardProps = {
  today: string; selected: Set<string>; onDone: (s: Sticker) => void; onRemove: (s: Sticker) => void;
  onMove: (s: Sticker, date: string | null, time?: string | null) => void; onRecolor: (s: Sticker, c: StickerColor) => void;
  onText: (s: Sticker, t: string) => void; onTask: (s: Sticker) => void; onSelect: (s: Sticker) => void;
};

function DropCol({ col, today, onDrop, findSticker, children }: {
  col: Col; today: string; onDrop: (s: Sticker) => void; findSticker: (id: string) => Sticker | undefined; children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <section className={`stk-col stk-${col.kind}${col.date === today && col.kind === 'day' ? ' is-today' : ''}${over ? ' is-over' : ''}`}
      onDragOver={(e) => { if (col.kind !== 'overdue') { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const s = findSticker(e.dataTransfer.getData('text/sticker')); if (s) onDrop(s); }}
      aria-label={col.title}>
      <header className="stk-col-head"><span>{col.title}</span><span className="stk-n">{col.items.length}</span></header>
      <div className="stk-col-body">{children}</div>
    </section>
  );
}

/** Листок: ✓ готово, ⏭ перенос, 🗑 удалить, «…» — цвет, правка, задача. */
export function StickerNote({ s, showDate, today, selected, onDone, onRemove, onMove, onRecolor, onText, onTask, onSelect, compact }: CardProps & { s: Sticker; showDate?: boolean; compact?: boolean }) {
  const [menu, setMenuState] = useState<'move' | 'more' | null>(null);
  /** #5032: меню — порталом в body по координатам кнопки: листки повёрнуты (transform), и меню
   *  уходило под соседние стикеры и обрезалось прокруткой доски. */
  const [menuAt, setMenuAt] = useState<{ top: number; right: number; up: boolean } | null>(null);
  const setMenu = (m: 'move' | 'more' | null, btn?: HTMLElement | null) => {
    if (m && btn) {
      const r = btn.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < 300 && r.top > 300;
      setMenuAt({ top: up ? r.top - 4 : r.bottom + 4, right: Math.max(8, window.innerWidth - r.right), up });
    }
    setMenuState(m);
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.text);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const pickRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.stk-menu, .st-act')) setMenu(null); };
    const onScroll = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.stk-menu')) setMenu(null); };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); };
  }, [menu]);
  const menuStyle: React.CSSProperties | undefined = menuAt
    ? { position: 'fixed', right: menuAt.right, ...(menuAt.up ? { top: 'auto', bottom: window.innerHeight - menuAt.top } : { top: menuAt.top }), margin: 0, zIndex: 80 }
    : undefined;
  const portal = (el: React.ReactNode) => createPortal(el, document.body);
  const later = (date: string | null, time?: string | null) => { setMenu(null); onMove(s, date, time); };
  const overdue = !!s.date && s.date < today;
  return (
    <div className={`st-note st-${s.color}${leaving ? ' is-done' : ''}${selected.has(s.id) ? ' is-sel' : ''}${compact ? ' is-compact' : ''}`}
      style={{ ['--st-tilt' as string]: tilt(s.id) }} draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.setData('text/sticker', s.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={(e) => { if (e.shiftKey) { e.preventDefault(); onSelect(s); } }}
      onDoubleClick={() => { setDraft(s.text); setEditing(true); }}>
      {editing ? (
        <textarea className="st-edit" value={draft} autoFocus rows={3} onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== s.text) onText(s, draft.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === 'Escape') { setDraft(s.text); setEditing(false); } }} />
      ) : <div className="st-note-text">{s.text}</div>}
      {s.body && open && <div className="st-note-body">{s.body}</div>}
      <div className="st-note-meta">
        {(overdue || s.reminded) && <span className="stk-red-dot" title={s.reminded ? 'Напомнил — ещё не закрыт' : 'Просрочено'} />}
        {showDate && s.date && <span>{dayLabel(s.date)}</span>}
        {s.time && <span>{s.time}</span>}
        {s.body && <button className="st-link" onClick={() => setOpen((v) => !v)}>{open ? 'свернуть' : 'развернуть'}</button>}
        {s.sourceRef?.chatId && <button className="st-link" onClick={() => navigate({ section: 'chat', chatId: String(s.sourceRef!.chatId) })}>открыть сообщение</button>}
        {s.taskId && <span title="Сделана задача">→ #{s.taskId}</span>}
      </div>
      <div className="st-note-acts">
        <button className="st-act" title="Готово" aria-label="Готово" onClick={() => { setLeaving(true); window.setTimeout(() => onDone(s), 600); }}><Icon name="check" size={13} /></button>
        <button className="st-act" title="Перенести" aria-label="Перенести" onClick={(e) => setMenu(menu === 'move' ? null : 'move', e.currentTarget)}><Icon name="chevron-right" size={13} /></button>
        <button className="st-act" title="Удалить" aria-label="Удалить" onClick={() => onRemove(s)}><Icon name="trash" size={13} /></button>
        <button className="st-act" title="Ещё" aria-label="Ещё" onClick={(e) => setMenu(menu === 'more' ? null : 'more', e.currentTarget)}><Icon name="more" size={13} /></button>
      </div>
      {/* шаг 6.1: напомнил, а стикер не закрыт — отложить одним нажатием */}
      {s.reminded && !compact && (
        <div className="st-note-meta">
          <button className="st-link" onClick={() => void stickersApi.snooze(s.id, 15).then(stickersChanged)}>через 15 мин</button>
          <button className="st-link" onClick={() => void stickersApi.snooze(s.id, 60).then(stickersChanged)}>через час</button>
          <button className="st-link" onClick={() => onMove(s, addDays(today, 1))}>завтра</button>
        </div>
      )}
      {menu === 'move' && portal(
        <div className="stk-menu" role="menu" style={menuStyle}>
          <button onClick={() => later(today, nowHm(60))}>Через час <span className="dim">{nowHm(60)}</span></button>
          <button onClick={() => later(today, '18:00')}>Вечером <span className="dim">18:00</span></button>
          <button onClick={() => later(addDays(today, 1))}>Завтра <span className="dim">{dayLabel(addDays(today, 1))}</span></button>
          <button onClick={() => later(nextWeekday(today, 1))}>В понедельник <span className="dim">{dayMonth(nextWeekday(today, 1))}</span></button>
          <button onClick={() => later(addDays(today, 7))}>Через неделю <span className="dim">{dayMonth(addDays(today, 7))}</span></button>
          <label className="stk-menu-pick">Выбрать дату… <Icon name="calendar" size={13} />
            <input ref={pickRef} type="date" min={today} onChange={(e) => { if (e.target.value) later(e.target.value); }} aria-label="Выбрать дату" />
          </label>
          <button className="stk-menu-sep" onClick={() => later(null, null)}>Без даты <span className="dim">→ Идеи</span></button>
        </div>
      )}
      {menu === 'more' && portal(
        <div className="stk-menu" role="menu" style={menuStyle}>
          <div className="stk-menu-colors">
            {STICKER_COLORS.map((c) => <button key={c} className={`qs-dot st-${c}${s.color === c ? ' is-on' : ''}`} aria-label={`Цвет ${c}`} onClick={() => { setMenu(null); onRecolor(s, c); }} />)}
          </div>
          <button onClick={() => { setMenu(null); setDraft(s.text); setEditing(true); }}><Icon name="edit" size={13} /> Изменить текст</button>
          <button onClick={() => { setMenu(null); onTask(s); }}><Icon name="check-circle" size={13} /> Сделать задачей</button>
          {/* #5032: событие в календарь — всегда; нет времени у стикера — время выберут в окне */}
          <button onClick={() => { setMenu(null); onTask({ ...s, source: 'calendar' }); }}><Icon name="calendar" size={13} /> Перенести событие в календарь</button>
        </div>
      )}
    </div>
  );
}

function ColorLegend({ colors, only, onOnly, onRename, onClose }: {
  colors: StickerBoard['colors']; only: StickerColor | null; onOnly: (c: StickerColor | null) => void;
  onRename: (names: Record<string, string>) => void; onClose: () => void;
}) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(colors.map((c) => [c.key, c.name])));
  return (
    <div className="stk-legend" role="dialog" aria-label="Цвета">
      {colors.map((c) => (
        <div key={c.key} className="stk-legend-row">
          <button className={`qs-dot st-${c.key}${only === c.key ? ' is-on' : ''}`} onClick={() => onOnly(only === c.key ? null : c.key)} title="Показать только этот цвет" aria-label={`Только ${c.name}`} />
          <input className="ui-input ui-input-sm" value={names[c.key] ?? ''} maxLength={40} onChange={(e) => setNames((n) => ({ ...n, [c.key]: e.target.value }))} aria-label={`Название цвета ${c.name}`} />
        </div>
      ))}
      <div className="stk-legend-foot">
        {only && <Button size="sm" variant="ghost" onClick={() => onOnly(null)}>Все цвета</Button>}
        <Button size="sm" variant="primary" onClick={() => { onRename(names); onClose(); }}>Сохранить названия</Button>
      </div>
    </div>
  );
}

/** Режим «Месяц» (шаг 3.3): в дне до трёх мини-стикеров, дальше «+N ещё»; клик по дню — все его стикеры. */
function MonthGrid({ items, today, onMove, card }: { items: Sticker[]; today: string; onMove: (s: Sticker, d: string | null) => void; card: CardProps }) {
  const [anchor, setAnchor] = useState(() => { const d = parseYmd(today); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [openDay, setOpenDay] = useState<string | null>(null);
  const start = new Date(anchor); start.setDate(1 - ((anchor.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return ymd(d); });
  const byDay = (d: string) => items.filter((s) => s.date === d);
  return (
    <div className="stk-month">
      <div className="stk-month-head">
        <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))} aria-label="Прошлый месяц"><Icon name="chevron-left" size={14} /></Button>
        <b>{anchor.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase())}</b>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))} aria-label="Следующий месяц"><Icon name="chevron-right" size={14} /></Button>
      </div>
      <div className="stk-mgrid">
        {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => <div key={w} className="stk-mwd dim">{w}</div>)}
        {cells.map((d) => {
          const list = byDay(d);
          const other = parseYmd(d).getMonth() !== anchor.getMonth();
          return (
            <div key={d} className={`stk-mcell${other ? ' is-other' : ''}${d === today ? ' is-today' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { const s = items.find((x) => x.id === e.dataTransfer.getData('text/sticker')); if (s) onMove(s, d); }}
              onClick={() => list.length && setOpenDay(d)}>
              <div className="stk-mnum">{parseYmd(d).getDate()}{d === today ? ' · сегодня' : ''}</div>
              {list.slice(0, 3).map((s) => (
                <div key={s.id} className={`stk-mini st-${s.color}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/sticker', s.id)}>
                  {s.time ? `${s.time} ` : ''}{s.text}
                </div>
              ))}
              {list.length > 3 && <div className="stk-more">+{list.length - 3} ещё</div>}
            </div>
          );
        })}
      </div>
      {openDay && (
        <div className="drawer-overlay" onClick={() => setOpenDay(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><h3>{dayLabel(openDay)}</h3><button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setOpenDay(null)} aria-label="Закрыть"><Icon name="close" /></button></div>
            <div className="stk-daylist">{byDay(openDay).map((s) => <StickerNote key={s.id} s={s} {...card} />)}</div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Телефон (пункт 9): полоска недели с точками, стикеры дня крупно, «Просрочено» и «Идеи» — свернутые. Жесты: вправо — готово, влево — перенос. */
function MobileRibbon({ cols, today, card, onOverdue }: { cols: Col[]; today: string; card: CardProps; onOverdue: () => void }) {
  const days = cols.filter((c) => c.kind === 'day');
  const [day, setDay] = useState(today);
  const [openOver, setOpenOver] = useState(false);
  const [openIdeas, setOpenIdeas] = useState(false);
  const cur = days.find((c) => c.date === day) ?? days[0];
  const overdue = cols.find((c) => c.kind === 'overdue');
  const ideas = cols.find((c) => c.kind === 'ideas');
  const later = cols.find((c) => c.kind === 'later');
  return (
    <div className="stk-mob">
      <div className="stk-week" role="tablist" aria-label="Дни недели">
        {days.map((c) => (
          <button key={c.key} role="tab" aria-selected={c.date === day} className={`stk-wd${c.date === day ? ' is-on' : ''}`} onClick={() => setDay(c.date!)}>
            <span>{weekdayShort(c.date!)}</span><b>{parseYmd(c.date!).getDate()}</b>
            <i className="stk-wd-dots">{c.items.slice(0, 4).map((s) => <em key={s.id} className={`st-${s.color}`} />)}</i>
          </button>
        ))}
      </div>
      <div className="stk-mob-title dim">{cur?.date === today ? 'Сегодня' : cur?.date ? dayLabel(cur.date) : ''}</div>
      <div className="stk-mob-list">
        {cur?.items.length ? cur.items.map((s) => <SwipeNote key={s.id} s={s} card={card} />) : <div className="dim">На этот день стикеров нет — «＋ Стикер» выше.</div>}
      </div>
      {overdue && (
        <section className="stk-fold">
          <button className="stk-fold-head stk-red" onClick={() => setOpenOver((v) => !v)}><Icon name={openOver ? 'chevron-down' : 'chevron-right'} size={13} /> Просрочено · {overdue.items.length}</button>
          {openOver && <>{overdue.items.map((s) => <SwipeNote key={s.id} s={s} card={card} showDate />)}<button className="stk-overdue-all" onClick={onOverdue}>Всё просроченное → на сегодня</button></>}
        </section>
      )}
      {later && later.items.length > 0 && (
        <section className="stk-fold"><div className="stk-fold-head dim">Позже · {later.items.length}</div>{later.items.map((s) => <SwipeNote key={s.id} s={s} card={card} showDate />)}</section>
      )}
      {ideas && (
        <section className="stk-fold">
          <button className="stk-fold-head" onClick={() => setOpenIdeas((v) => !v)}><Icon name={openIdeas ? 'chevron-down' : 'chevron-right'} size={13} /> Идеи без даты · {ideas.items.length}</button>
          {openIdeas && ideas.items.map((s) => <SwipeNote key={s.id} s={s} card={card} />)}
        </section>
      )}
      <button className="stk-fab" onClick={() => openQuickSticker()} aria-label="Новый стикер"><Icon name="plus" size={22} /></button>
    </div>
  );
}

/** Смахнуть вправо — «Готово», влево — полоска «Завтра · Пн · Через неделю · 📅». */
function SwipeNote({ s, card, showDate }: { s: Sticker; card: CardProps; showDate?: boolean }) {
  const [dx, setDx] = useState(0);
  const [strip, setStrip] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const today = card.today;
  return (
    <div className="stk-swipe">
      <div className={`stk-swipe-bg ${dx > 0 ? 'is-done' : 'is-move'}`}>{dx > 0 ? 'Готово' : 'Перенести'}</div>
      <div style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={(e) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchMove={(e) => { const st = start.current; if (!st) return; const x = e.touches[0].clientX - st.x; if (Math.abs(x) > Math.abs(e.touches[0].clientY - st.y)) setDx(Math.max(-140, Math.min(140, x))); }}
        onTouchEnd={() => { if (dx > 90) card.onDone(s); else if (dx < -90) setStrip(true); setDx(0); start.current = null; }}>
        <StickerNote s={s} showDate={showDate} {...card} />
      </div>
      {strip && (
        <div className="stk-strip">
          <button onClick={() => { setStrip(false); card.onMove(s, addDays(today, 1)); }}>Завтра</button>
          <button onClick={() => { setStrip(false); card.onMove(s, nextWeekday(today, 1)); }}>Пн</button>
          <button onClick={() => { setStrip(false); card.onMove(s, addDays(today, 7)); }}>Через неделю</button>
          <label>📅<input type="date" min={today} onChange={(e) => { if (e.target.value) { setStrip(false); card.onMove(s, e.target.value); } }} aria-label="Выбрать дату" /></label>
          <button className="dim" onClick={() => setStrip(false)}>✕</button>
        </div>
      )}
    </div>
  );
}

function Archive({ kind, onClose }: { kind: 'done' | 'trash'; onClose: () => void }) {
  const [list, setList] = useState<Sticker[] | null>(null);
  const load = useCallback(() => stickersApi.archive(kind).then(setList).catch(() => setList([])), [kind]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{kind === 'done' ? 'Сделано за 30 дней' : 'Корзина'}</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>
        </div>
        <p className="dim" style={{ fontSize: 13 }}>{kind === 'done' ? 'Выполненные стикеры хранятся 30 дней.' : 'Удалённые лежат здесь 30 дней, потом исчезают насовсем.'}</p>
        {!list ? <div className="dim">Загружаю…</div> : !list.length ? <div className="dim">Пусто.</div> : (
          <div className="stk-daylist">
            {list.map((s) => (
              <div key={s.id} className={`st-note st-${s.color}`} style={{ cursor: 'default' }}>
                <div style={kind === 'done' ? { textDecoration: 'line-through' } : undefined}>{s.text}</div>
                <div className="st-note-meta">
                  {s.date && <span>{dayLabel(s.date)}</span>}
                  <button className="st-link" onClick={() => void stickersApi.mark([s.id], kind === 'done' ? 'undone' : 'restore').then(load)}>
                    {kind === 'done' ? 'Вернуть на доску' : 'Восстановить'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

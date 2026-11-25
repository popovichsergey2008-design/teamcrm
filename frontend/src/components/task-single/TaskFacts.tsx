import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../Avatar';
import { DatePicker } from '../DatePicker';
import { Icon } from '../Icon';
import { initialsOf } from '../../lib/initials';
import type { Task, User } from '../../types';

/**
 * Карточка «главное» под заголовком задачи (#5016, ТЗ п. 2).
 *
 * Верхний ряд из пяти ячеек — исполнитель с соисполнителями, постановщик, срок, статус,
 * наблюдатели; нижняя строка мелким текстом — приоритет, проект, повтор, клиент.
 * Щелчок по ячейке открывает окошко прямо под ней (люди, календарь, статусы); по нижней
 * строке — нужную вкладку («Параметры», «Повтор»).
 */

export type FactPerson = { user_id: string; role: string; full_name: string };
type Pop = 'assignee' | 'co' | 'manager' | 'due' | 'status' | 'watch' | null;

const PRIORITY_WORD: Record<string, { text: string; cls: string }> = {
  urgent: { text: 'срочно', cls: 'ts-prio-urgent' },
  high: { text: 'высокий', cls: 'ts-prio-high' },
  normal: { text: 'обычный', cls: '' },
  low: { text: 'низкий', cls: 'ts-prio-low' },
};

const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const dayMonth = (d: Date) => d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
const dayNum = (d: Date) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
};

/** Срок словами, как на карточке доски: сегодня / завтра и позже / просрочено (ТЗ п. 2, a-3). */
export function dueView(value: string, closed: boolean, now = new Date()): { tone: 'none' | 'today' | 'future' | 'over'; main: string; sub: string } {
  if (!value) return { tone: 'none', main: 'не задан', sub: '' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { tone: 'none', main: 'не задан', sub: '' };
  const days = dayNum(d) - dayNum(now);
  const time = hm(d);
  if (!closed && d.getTime() < now.getTime()) {
    const late = Math.max(1, dayNum(now) - dayNum(d));
    const lateText = days === 0 ? `${Math.max(1, Math.round((now.getTime() - d.getTime()) / 3_600_000))} ч` : `${late} ${plural(late, 'день', 'дня', 'дней')}`;
    return { tone: 'over', main: `Просрочено ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`, sub: `на ${lateText} · было ${d.toLocaleDateString('ru-RU', { weekday: 'short' })}, ${time}` };
  }
  if (days === 0) {
    const left = Math.max(0, d.getTime() - now.getTime());
    const h = Math.floor(left / 3_600_000);
    const m = Math.round((left % 3_600_000) / 60_000);
    return { tone: 'today', main: `Сегодня, ${time}`, sub: `${dayMonth(d)}${closed ? '' : ` · осталось ${h ? `${h} ч` : `${m} мин`}`}` };
  }
  return { tone: 'future', main: `${dayMonth(d)}, ${time}`, sub: days === 1 ? 'завтра' : days > 1 ? `через ${days} дн.` : '' };
}

function Ava({ name, user, cls = 'ts-ava' }: { name: string; user?: User; cls?: string }) {
  return <Avatar path={user?.avatarUrl ?? null} fallback={initialsOf(name)} className={cls} />;
}

/** Выбор людей в окошке: один (исполнитель, постановщик) или несколько (соисполнители, наблюдатели). */
function PeoplePick({ users, picked, multi, onPick, onClose, extra }: {
  users: User[]; picked: string[]; multi: boolean; onPick: (id: string) => void; onClose: () => void; extra?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return users.filter((u) => !s || u.fullName.toLowerCase().includes(s));
  }, [users, q]);
  return (
    <>
      <input className="ui-input ui-input-sm ts-pop-search" autoFocus placeholder="Найти человека" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onPick(String(list[0].id)); if (!multi) onClose(); } }} aria-label="Найти человека" />
      {extra}
      <div className="ts-pop-list" role="listbox" aria-multiselectable={multi}>
        {list.map((u) => {
          const on = picked.includes(String(u.id));
          return (
            <button key={u.id} type="button" role="option" aria-selected={on} className={`ts-pop-item${on ? ' is-on' : ''}`}
              onClick={() => { onPick(String(u.id)); if (!multi) onClose(); }}>
              <Ava name={u.fullName} user={u} cls="ts-ava ts-ava-sm" />
              <span className="ts-pop-name">{u.fullName}</span>
              {on && <Icon name="check" size={14} />}
            </button>
          );
        })}
        {!list.length && <div className="ts-pop-empty">Никого не нашли</div>}
      </div>
    </>
  );
}

export function TaskFacts(p: {
  task: Task;
  users: User[];
  columns: { id: string; name: string }[];
  assigneeId: string; setAssigneeId: (v: string) => void;
  managerId: string; setManagerId: (v: string) => void;
  deadline: string; setDeadline: (v: string) => void;
  participants: FactPerson[];
  addPerson: (userId: string, role: 'co_assignee' | 'watcher') => void;
  removePerson: (userId: string, role: 'co_assignee' | 'watcher') => void;
  approval: boolean;
  moving: boolean;
  onStatus: (columnId: string) => void;
  priority: string;
  projectName: string;
  repeatLabel: string | null;
  clientName: string | null;
  showClient: boolean;
  onOpenTab: (tab: 'params' | 'repeat') => void;
  /** «Кому поручить» — совет ИИ в окошке исполнителя. */
  suggest?: ReactNode;
}) {
  const [pop, setPop] = useState<Pop>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // календарь DatePicker и всплывающие окна живут порталом — их щелчок окошко не закрывает
      if (box.current?.contains(t) || t.closest('.dp-pop, .dp-sheet, [role="dialog"], .ui-select-popup')) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [pop]);

  const byId = (id: string | null | undefined) => p.users.find((u) => String(u.id) === String(id ?? ''));
  const co = p.participants.filter((x) => x.role === 'co_assignee');
  const watch = p.participants.filter((x) => x.role === 'watcher');
  const assignee = byId(p.assigneeId);
  const manager = byId(p.managerId);
  const due = dueView(p.deadline, !!p.task.closed_at);
  const colIdx = p.columns.findIndex((c) => String(c.id) === String(p.task.column_id));
  const col = colIdx >= 0 ? p.columns[colIdx] : null;
  const prio = PRIORITY_WORD[p.priority] ?? PRIORITY_WORD.normal;
  const toggle = (which: Pop) => setPop((cur) => (cur === which ? null : which));
  const cellKey = (which: Pop) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(which); } };

  const stack = (list: FactPerson[], role: 'co_assignee' | 'watcher') => (
    <span className="ts-mini" title={list.map((x) => x.full_name).join(', ')}>
      {list.slice(0, 5).map((x) => (
        <button key={x.user_id} type="button" className="ts-mini-ava" title={`${x.full_name} — убрать`} aria-label={`Убрать ${x.full_name}`}
          onClick={(e) => { e.stopPropagation(); p.removePerson(String(x.user_id), role); }}>
          <Ava name={x.full_name} user={byId(x.user_id)} cls="ts-ava ts-ava-sm" />
        </button>
      ))}
      {list.length > 5 && <span className="ts-ava ts-ava-sm ts-ava-more">+{list.length - 5}</span>}
    </span>
  );
  const plus = (which: Pop, label: string) => (
    <button type="button" className="ts-plus" title={label} aria-label={label} aria-expanded={pop === which}
      onClick={(e) => { e.stopPropagation(); toggle(which); }}>+</button>
  );

  return (
    <section className="ts-card ts-facts" ref={box}>
      <div className="ts-facts-main">
        {/* Исполнитель + соисполнители */}
        <div className="ts-fact" role="button" tabIndex={0} aria-expanded={pop === 'assignee'} onClick={() => toggle('assignee')} onKeyDown={cellKey('assignee')}>
          <div className="ts-lbl">Исполнитель</div>
          <div className="ts-val">
            {assignee ? <><Ava name={assignee.fullName} user={assignee} /><span className="ts-ellipsis">{assignee.fullName}</span></> : <span className="ts-faint">не назначен</span>}
          </div>
          <div className="ts-co" onClick={(e) => e.stopPropagation()}>
            <span>Соисполнители:</span>
            {co.length > 0 && stack(co, 'co_assignee')}
            {plus('co', 'Добавить соисполнителя')}
          </div>
          {pop === 'assignee' && (
            <div className="ts-pop" onClick={(e) => e.stopPropagation()}>
              <PeoplePick users={p.users} picked={p.assigneeId ? [String(p.assigneeId)] : []} multi={false}
                onPick={(id) => p.setAssigneeId(id)} onClose={() => setPop(null)}
                extra={(
                  <div className="ts-pop-row">
                    {p.suggest}
                    {p.assigneeId && <button type="button" className="ts-link" onClick={() => { p.setAssigneeId(''); setPop(null); }}>Снять исполнителя</button>}
                  </div>
                )} />
            </div>
          )}
          {pop === 'co' && (
            <div className="ts-pop" onClick={(e) => e.stopPropagation()}>
              <div className="ts-pop-title">Соисполнители</div>
              <PeoplePick users={p.users} picked={co.map((x) => String(x.user_id))} multi
                onPick={(id) => (co.some((x) => String(x.user_id) === id) ? p.removePerson(id, 'co_assignee') : p.addPerson(id, 'co_assignee'))}
                onClose={() => setPop(null)} />
            </div>
          )}
        </div>

        {/* Постановщик */}
        <div className="ts-fact" role="button" tabIndex={0} aria-expanded={pop === 'manager'} onClick={() => toggle('manager')} onKeyDown={cellKey('manager')}>
          <div className="ts-lbl">Постановщик</div>
          <div className="ts-val">
            {manager ? <><Ava name={manager.fullName} user={manager} /><span className="ts-ellipsis">{manager.fullName}</span></> : <span className="ts-faint">не задан</span>}
          </div>
          {p.approval && <div className="ts-sub">согласует завершение</div>}
          {pop === 'manager' && (
            <div className="ts-pop" onClick={(e) => e.stopPropagation()}>
              <PeoplePick users={p.users} picked={p.managerId ? [String(p.managerId)] : []} multi={false} onPick={(id) => p.setManagerId(id)} onClose={() => setPop(null)} />
            </div>
          )}
        </div>

        {/* Срок */}
        <div className="ts-fact" role="button" tabIndex={0} aria-expanded={pop === 'due'} onClick={() => toggle('due')} onKeyDown={cellKey('due')}>
          <div className="ts-lbl">Срок</div>
          <div className="ts-val">
            <span className={`ts-due ts-due-${due.tone}`}>
              <Icon name="calendar" size={15} />
              <span>{due.main}</span>
            </span>
          </div>
          {due.sub && <div className="ts-sub ts-nowrap">{due.sub}</div>}
          {pop === 'due' && (
            <div className="ts-pop ts-pop-due" onClick={(e) => e.stopPropagation()}>
              <DatePicker value={p.deadline} onChange={p.setDeadline} withTime warnPast placeholder="срок не задан" ariaLabel="Срок задачи" />
              <div className="ts-pop-hint">Нажмите на поле — откроется календарь со временем</div>
            </div>
          )}
        </div>

        {/* Статус */}
        <div className="ts-fact" role="button" tabIndex={0} aria-expanded={pop === 'status'} onClick={() => toggle('status')} onKeyDown={cellKey('status')}>
          <div className="ts-lbl">Статус</div>
          <div className="ts-val">
            <span className="ts-status">{col?.name ?? '—'} <Icon name="chevron-down" size={13} /></span>
          </div>
          {colIdx >= 0 && <div className="ts-sub">этап {colIdx + 1} из {p.columns.length}</div>}
          {pop === 'status' && (
            <div className="ts-pop" onClick={(e) => e.stopPropagation()}>
              <div className="ts-pop-list" role="listbox">
                {p.columns.map((c, i) => {
                  const on = String(c.id) === String(p.task.column_id);
                  return (
                    <button key={c.id} type="button" role="option" aria-selected={on} disabled={p.moving} className={`ts-pop-item${on ? ' is-on' : ''}`}
                      onClick={() => { if (!on) p.onStatus(String(c.id)); setPop(null); }}>
                      <span className="ts-pop-num">{i + 1}</span><span className="ts-pop-name">{c.name}</span>{on && <Icon name="check" size={14} />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Наблюдатели */}
        <div className="ts-fact ts-watch" role="button" tabIndex={0} aria-expanded={pop === 'watch'} onClick={() => toggle('watch')} onKeyDown={cellKey('watch')}>
          <div className="ts-lbl">Наблюдатели · {watch.length}</div>
          <div className="ts-val" onClick={(e) => e.stopPropagation()}>
            {watch.length > 0 && stack(watch, 'watcher')}
            {plus('watch', 'Добавить наблюдателя')}
            {watch.length > 0
              ? <span className="ts-names">{watch.map((x) => x.full_name).join(', ')}</span>
              : <span className="ts-faint">нет</span>}
          </div>
          {pop === 'watch' && (
            <div className="ts-pop ts-pop-right" onClick={(e) => e.stopPropagation()}>
              <div className="ts-pop-title">Наблюдатели</div>
              <PeoplePick users={p.users} picked={watch.map((x) => String(x.user_id))} multi
                onPick={(id) => (watch.some((x) => String(x.user_id) === id) ? p.removePerson(id, 'watcher') : p.addPerson(id, 'watcher'))}
                onClose={() => setPop(null)} />
            </div>
          )}
        </div>
      </div>

      <div className="ts-facts-sec">
        <button type="button" onClick={() => p.onOpenTab('params')}>Приоритет: <span className={prio.cls}>{prio.text}</span></button>
        <button type="button" onClick={() => p.onOpenTab('params')}>Проект: <b>{p.projectName || '—'}</b></button>
        {p.repeatLabel && <button type="button" onClick={() => p.onOpenTab('repeat')}><Icon name="refresh" size={12} /> <b>{p.repeatLabel}</b></button>}
        {p.showClient && <button type="button" onClick={() => p.onOpenTab('params')}>Клиент: {p.clientName ? <b>{p.clientName}</b> : <span className="ts-faint">не указан</span>}</button>}
      </div>
    </section>
  );
}

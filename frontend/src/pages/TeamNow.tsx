import { memo, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/ui/button';
import { promptText } from '../components/ui/dialog';
import { api, ApiError, TeamPresence } from '../lib/api';
import { getSocket } from '../lib/socket';
import { initialsOf } from '../lib/initials';
import { navigate } from '../lib/router';
import { toastSaved } from '../lib/notifications';
import { focusApi } from './focus/focus-api';

type Status = TeamPresence['status'];

/** Группы (п. 66): сначала тех, кого лучше не трогать; «не в сети» — свёрнуто. */
// #4891, п. 9: компактно — сразу видны те, кого лучше не трогать; остальные — по «Ещё»
const GROUPS: { status: Status[]; title: string; main?: boolean }[] = [
  { status: ['deep_focus'], title: 'В фокусе', main: true },
  { status: ['in_meeting'], title: 'На созвоне', main: true },
  { status: ['do_not_disturb'], title: 'Не беспокоить', main: true },
  { status: ['available'], title: 'Доступны' },
  { status: ['break'], title: 'На перерыве' },
  { status: ['workday_closed'], title: 'Не в сети · завершили день' },
];

const hm = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function line(p: TeamPresence): string {
  switch (p.status) {
    case 'deep_focus': {
      // #4787, п. 12: «В фокусе до 15:20 · Работаю над задачами №1326 и №1350» — номера
      // только тем, кому задачи видны (сервер присылает лишь их); остальным — «В фокусе»
      // #4782, п. 3: тот же вид, что у самого человека: «Глубокий фокус · до 15:20 · #1326, #1476»
      const tasks = p.focusTasks ?? [];
      const what = tasks.length ? ` · ${tasks.map((t) => `#${t.id}`).join(', ')}` : '';
      return p.until ? `Глубокий фокус · до ${hm(p.until)}${what}` : `Глубокий фокус${what}`;
    }
    case 'in_meeting': return p.note ? `На созвоне · ${p.note}` : 'На созвоне';
    case 'do_not_disturb': return 'Не беспокоить';
    case 'break': return p.until ? `Перерыв до ${hm(p.until)}` : 'Перерыв';
    case 'workday_closed': return 'Не в сети · день завершён';
    case 'available': return p.taskTitle ? `Работает: ${p.taskTitle}` : p.note ? p.note : 'На месте';
    default: return 'Не в сети';
  }
}

const Row = memo(function Row({ p, me, open, onToggle, link }: { p: TeamPresence; me: boolean; open: boolean; onToggle: () => void; link?: number }) {
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    try { const dm = await api.openDm(p.userId); navigate({ section: 'chat', chatId: String(dm.id) }); } finally { setBusy(false); }
  };
  const knock = async () => {
    const reason = await promptText({ title: `Постучать: ${p.fullName}`, placeholder: 'Что случилось — без причины не отправится', confirmLabel: 'Постучать', singleLine: true });
    if (reason === null) return;
    if (!reason.trim()) { toastSaved('Напишите причину', 'Срочное обращение отправляется только с причиной'); return; }
    setBusy(true);
    try { await api.knock(p.userId, reason || undefined); toastSaved('Постучали'); }
    catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
    finally { setBusy(false); }
  };
  return (
    <li className={`tn-row tn-${p.status}`}>
      <button type="button" className="tn-person" aria-expanded={open} onClick={onToggle}>
        <span className="tn-ava">
          <Avatar path={p.avatarUrl} fallback={initialsOf(p.fullName)} className="avatar-sm" />
          <span className="tn-dot" aria-hidden="true" />
        </span>
        <span className="tn-text">
          <span className="tn-name">{p.fullName}{me ? ' (вы)' : ''}</span>
          <span className="tn-line">{line(p)}</span>
          {/* что связывает вас сейчас (#4891, п. 9) */}
          {!!link && <span className="tn-link">ждёт вашей проверки{link > 1 ? ` · ${link}` : ''}</span>}
        </span>
      </button>
      {open && !me && (
        <div className="tn-pop">
          {p.until && p.status !== 'available' && <span className="dim">до {hm(p.until)}</span>}
          {p.taskTitle && p.status !== 'available' && <span className="dim">над задачей: {p.taskTitle}</span>}
          <span className="tn-acts">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void write()}><Icon name="chat" size={13} /> Написать</Button>
            {p.status === 'deep_focus' && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void knock()}><Icon name="hand" size={13} /> Постучать срочно</Button>
            )}
          </span>
        </div>
      )}
    </li>
  );
});

/**
 * «Команда сейчас» (ТЗ-16, п. 61–68): кто свободен, кто в фокусе, кто на созвоне —
 * чтобы не писать «ты свободен?». Не мониторинг: только то, что человек поставил сам,
 * и то, что видно и так. Название чужой задачи — только если её проект вам виден.
 *
 * Событие `presence.updated` меняет одну строку, а не весь экран (п. 116).
 */
export function TeamNow({ meId, onOpenPulse }: { meId: string | undefined; onOpenPulse?: () => void }) {
  const [people, setPeople] = useState<TeamPresence[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [links, setLinks] = useState<Record<string, { waitingMyReview: number }>>({});
  useEffect(() => { void focusApi.teamLinks().then(setLinks).catch(() => undefined); }, []);

  useEffect(() => {
    let alive = true;
    api.teamPulse()
      .then((r) => { if (alive) setPeople(r); })
      .catch((e) => { if (alive && e instanceof ApiError && e.code === 'FORBIDDEN') setDenied(true); else if (alive) setPeople([]); });
    const socket = getSocket();
    const onUpdate = (u: TeamPresence) => {
      setPeople((list) => list && list.map((p) => (p.userId === String(u.userId)
        // в рассылке нет названия задачи — его держим прежним, пока задача та же
        ? { ...p, ...u, taskTitle: u.taskId && u.taskId === p.taskId ? p.taskTitle : null }
        : p)));
    };
    socket.on('presence.updated', onUpdate);
    // «ещё 28 мин» пересчитываем раз в минуту
    const t = window.setInterval(() => setPeople((l) => (l ? [...l] : l)), 60_000);
    return () => { alive = false; socket.off('presence.updated', onUpdate); window.clearInterval(t); };
  }, []);

  if (denied) return null;
  if (!people) return null;
  const others = people.filter((p) => p.status !== 'offline');
  const offline = people.filter((p) => p.status === 'offline');
  if (people.length <= 1) return null; // один в компании — показывать некого

  return (
    <section className="tn" aria-label="Команда сейчас">
      <h3 className="tn-head">
        <Icon name="users" size={15} /> Команда сейчас
        {/* руководителю — переход в полный «Пульс команды» (ТЗ-27, п. 37) */}
        {onOpenPulse && <Button variant="ghost" size="sm" className="tn-pulse" onClick={onOpenPulse}>Открыть Пульс команды</Button>}
      </h3>
      {GROUPS.map((g) => {
        const list = others.filter((p) => g.status.includes(p.status) && (g.main || showRest || links[p.userId]));
        if (!list.length) return null;
        return (
          <div key={g.title} className="tn-group">
            <div className="tn-group-title">{g.title} · {list.length}</div>
            <ul className="tn-list">
              {list.map((p) => (
                <Row key={p.userId} p={p} me={p.userId === String(meId)} open={openId === p.userId} link={links[p.userId]?.waitingMyReview}
                  onToggle={() => setOpenId((v) => (v === p.userId ? null : p.userId))} />
              ))}
            </ul>
          </div>
        );
      })}
      {(() => {
        const rest = others.filter((p) => !GROUPS.some((g) => g.main && g.status.includes(p.status)) && !links[p.userId]).length;
        return rest > 0 ? (
          <button type="button" className="tn-more" aria-expanded={showRest} onClick={() => setShowRest((v) => !v)}>
            {showRest ? 'Свернуть' : `Ещё ${rest}: доступны, на перерыве, завершили день`} <Icon name={showRest ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
        ) : null;
      })()}
      {offline.length > 0 && showRest && (
        <button type="button" className="tn-more" aria-expanded={showOffline} onClick={() => setShowOffline((v) => !v)}>
          Не в сети · {offline.length} <Icon name={showOffline ? 'chevron-up' : 'chevron-down'} size={13} />
        </button>
      )}
      {showOffline && (
        <ul className="tn-list">
          {offline.map((p) => (
            <Row key={p.userId} p={p} me={p.userId === String(meId)} open={openId === p.userId}
              onToggle={() => setOpenId((v) => (v === p.userId ? null : p.userId))} />
          ))}
        </ul>
      )}
    </section>
  );
}

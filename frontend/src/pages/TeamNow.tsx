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

type Status = TeamPresence['status'];

/** Группы (п. 66): сначала тех, кого лучше не трогать; «не в сети» — свёрнуто. */
const GROUPS: { status: Status[]; title: string }[] = [
  { status: ['deep_focus'], title: 'В глубоком фокусе' },
  { status: ['in_meeting'], title: 'На созвоне' },
  { status: ['do_not_disturb'], title: 'Просили не беспокоить' },
  { status: ['available'], title: 'Доступны' },
  { status: ['break'], title: 'На перерыве' },
  { status: ['workday_closed'], title: 'Завершили день' },
];

const hm = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function line(p: TeamPresence): string {
  switch (p.status) {
    case 'deep_focus': {
      if (!p.until) return 'Глубокий фокус';
      const left = Math.max(0, Math.round((new Date(p.until).getTime() - Date.now()) / 60_000));
      return `Глубокий фокус · ещё ${left} мин`;
    }
    case 'in_meeting': return p.note ? `На созвоне · ${p.note}` : 'На созвоне';
    case 'do_not_disturb': return 'Не беспокоить';
    case 'break': return p.until ? `Перерыв до ${hm(p.until)}` : 'Перерыв';
    case 'workday_closed': return 'День завершён';
    case 'available': return p.taskTitle ? `Работает: ${p.taskTitle}` : p.note ? p.note : 'Доступен(на)';
    default: return 'Не в сети';
  }
}

const Row = memo(function Row({ p, me, open, onToggle }: { p: TeamPresence; me: boolean; open: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    try { const dm = await api.openDm(p.userId); navigate({ section: 'chat', chatId: String(dm.id) }); } finally { setBusy(false); }
  };
  const knock = async () => {
    const reason = await promptText({ title: `Постучать: ${p.fullName}`, placeholder: 'Что случилось (можно пусто)', confirmLabel: 'Постучать', singleLine: true });
    if (reason === null) return;
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
export function TeamNow({ meId }: { meId: string | undefined }) {
  const [people, setPeople] = useState<TeamPresence[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);

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
      <h3 className="tn-head"><Icon name="users" size={15} /> Команда сейчас</h3>
      {GROUPS.map((g) => {
        const list = others.filter((p) => g.status.includes(p.status));
        if (!list.length) return null;
        return (
          <div key={g.title} className="tn-group">
            <div className="tn-group-title">{g.title} · {list.length}</div>
            <ul className="tn-list">
              {list.map((p) => (
                <Row key={p.userId} p={p} me={p.userId === String(meId)} open={openId === p.userId}
                  onToggle={() => setOpenId((v) => (v === p.userId ? null : p.userId))} />
              ))}
            </ul>
          </div>
        );
      })}
      {offline.length > 0 && (
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

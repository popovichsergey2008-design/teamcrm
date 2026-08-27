import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

interface Person {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
}

/**
 * «Пригласить сотрудника» — прямо из идущего созвона.
 *
 * Раньше состав собирали ДО звонка, в панели: приходилось заранее знать, кто нужен,
 * а на деле это выясняется по ходу разговора — «позови ещё Петра, он в курсе».
 * Поэтому кнопка живёт здесь, в шапке созвона, рядом со ссылкой для внешнего гостя:
 * два способа позвать человека стоят вместе.
 *
 * Уже присутствующих в списке нет — звать того, кто и так на связи, не нужно.
 */
export function CallInvite({ present, onInvite }: {
  /** Кто уже в комнате: их не показываем. */
  present: string[];
  onInvite: (userIds: string[]) => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  // Список тянем при открытии: во время разговора лишние запросы не нужны.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    api.listUsers()
      .then((team: any[]) => {
        if (!alive) return;
        const me = String(user?.id ?? '');
        setPeople(team
          .filter((u) => u.role !== 'client' && u.isActive !== false && String(u.id) !== me)
          .map((u) => ({ userId: String(u.id), fullName: u.fullName, avatarUrl: u.avatarUrl ?? null }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')));
      })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, user?.id]);

  const shown = useMemo(() => {
    const inRoom = new Set(present.map(String));
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => !inRoom.has(p.userId))
      .filter((p) => !q || p.fullName.toLowerCase().includes(q));
  }, [people, present, query]);

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const send = () => {
    if (!chosen.size) return;
    onInvite([...chosen]);
    setNote(`Позвали: ${chosen.size}. Им сейчас звонит телефон.`);
    setChosen(new Set());
    setOpen(false);
    setTimeout(() => setNote(''), 4000);
  };

  return (
    <span className="call-invite" ref={boxRef}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Позвать сотрудника в этот созвон"
      >
        <Icon name="user-plus" size={15} /> Пригласить сотрудника
      </button>

      {note && <span className="dim call-invite-note">{note}</span>}

      {open && (
        <div className="call-invite-pop" role="dialog" aria-label="Кого позвать в созвон">
          <div className="call-starter-head">Кого зовём</div>

          {people.length > 7 && (
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти человека"
              autoFocus
            />
          )}

          {loading && <div className="dim">Загружаю команду…</div>}
          {!loading && shown.length === 0 && (
            <div className="dim">Звать больше некого — вся команда уже на связи.</div>
          )}

          <div className="call-starter-list">
            {shown.map((p) => (
              <label key={p.userId} className="call-starter-row">
                <input type="checkbox" checked={chosen.has(p.userId)} onChange={() => toggle(p.userId)} />
                <Avatar path={p.avatarUrl} fallback={p.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                <span className="call-starter-name">{p.fullName}</span>
              </label>
            ))}
          </div>

          <button className="btn btn-primary btn-sm call-starter-go" onClick={send} disabled={!chosen.size}>
            <Icon name="phone" size={14} /> Позвать{chosen.size > 0 ? ` · ${chosen.size}` : ''}
          </button>
        </div>
      )}
    </span>
  );
}

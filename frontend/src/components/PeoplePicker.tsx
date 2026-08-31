import { useEffect, useMemo, useState } from 'react';
import { Avatar } from './Avatar';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

export interface Person {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
}

/**
 * Выбор людей для разговора — один на все места, где зовут в созвон.
 *
 * Мест таких три: кнопка в панели, кнопка в шапке чатов и приглашение внутрь идущего
 * созвона. Раньше каждое решало задачу по-своему, и «выбрать Юрия» выглядело в них
 * по-разному — а это одно и то же действие, и человек справедливо ждёт одинакового
 * поведения. Поле поиска появляется, только когда людей много: над списком из четырёх
 * человек оно выглядит издевательством.
 */
export function PeoplePicker({ exclude = [], chosen, onToggle, emptyHint }: {
  /** Кого не показывать: себя и тех, кто уже в комнате. */
  exclude?: string[];
  chosen: Set<string>;
  onToggle: (userId: string) => void;
  emptyHint?: string;
}) {
  const { user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.listUsers()
      .then((team: any[]) => {
        if (!alive) return;
        const me = String(user?.id ?? '');
        setPeople(team
          // Клиентам и уволенным звонить нельзя: первым не положено, вторые не ответят.
          .filter((u) => u.role !== 'client' && u.isActive !== false && String(u.id) !== me)
          .map((u) => ({ userId: String(u.id), fullName: u.fullName, avatarUrl: u.avatarUrl ?? null }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')));
      })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user?.id]);

  const shown = useMemo(() => {
    const hidden = new Set(exclude.map(String));
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => !hidden.has(p.userId))
      .filter((p) => !q || p.fullName.toLowerCase().includes(q));
  }, [people, exclude, query]);

  return (
    <>
      {people.length > 7 && (
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти сотрудника"
          aria-label="Поиск сотрудника"
        />
      )}

      {loading && <div className="dim">Загружаю команду…</div>}
      {!loading && shown.length === 0 && (
        <div className="dim">{emptyHint ?? 'Звать больше некого.'}</div>
      )}

      <div className="call-starter-list">
        {shown.map((p) => (
          <label key={p.userId} className="call-starter-row">
            <input type="checkbox" checked={chosen.has(p.userId)} onChange={() => onToggle(p.userId)} />
            <Avatar path={p.avatarUrl} fallback={p.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
            <span className="call-starter-name">{p.fullName}</span>
          </label>
        ))}
      </div>
    </>
  );
}

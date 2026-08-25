import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

interface Person {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  /** Уже в этом чате — такие идут первыми и отмечены по умолчанию. */
  inChat: boolean;
}

/**
 * Кнопка «Созвон» с выбором участников.
 *
 * Показывает ВСЮ команду, а не только тех, кто в чате: созвон часто начинают из
 * переписки с одним человеком, а позвать нужно троих — раньше для этого приходилось
 * заводить отдельную группу. Собеседники текущего чата стоят первыми и отмечены,
 * остальных добавляют галочкой; снять можно любого — созвон на десять человек ради
 * вопроса к двоим остаётся худшим, что можно сделать с чужим временем.
 *
 * Запись с ИИ живёт здесь же: это решение принимается один раз, до начала разговора.
 */
export function CallStarter({ chatId, kind, peerId, disabled, onStart }: {
  chatId: string;
  kind: string;
  /** собеседник личного диалога — его зовём по умолчанию */
  peerId: string | null;
  disabled: boolean;
  onStart: (opts: { memberIds: string[]; withAi: boolean }) => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [withAi, setWithAi] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // Список тянем при открытии, а не заранее: в чат заходят чаще, чем звонят.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    (async () => {
      const [team, inChat] = await Promise.all([
        api.listUsers().catch(() => []),
        kind === 'dm'
          ? Promise.resolve(peerId ? [String(peerId)] : [])
          : api.chatMembers(chatId).then((r) => r.members.map((m: any) => String(m.userId))).catch(() => []),
      ]);
      if (!alive) return;

      const me = String(user?.id ?? '');
      const members = new Set(inChat.map(String));
      const list: Person[] = (team as any[])
        // клиенту командные созвоны недоступны, уволенных звать незачем, себя звать не нужно
        .filter((u) => u.role !== 'client' && u.isActive !== false && String(u.id) !== me)
        .map((u) => ({
          userId: String(u.id),
          fullName: u.fullName,
          avatarUrl: u.avatarUrl ?? null,
          inChat: members.has(String(u.id)),
        }))
        .sort((a, b) => Number(b.inChat) - Number(a.inChat) || a.fullName.localeCompare(b.fullName, 'ru'));

      setPeople(list);
      setChosen(new Set(list.filter((p) => p.inChat).map((p) => p.userId)));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [open, chatId, kind, peerId, user?.id]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? people.filter((p) => p.fullName.toLowerCase().includes(q)) : people;
  }, [people, query]);

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const start = () => {
    setOpen(false);
    onStart({ memberIds: [...chosen], withAi });
  };

  return (
    <span className="call-starter" ref={boxRef}>
      <button
        className="btn btn-sm"
        disabled={disabled}
        title={disabled ? 'Вы уже в созвоне' : 'Созвон: выбрать участников и начать'}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="user-plus" size={15} /> Созвон
      </button>

      {open && (
        <div className="call-starter-pop" role="dialog" aria-label="Кого позвать на созвон">
          <div className="call-starter-head">Кого зовём</div>

          {/* Поиск появляется, когда список перестаёт помещаться в глаз целиком */}
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
          {!loading && people.length === 0 && (
            <div className="dim">В организации пока только вы. Созвон можно начать и одному — потом позовёте.</div>
          )}
          {!loading && people.length > 0 && shown.length === 0 && <div className="dim">Никого не нашлось.</div>}

          <div className="call-starter-list">
            {shown.map((p) => (
              <label key={p.userId} className="call-starter-row">
                <input type="checkbox" checked={chosen.has(p.userId)} onChange={() => toggle(p.userId)} />
                <Avatar path={p.avatarUrl} fallback={p.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                <span className="call-starter-name">{p.fullName}</span>
                {p.inChat && <span className="call-starter-mark" title="Участник этого чата">в чате</span>}
              </label>
            ))}
          </div>

          <label className="call-starter-ai" title="ИИ войдёт в созвон, запишет его и предложит задачи по итогам">
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            <Icon name="robot" size={14} /> Записать с ИИ — стенограмма и задачи по итогам
          </label>

          <button className="btn btn-primary btn-sm call-starter-go" onClick={start}>
            <Icon name="phone" size={14} /> Начать созвон{chosen.size > 0 ? ` · ${chosen.size}` : ''}
          </button>
        </div>
      )}
    </span>
  );
}

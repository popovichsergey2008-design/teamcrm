import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';

/**
 * Кнопка «Созвон» с выбором участников.
 *
 * Раньше кнопка называлась «Позвонить» и в групповом чате не звала никого: приглашение
 * уходило только собеседнику личного диалога, а остальные узнавали о созвоне из баннера
 * «идёт созвон» — если замечали его. Теперь перед началом видно, кого зовём, и любого
 * можно снять: созвон на десять человек ради вопроса к двоим — худшее, что можно сделать
 * с чужим временем.
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
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ userId: string; fullName: string }[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
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
    if (kind === 'dm') {
      const list = peerId ? [{ userId: String(peerId), fullName: 'Собеседник' }] : [];
      setPeople(list);
      setChosen(new Set(list.map((p) => p.userId)));
      return;
    }
    setLoading(true);
    api.chatMembers(chatId)
      .then((r) => {
        setPeople(r.members);
        setChosen(new Set(r.members.map((m) => String(m.userId))));
      })
      .catch(() => setPeople([]))
      .finally(() => setLoading(false));
  }, [open, chatId, kind, peerId]);

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

          {loading && <div className="dim">Загружаю участников…</div>}
          {!loading && people.length === 0 && (
            <div className="dim">Некого звать — в чате пока только вы. Созвон можно начать и одному.</div>
          )}

          <div className="call-starter-list">
            {people.map((p) => (
              <label key={p.userId} className="call-starter-row">
                <input type="checkbox" checked={chosen.has(String(p.userId))} onChange={() => toggle(String(p.userId))} />
                <span className="avatar-xs avatar-ph">{p.fullName?.[0]?.toUpperCase() ?? '?'}</span>
                {p.fullName}
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

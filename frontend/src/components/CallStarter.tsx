import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { GuestLinkButton } from './GuestLinkButton';
import { PeoplePicker } from './PeoplePicker';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

/**
 * Начать созвон: кнопка «Созвон» и рядом «человек +».
 *
 * Две кнопки — два разных намерения, и путать их не надо. «Созвон» из открытого чата
 * зовёт собеседников сразу: это самый частый случай, и лишний выбор здесь только
 * мешает. «Человек +» открывает состав — им пользуются, когда нужного человека
 * в этом чате нет или разговор вообще начинают не из переписки.
 *
 * Состав людей и приглашение внешнего участника живут в общих компонентах: в системе
 * есть три места, откуда зовут в разговор, и выглядеть они должны одинаково.
 */
export function CallStarter({ chatId, kind, peerId, disabled, onStart }: {
  /** Чат, из которого звонят. Пусто — звонок из панели, вне переписки. */
  chatId?: string | null;
  kind?: string;
  /** собеседник личного диалога — его зовём по умолчанию */
  peerId?: string | null;
  disabled: boolean;
  onStart: (opts: { memberIds: string[]; withAi: boolean }) => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Отметить или снять сразу всех: на планёрку зовут команду, а не по одному. */
  const setAll = (ids: string[], selected: boolean) => setChosen((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
    return next;
  });

  /** Кого зовём из чата: собеседника диалога или участников группы. */
  const membersOfChat = async (): Promise<string[]> => {
    if (!chatId) return [];
    if (kind === 'dm') return peerId ? [String(peerId)] : [];
    return api.chatMembers(chatId)
      .then((r) => r.members
        .map((m: { userId: string | number }) => String(m.userId))
        .filter((id: string) => id !== String(user?.id ?? '')))
      .catch(() => [] as string[]);
  };

  const start = async () => {
    if (disabled) return;
    // Выбрали людей руками — зовём их. Иначе берём состав чата; вне чата спрашиваем,
    // кого звать: созвон с самим собой не начинают.
    if (chosen.size) {
      onStart({ memberIds: [...chosen], withAi: false });
      setChosen(new Set());
      setOpen(false);
      return;
    }
    const fromChat = await membersOfChat();
    if (fromChat.length) return onStart({ memberIds: fromChat, withAi: false });
    setOpen(true);
  };

  return (
    <span className="call-starter" ref={boxRef}>
      <button
        className="btn btn-sm call-starter-add"
        disabled={disabled}
        title="Выбрать, кого позвать в созвон"
        aria-label="Выбрать участников"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="user-plus" size={15} />
        {chosen.size > 0 && <span className="view-count">{chosen.size}</span>}
      </button>
      <button
        className="btn btn-sm call-starter-call"
        disabled={disabled}
        title={disabled ? 'Вы уже в созвоне' : 'Начать созвон'}
        onClick={start}
      >
        <Icon name="phone" size={15} /> Созвон
      </button>

      {open && (
        <div className="call-starter-pop" role="dialog" aria-label="Кого позвать в созвон">
          <div className="call-starter-head">Кого зовём</div>

          {/* Внешний участник — здесь же: «позвать клиента» и «позвать коллегу» это
              один вопрос, и разводить их по разным углам интерфейса незачем. */}
          <div className="call-starter-guest">
            <GuestLinkButton chatId={chatId ?? null} compact />
          </div>

          <PeoplePicker
            chosen={chosen}
            onToggle={toggle}
            onSetAll={setAll}
            emptyHint="В организации пока некого звать."
          />

          <button
            className="btn btn-primary btn-sm call-starter-go"
            onClick={start}
            disabled={disabled || chosen.size === 0}
          >
            <Icon name="phone" size={14} /> Начать созвон{chosen.size > 0 ? ` · ${chosen.size}` : ''}
          </button>
        </div>
      )}
    </span>
  );
}

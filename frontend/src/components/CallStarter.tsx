import { Icon } from './Icon';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

/**
 * Кнопка «Созвон».
 *
 * Одно действие — начать разговор. Состав раньше собирали здесь, до звонка, но нужный
 * человек вспоминается по ходу («позови ещё Петра, он в курсе»), поэтому приглашение
 * переехало внутрь окна созвона — вместе со ссылкой для внешнего гостя.
 *
 * Кого зовём сразу: из личной переписки — собеседника, из группы — её участников,
 * из панели (вне чата) — никого. «Всех подряд» здесь было бы худшим умолчанием:
 * созвон на десять человек ради вопроса к одному — худшее, что можно сделать
 * с чужим временем.
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

  const start = async () => {
    if (disabled) return;
    // Запись с ИИ включается уже в разговоре: это решение принимают, увидев, кто пришёл.
    if (!chatId) return onStart({ memberIds: [], withAi: false });
    if (kind === 'dm') return onStart({ memberIds: peerId ? [String(peerId)] : [], withAi: false });
    const members = await api.chatMembers(chatId)
      .then((r) => r.members
        .map((m: { userId: string | number }) => String(m.userId))
        .filter((id: string) => id !== String(user?.id ?? '')))
      .catch(() => [] as string[]);
    onStart({ memberIds: members, withAi: false });
  };

  return (
    <span className="call-starter">
      <button
        className="btn btn-sm call-starter-call"
        disabled={disabled}
        title={disabled ? 'Вы уже в созвоне' : 'Начать созвон'}
        onClick={start}
      >
        <Icon name="phone" size={15} /> Созвон
      </button>
    </span>
  );
}

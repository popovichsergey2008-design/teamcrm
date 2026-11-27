import { Popover } from '@base-ui/react/popover';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import './read-ticks.css';

type Readers = Awaited<ReturnType<typeof api.messageReaders>>;

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/**
 * #5063: галочки у своего сообщения в группе — кнопка «кто прочитал», как в Telegram.
 * Список грузится по нажатию: та же мерка, что у галочек (участник открывал чат после
 * сообщения). Гости по ссылке в счёт не входят — у них нет отметки чтения.
 */
export function ReadTicks({ chatId, messageId, readBy, others }: {
  chatId: string; messageId: string; readBy: number; others: number;
}) {
  const [data, setData] = useState<Readers | null>(null);
  const [err, setErr] = useState(false);
  const all = others > 0 && readBy >= others;
  const load = () => {
    setErr(false);
    api.messageReaders(chatId, messageId).then(setData).catch(() => setErr(true));
  };
  return (
    <Popover.Root onOpenChange={(open) => { if (open) load(); }}>
      <Popover.Trigger
        className={`chat-ticks chat-ticks-btn${all ? ' read' : ''}`}
        aria-label={all ? `Прочитали все (${readBy}). Кто прочитал` : `Прочитали ${readBy} из ${others}. Кто прочитал`}
        title="Кто прочитал"
      >
        <Icon name="check" size={12} />
        {readBy > 0 && <Icon name="check" size={12} />}
        <span className="chat-ticks-n">{readBy}/{others}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="ui-positioner" sideOffset={4} align="end">
          <Popover.Popup className="ui-popup rt-pop">
            {err ? <div className="dim">Не получилось загрузить — попробуйте ещё раз.</div>
              : !data ? <div className="dim">Загружаю…</div>
              : (
                <>
                  <div className="rt-h"><Icon name="check-check" size={13} /> Прочитали · {data.read.length}</div>
                  {data.read.length === 0 && <div className="dim rt-row">Пока никто</div>}
                  {data.read.map((r) => (
                    <div key={r.id} className="rt-row"><span className="rt-name">{r.name}</span><span className="dim">{when(r.at)}</span></div>
                  ))}
                  {data.unread.length > 0 && (
                    <>
                      <div className="rt-h"><Icon name="eye-off" size={13} /> Ещё не прочитали · {data.unread.length}</div>
                      {data.unread.map((r) => <div key={r.id} className="rt-row"><span className="rt-name">{r.name}</span></div>)}
                    </>
                  )}
                </>
              )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

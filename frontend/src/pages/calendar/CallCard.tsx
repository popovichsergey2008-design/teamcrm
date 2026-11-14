import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { calApi, type CallCardData, type CallCardTask } from './cal-api';

const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateShort = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

function TaskLine({ t }: { t: CallCardTask }) {
  const open = () => { if (t.taskId && t.projectId) navigate({ section: 'projects', projectId: t.projectId, taskId: t.taskId }); };
  return (
    <div className="cal-agent-row">
      <span>
        {t.done ? <Icon name="check" size={12} /> : <Icon name="flag" size={12} />}{' '}
        {t.taskId && t.projectId ? <button type="button" className="cal-link" onClick={open}>{t.title}</button> : t.title}
      </span>
      <span className="dim cal-small">{[t.assignee, t.deadlineAt ? `до ${dateShort(t.deadlineAt)}` : null, t.done ? 'сделано' : null].filter(Boolean).join(' · ')}</span>
    </div>
  );
}

/**
 * Карточка созвона (#4920, п. 4; п. 6 ТЗ #4892). Щелчок по созвону в сетке раньше
 * уводил в общий список встреч — теперь всё о встрече здесь: тема, кто был, «Войти в
 * звонок», пока идёт, итоги и задачи по людям, что договорились в прошлый раз,
 * материалы из чата. Протокол целиком — по ссылке в экран итогов.
 */
export function CallCard({ id, onClose, onJoin }: { id: string; onClose: () => void; onJoin: (roomId: string) => void }) {
  const [card, setCard] = useState<CallCardData | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    calApi.callCard(id).then(setCard).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось открыть созвон'));
  }, [id]);
  const m = card?.meeting;
  const processing = m && m.status !== 'done' && m.status !== 'error' && m.status !== 'recorded';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={card?.title ?? 'Созвон'}
      description={card ? `${day(card.startsAt)}, ${hhmm(card.startsAt)}–${card.live ? 'идёт сейчас' : hhmm(card.endsAt)}${card.people.length ? ` · ${card.people.join(', ')}` : ''}` : undefined}>
      <div className="cal-analytics">
        {!card && !err && <div className="dim cal-small">Открываю…</div>}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={14} /> {err}</div>}
        {card && (
          <>
            <div className="cal-dialog-actions" style={{ justifyContent: 'flex-start' }}>
              {card.live && (
                <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { onJoin(card.roomId); onClose(); }}>
                  <Icon name="video" size={14} /> Войти в звонок
                </button>
              )}
              {card.chatId && (
                <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { navigate({ section: 'chat', chatId: card.chatId! }); onClose(); }}>
                  <Icon name="chat" size={14} /> {card.chatTitle ? `Чат «${card.chatTitle}»` : 'Открыть чат'}
                </button>
              )}
              {m && (
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { navigate({ section: 'chat', view: 'postcall', meetingId: m.id }); onClose(); }}>
                  Протокол и задачи
                </button>
              )}
            </div>

            <section className="cal-agent-card">
              <div className="cal-first-kicker">Итоги</div>
              {card.live && <div className="dim cal-small">Созвон идёт — итоги появятся после его окончания.</div>}
              {!card.live && !m && <div className="dim cal-small">Созвон не записывался — итогов нет.</div>}
              {processing && <div className="dim cal-small">QEVO Bot готовит итоги…</div>}
              {m?.status === 'error' && <div className="dim cal-small">Итоги не собраны — разговор не удалось разобрать. Откройте протокол и нажмите «Разобрать заново».</div>}
              {m?.summary && <div className="cal-small" style={{ whiteSpace: 'pre-line' }}>{m.summary}</div>}
              {!!m?.decisions.length && (
                <>
                  <div className="cal-tt-label">Решения</div>
                  {m.decisions.map((d, i) => <div key={i} className="cal-small">• {d}</div>)}
                </>
              )}
              {!!m?.tasks.length && (
                <>
                  <div className="cal-tt-label">Задачи</div>
                  {m.tasks.map((t, i) => <TaskLine key={i} t={t} />)}
                </>
              )}
            </section>

            {card.previous && (
              <section className="cal-agent-card">
                <div className="cal-first-kicker">В прошлый раз · {dateShort(card.previous.happenedAt)} · {card.previous.title}</div>
                {card.previous.agreements.length
                  ? card.previous.agreements.map((t, i) => <TaskLine key={i} t={t} />)
                  : <div className="dim cal-small">Договорённостей с задачами не было.</div>}
              </section>
            )}

            {card.materials.length > 0 && (
              <section className="cal-agent-card">
                <div className="cal-first-kicker">Материалы из чата</div>
                {card.materials.map((f) => (
                  <div key={f.fileId} className="cal-agent-row">
                    <span><Icon name="file" size={12} /> {f.title}</span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

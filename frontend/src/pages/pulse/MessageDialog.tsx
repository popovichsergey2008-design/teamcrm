import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { feedback } from '../../lib/feedback';
import { pulseApi, Prepared } from './pulse-api';

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100; const b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
};

/**
 * Одно сообщение на группу задач (#4890, п. 8): готовый текст от ИИ (без ключа — по
 * правилам), его можно править; получатель и список задач видны до отправки. Ничего не
 * уходит без «Отправить». После отправки у задач группы в истории — «запрошен статус».
 */
export function MessageDialog({ userId, kind, taskIds, onClose, onSent }: {
  userId: string; kind: 'overdue' | 'review'; taskIds?: string[]; onClose: () => void; onSent: () => void;
}) {
  const [p, setP] = useState<Prepared | null>(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[] | null>(taskIds ?? null);
  const [editList, setEditList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const prepare = useCallback(async (ids?: string[]) => {
    setBusy(true); setErr('');
    try {
      const r = await pulseApi.prepare({ userId, kind, taskIds: ids });
      setP(r); setText(r.text); setPicked(r.tasks.map((t) => t.id));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить сообщение'); }
    finally { setBusy(false); }
  }, [userId, kind]);
  useEffect(() => { void prepare(taskIds); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!p || !picked?.length) return;
    setBusy(true); setErr('');
    try {
      const r = await pulseApi.send({ userId, kind, taskIds: picked, text });
      feedback('action.confirmed');
      toastSaved('Сообщение отправлено', `${p.recipient.name} · у ${r.marked} ${plural(r.marked, 'задачи', 'задач', 'задач')} в истории — «запрошен статус»`);
      onSent(); onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
    finally { setBusy(false); }
  };

  const n = picked?.length ?? 0;
  const title = kind === 'review' ? `Напомнить о ${n} ${plural(n, 'проверке', 'проверках', 'проверках')}` : `Спросить статус по ${n} ${plural(n, 'задаче', 'задачам', 'задачам')}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title={title}
      description={p ? `Сообщение в чат · ${p.recipient.name}` : 'Сообщение в чат'}
      footer={(
        <>
          <Button variant="primary" loading={busy} disabled={!p || !n || editList || text.trim().length < 5} onClick={() => void send()}>Отправить</Button>
          <Button variant="outline" disabled={!p} aria-expanded={editList} onClick={() => setEditList((v) => !v)}>Изменить список задач</Button>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
        </>
      )}>
      {!p && !err && <div className="dim">Готовлю текст…</div>}
      {err && <div className="error-text">{err}</div>}
      {p && (
        <>
          <textarea className="input pulse-text" rows={9} value={text} onChange={(e) => setText(e.target.value)} aria-label="Текст сообщения" />
          <div className="dim pulse-small">
            {p.source === 'ai' ? 'Текст подготовил ИИ — можно править.' : 'Текст собран по правилам (ИИ не подключён) — можно править.'} Отправится от вашего имени в личный чат Qevo.
          </div>
          {editList ? (
            <div className="pulse-pick" role="group" aria-label="Задачи в сообщении">
              {p.available.map((t) => (
                <label key={t.id} className="pulse-pick-row">
                  <input type="checkbox" checked={!!picked?.includes(t.id)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...(cur ?? []), t.id] : (cur ?? []).filter((x) => x !== t.id)))} />
                  <span>#{t.id} {t.title}</span>
                  <span className="dim">{kind === 'review' ? `ждёт ${t.days} дн.` : `просрочена на ${t.days} дн.`}</span>
                </label>
              ))}
              <Button size="sm" variant="secondary" disabled={!n || busy} onClick={() => { setEditList(false); void prepare(picked ?? []); }}>Обновить текст по списку</Button>
            </div>
          ) : (
            <div className="dim pulse-small">Получатель: <b>{p.recipient.name}</b> · задачи: {p.tasks.map((t) => `#${t.id}`).join(', ')}</div>
          )}
        </>
      )}
    </Dialog>
  );
}

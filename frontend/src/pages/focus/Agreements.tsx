import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { Agreement, focusApi } from './focus-api';

/**
 * Договорённости после встречи (#4891, п. 8): цитата, кто сказал, время в записи, срок.
 * Похожая задача уже есть — «Добавить в #N» вместо дубля. Ни одна договорённость не
 * становится задачей без нажатия; «Это не обещание» убирает фразу из брифа и учит фильтр.
 */
export function Agreements({ meId }: { meId: string | undefined }) {
  const [list, setList] = useState<Agreement[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { void focusApi.agreements().then((r) => setList(r.items)).catch(() => setList([])); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (a: Agreement, fn: () => Promise<unknown>, msg: string) => {
    setBusy(a.id);
    try { await fn(); toastSaved(msg); setList((l) => (l ?? []).filter((x) => x.id !== a.id)); window.dispatchEvent(new Event('teamcrm:tasks-changed')); }
    catch (e) {
      toastSaved('Не получилось', e instanceof ApiError ? e.message : '');
      if (e instanceof ApiError && /проект/i.test(e.message)) navigate({ section: 'chat', view: 'meetings' });
    } finally { setBusy(null); }
  };
  if (!list?.length) return null;
  return (
    <section className="fp-card" aria-label="Договорённости после встречи">
      <div className="fp-title"><Icon name="video" size={15} /> Договорённости после встречи</div>
      {list.map((a) => {
        const other = a.assigneeId && a.assigneeId !== String(meId);
        const first = (a.assigneeName ?? '').split(' ')[0];
        return (
          <article key={a.id} className="fp-agree">
            <div className="fp-small dim">{a.meetingTitle}{a.speaker ? ` · ${a.speaker}` : ''}{a.at ? ` · ${a.at} в записи` : ''}{a.deadlineAt ? ` · срок ${new Date(a.deadlineAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : ''}</div>
            <blockquote className="fp-quote">«{a.quote ?? a.title}»</blockquote>
            <div className="fp-acts">
              {a.similar ? (
                <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy === a.id} title={a.similar.title}
                  onClick={() => void act(a, () => focusApi.attach(a.id, a.similar!.id), `Добавлено в #${a.similar!.id}`)}>Добавить в #{a.similar.id}</button>
              ) : null}
              <button type="button" className={`ui-btn ui-btn-sm ${a.similar ? 'ui-btn-outline' : 'ui-btn-primary'}`} disabled={busy === a.id}
                onClick={() => void act(a, () => api.applyMeetingDraft(a.id, { assigneeId: meId }), 'Задача создана')}>Новая задача</button>
              {other && (
                <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy === a.id}
                  onClick={() => void act(a, () => api.applyMeetingDraft(a.id, { assigneeId: a.assigneeId! }), `Поручено: ${a.assigneeName}`)}>Поручить {first}</button>
              )}
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy === a.id}
                onClick={() => void act(a, () => focusApi.notPromise(a.id), 'Понял — это не обещание')}>Это не обещание</button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

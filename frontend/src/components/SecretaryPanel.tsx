import { useEffect, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './Skeleton';
import type { AiAction, Ping, Proposal } from '../types';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

/**
 * Журнал «AI Секретаря»: что система сделала за людей сама.
 *
 * Показываем только то, что действительно записано в журнал действий. Пока
 * ассистент не сделал ничего — так и говорим, а не рисуем ноль с многозначительным
 * видом: заявленная экономия времени, которой не было, обесценивает и настоящую.
 */

const KIND_ICON: Record<string, IconName> = {
  meeting_summary: 'record',
  meeting_task: 'record',
  standup: 'users',
  agent_run: 'robot',
  inbox_draft: 'inbox',
  nl_task: 'zap',
  ping: 'bell',
  digest: 'bell',
  gap_fix: 'check',
};

/** «2 ч 15 мин» читается быстрее, чем «135 минут». */
export function humanMinutes(total: number): string {
  if (total <= 0) return '0 мин';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? time : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')} ${time}`;
}

export function SecretaryPanel({ canManage = false, onClose }: { canManage?: boolean; onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [items, setItems] = useState<AiAction[] | null>(null);
  const [summary, setSummary] = useState<{ actions: number; savedMinutes: number } | null>(null);
  const [reaction, setReaction] = useState<{ rate: number; sent: number; muted: string[] } | null>(null);

  useEffect(() => {
    api.secretaryLog(100).then(setItems).catch(() => setItems([]));
    api.secretarySummary().then(setSummary).catch(() => undefined);
    api.assistantReaction().then(setReaction).catch(() => undefined);
  }, []);

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={18} /> AI Секретарь</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="secretary-summary">
          <div>
            <div className="secretary-big">{summary?.actions ?? 0}</div>
            <div className="dim">действий сегодня</div>
          </div>
          <div>
            <div className="secretary-big">{humanMinutes(summary?.savedMinutes ?? 0)}</div>
            <div className="dim">примерно столько ручной работы это заменило</div>
          </div>
        </div>

        {/* Честная мера рядом с «сэкономленным»: непрочитанное напоминание
            не экономит ни минуты, и об этом лучше знать. */}
        {reaction && reaction.sent > 0 && (
          <div className="dim secretary-reaction">
            Напоминания за две недели: {reaction.sent}, взялись за дело после {reaction.rate}%.
            {reaction.muted.length > 0 && ' Поводы без отклика приглушены — напоминаю о них реже.'}
          </div>
        )}

        <Ask />
        <Gaps canManage={canManage} />
        <Proposed />
        <Maintenance canManage={canManage} />

        {items === null && <SkeletonList rows={6} />}
        {items !== null && items.length === 0 && (
          <EmptyState
            icon="sparkles"
            compact
            title="Пока ничего не сделано"
            hint={'Сюда попадают действия, которые система выполняет сама: разбор встреч, черновики '
              + 'из входящих, работа ИИ-агента, задачи из быстрых команд.'}
          />
        )}

        {items !== null && items.length > 0 && (
          <div className="secretary-feed">
            {items.map((a) => (
              <div key={a.id} className="secretary-row">
                <span className="secretary-icon"><Icon name={KIND_ICON[a.kind] ?? 'sparkles'} size={15} /></span>
                <div className="secretary-body">
                  <div>{a.summary}</div>
                  <div className="secretary-meta">
                    {when(a.created_at)}
                    {a.user_name ? ` · ${a.user_name}` : ''}
                    {a.saved_minutes > 0 ? ` · ${a.saved_minutes} мин` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * «Спросите о делах» — секретарь как собеседник, а не вестник.
 *
 * Вопросы вроде «что с проектом Сайт» и «кто свободен» задают вслух коллеге по
 * десять раз в неделю, и каждый раз кто-то идёт смотреть доски. Отвечаем цифрами
 * из базы: придуманный ответ про текущие дела опаснее отсутствия ответа.
 */
function Ask() {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async (text?: string) => {
    const question = (text ?? q).trim();
    if (question.length < 3) return;
    setQ(question);
    setBusy(true);
    try { setAnswer((await api.assistantAsk(question)).answer); }
    catch { setAnswer('Не получилось спросить — попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="secretary-ask">
      <div className="drawer-section-title"><Icon name="sparkles" size={14} /> Спросите о делах</div>
      <div className="ask-row">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          placeholder="что с проектом Сайт · кто свободен · что горит"
          aria-label="Вопрос секретарю"
        />
        <button className="btn btn-primary btn-sm" onClick={() => void ask()} disabled={busy}>
          {busy ? 'Смотрю…' : 'Спросить'}
        </button>
      </div>
      {/* Подсказки-кнопки: с ними видно, что спрашивать можно, — пустое поле молчит. */}
      {!answer && (
        <div className="ask-chips">
          {['что горит', 'кто свободен', 'что на мне'].map((hint) => (
            <button key={hint} className="btn btn-ghost btn-sm" onClick={() => void ask(hint)}>{hint}</button>
          ))}
        </div>
      )}
      {answer && <div className="ask-answer">{answer}</div>}
    </div>
  );
}

/**
 * «Не хватает данных» — работа, а не жалоба.
 *
 * Сообщить «у вас 45 задач без срока» бесполезно: от этого ничего не меняется, а идти
 * заполнять полсотни полей руками никто не сядет. Поэтому здесь готовые ответы — кого
 * поставить и на когда, с причиной. Руководителю остаётся согласиться, поправить или
 * сказать «не этой»; сказанное «не этой» больше не спрашивают.
 *
 * Пустые поля — не мелочь: из-за них молчит секретарь, не работает светофор рисков
 * и не считается загрузка команды.
 */
function Gaps({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.assistantGaps>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = () => api.assistantGaps().then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  if (!canManage || !data) return null;
  const { noAssignee, noDeadline } = data;
  if (!noAssignee.length && !noDeadline.length) return null;

  const apply = async (row: { taskId: string }, body: Record<string, unknown>, confirmOverload = false) => {
    setBusy(row.taskId); setNote('');
    try {
      const res = await api.applyGap({ taskId: row.taskId, ...body, confirmOverload });
      // Человек уже перегружен — прогноз предупреждает ровно так же, как при
      // назначении руками. Решает руководитель, а не секретарь.
      if (res?.applied === false && res?.warning) {
        setNote(`У человека уже ${Math.round(res.projectedHours)} ч работы при норме ${Math.round(res.capacityHours)} ч.`);
        if (window.confirm('Человек перегружен. Всё равно назначить?')) return apply(row, body, true);
        return;
      }
      await load();
    } catch { setNote('Не получилось — попробуйте из карточки задачи'); }
    finally { setBusy(null); }
  };

  const skip = async (taskId: string, kind: 'assignee' | 'deadline') => {
    setBusy(taskId);
    try { await api.skipGap(taskId, kind); await load(); }
    catch { /* следующий заход покажет строку снова — это не потеря */ }
    finally { setBusy(null); }
  };

  return (
    <div className="secretary-proposed">
      <div className="drawer-section-title"><Icon name="alert" size={14} /> Не хватает данных</div>
      {note && <div className="dim gap-note">{note}</div>}

      {noAssignee.map((r) => (
        <div key={`a${r.taskId}`} className="gap-row">
          <div className="gap-body">
            <div className="gap-title">{r.title}</div>
            <div className="dim gap-meta">
              {r.projectName} · без исполнителя · предлагаю <b>{r.assignee?.fullName}</b>: {r.assignee?.reason}
            </div>
          </div>
          <span className="gap-actions">
            <button
              className="btn btn-sm"
              disabled={busy === r.taskId}
              onClick={() => apply(r, { assigneeId: r.assignee?.userId })}
            >
              Назначить
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy === r.taskId} onClick={() => skip(r.taskId, 'assignee')}>
              Не этой
            </button>
          </span>
        </div>
      ))}

      {noDeadline.map((r) => (
        <div key={`d${r.taskId}`} className="gap-row">
          <div className="gap-body">
            <div className="gap-title">{r.title}</div>
            <div className="dim gap-meta">
              {r.projectName} · без срока · предлагаю <b>{r.deadline?.date}</b>: {r.deadline?.reason}
            </div>
          </div>
          <span className="gap-actions">
            <button
              className="btn btn-sm"
              disabled={busy === r.taskId}
              onClick={() => apply(r, { deadline: r.deadline?.date })}
            >
              Поставить срок
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy === r.taskId} onClick={() => skip(r.taskId, 'deadline')}>
              Не этой
            </button>
          </span>
        </div>
      ))}

      {(data.counts.noAssignee > noAssignee.length || data.counts.noDeadline > noDeadline.length) && (
        <div className="dim gap-note">
          Показано первое; всего без исполнителя — {data.counts.noAssignee}, без срока — {data.counts.noDeadline}.
        </div>
      )}
    </div>
  );
}

/**
 * «Предлагаю напомнить» — режим копилота.
 *
 * Ассистент нашёл повод, но писать человеку от своего имени не стал: решает тот, кто
 * задачу поручил. Ему же и видно, кого именно собираются дёрнуть, — иначе кнопка
 * «отправить» превращается в лотерею.
 */
function Proposed() {
  const [items, setItems] = useState<Ping[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.assistantProposed().then(setItems).catch(() => setItems([])); }, []);

  const act = async (p: Ping, send: boolean) => {
    setItems((prev) => (prev ?? []).filter((x) => x.id !== p.id));
    setBusy(p.id);
    try { await (send ? api.sendPing(p.id) : api.dismissPing(p.id)); }
    catch { api.assistantProposed().then(setItems).catch(() => undefined); }
    finally { setBusy(null); }
  };

  if (!items || !items.length) return null;

  return (
    <div className="secretary-proposed">
      <div className="drawer-section-title"><Icon name="bell" size={14} /> Предлагаю напомнить</div>
      {items.map((p) => (
        <div key={p.id} className="ping-row">
          <span className="ping-text-static">
            {p.text}
            {p.toName && <span className="dim"> · {p.toName}</span>}
          </span>
          <span className="ping-actions">
            <button className="btn btn-sm" disabled={busy === p.id} onClick={() => act(p, true)}>Напомнить</button>
            <button className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => act(p, false)}>Не надо</button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * «Предлагаю прибрать» — Zero-Maintenance.
 *
 * Единственное место ассистента, где он ничего не делает сам даже в автопилоте:
 * напоминание можно проигнорировать, а закрытую без спроса задачу человек может
 * не заметить вовсе. Поэтому здесь только предложения — и кнопка «Вернуть» рядом
 * с уже сделанным, а не в глубине настроек.
 */
function Maintenance({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => { api.maintenanceList().then(setItems).catch(() => setItems([])); };
  useEffect(load, []);

  const act = async (p: Proposal, what: 'apply' | 'dismiss' | 'undo') => {
    setBusy(p.id);
    try {
      if (what === 'apply') await api.applyMaintenance(p.id);
      else if (what === 'dismiss') await api.dismissMaintenance(p.id);
      else await api.undoMaintenance(p.id);
      // доска изменилась — экраны задач должны это увидеть
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      load();
    } catch { load(); } finally { setBusy(null); }
  };

  if (!items || !items.length) return null;
  const pending = items.filter((p) => p.status === 'pending');
  const done = items.filter((p) => p.status === 'applied');

  return (
    <div className="secretary-proposed">
      {pending.length > 0 && (
        <>
          <div className="drawer-section-title"><Icon name="archive" size={14} /> Предлагаю прибрать</div>
          {pending.map((p) => (
            <div key={p.id} className="ping-row">
              <span className="ping-text-static">{p.text}</span>
              {canManage && (
                <span className="ping-actions">
                  <button className="btn btn-sm" disabled={busy === p.id} onClick={() => act(p, 'apply')}>Убрать</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => act(p, 'dismiss')}>
                    Не надо
                  </button>
                </span>
              )}
            </div>
          ))}
        </>
      )}

      {done.length > 0 && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 14 }}>
            <Icon name="reply" size={14} /> Недавно прибрано
          </div>
          {done.map((p) => (
            <div key={p.id} className="ping-row">
              <span className="ping-text-static">
                {p.title}
                <span className="dim">{p.decidedBy ? ` · ${p.decidedBy}` : ''}{p.decidedAt ? ` · ${when(p.decidedAt)}` : ''}</span>
              </span>
              {canManage && (
                <span className="ping-actions">
                  <button className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => act(p, 'undo')}>
                    Вернуть
                  </button>
                </span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

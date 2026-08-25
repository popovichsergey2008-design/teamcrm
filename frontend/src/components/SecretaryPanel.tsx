import { useEffect, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './Skeleton';
import type { AiAction, Ping } from '../types';
import { useEscape } from '../hooks/useEscape';

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

export function SecretaryPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [items, setItems] = useState<AiAction[] | null>(null);
  const [summary, setSummary] = useState<{ actions: number; savedMinutes: number } | null>(null);

  useEffect(() => {
    api.secretaryLog(100).then(setItems).catch(() => setItems([]));
    api.secretarySummary().then(setSummary).catch(() => undefined);
  }, []);

  return (
    <div className="drawer-overlay" onClick={onClose}>
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

        <Proposed />

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

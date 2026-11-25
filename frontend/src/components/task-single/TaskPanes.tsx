import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { activityText } from '../TaskChat';
import { api, request } from '../../lib/api';
import { navigate } from '../../lib/router';

/** Сколько по задаче учтено таймером и идёт ли сейчас мой (#5016). */
export function useTaskTime(taskId: string, timerActive: boolean) {
  const [t, setT] = useState<{ totalSec: number; runningSince: string | null } | null>(null);
  const load = useCallback(() => {
    request<{ totalSec: number; runningSince: string | null }>('GET', `/tasks/${taskId}/time`).then(setT).catch(() => setT(null));
  }, [taskId]);
  // таймер включили/выключили — перечитываем (старт закрывает прежний отрезок на сервере)
  useEffect(() => { const h = window.setTimeout(load, timerActive ? 0 : 400); return () => window.clearTimeout(h); }, [load, timerActive]);
  const [now, setNow] = useState(Date.now());
  const running = timerActive || !!t?.runningSince;
  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [running]);
  const live = running && t?.runningSince ? Math.max(0, Math.floor((now - new Date(t.runningSince).getTime()) / 1000)) : 0;
  return { totalSec: (t?.totalSec ?? 0) + live, running, reload: load };
}

export const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
export const spentWords = (sec: number) => `${Math.floor(sec / 3600)} ч ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} мин`;

/** Вкладка «История»: лента событий по задаче — дата и время, кто, что сделал (ТЗ п. 6, a-8). */
export function HistoryRows({ taskId, version }: { taskId: string; version?: number }) {
  const [items, setItems] = useState<{ id: string; kind: string; detail?: Record<string, unknown>; created_at: string; actor_name?: string | null }[] | null>(null);
  useEffect(() => { api.taskActivity(taskId).then((r) => setItems(r)).catch(() => setItems([])); }, [taskId, version]);
  if (!items) return <div className="ts-ev"><span /><span className="ts-faint">Загружаю…</span></div>;
  if (!items.length) return <div className="ts-ev"><span /><span className="ts-faint">Событий пока нет</span></div>;
  const when = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const y = new Date(Date.now() - 86_400_000);
    const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `сегодня ${t}`;
    if (d.toDateString() === y.toDateString()) return `вчера ${t}`;
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${t}`;
  };
  return (
    <>
      {items.slice(0, 200).map((a) => (
        <div key={a.id} className="ts-ev">
          <span>{when(a.created_at)}</span>
          <span>{a.actor_name ? <b>{a.actor_name}</b> : 'Система'} {activityText(a as { kind: string; detail?: Record<string, any> })}</span>
        </div>
      ))}
    </>
  );
}

/** «Запланировать время» — блок в календаре со ссылкой на задачу (срок не меняется). */
export function planTime(taskId: string) {
  try { sessionStorage.setItem('calendar.planTask', String(taskId)); } catch { /* без хранилища */ }
  navigate({ section: 'calendar' });
}

export function FileTypeIcon({ name, mime }: { name: string; mime: string }) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const kind = mime.startsWith('image/') ? 'img' : mime.startsWith('video/') ? 'vid'
    : /xlsx?|csv|ods/.test(ext) ? 'xls' : /docx?|odt|rtf/.test(ext) ? 'doc' : ext === 'pdf' ? 'pdf' : /pptx?|odp|key/.test(ext) ? 'ppt' : /zip|rar|7z/.test(ext) ? 'zip' : 'file';
  const label = { img: 'IMG', vid: 'VID', xls: 'XLS', doc: 'DOC', pdf: 'PDF', ppt: 'PPT', zip: 'ZIP', file: ext.slice(0, 4).toUpperCase() || '' }[kind];
  return <span className={`ts-fi ts-fi-${kind}`} aria-hidden="true">{label || <Icon name="file" size={15} />}</span>;
}

export const fileSize = (n: number | string | null | undefined) => {
  const b = Number(n ?? 0);
  if (!b) return '';
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
};

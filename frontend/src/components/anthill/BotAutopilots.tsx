import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { AnthillSchedule, SecretaryPrefs } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { Dialog } from '../ui/dialog';
import { RichText } from '../RichText';
import type { Scenario } from './bot-catalog';

/**
 * Автопилоты (#4893, п. 7): готовые регулярные задачи одним переключателем. Часть уже
 * была во вкладке «Задачи» (утро, вечер, справка перед встречей) — здесь они рядом с
 * новыми: сводка отчётов сотрудников, «Кто не ответил», недельный обзор, конкуренты.
 * Первое включение — с примером выпуска на данных человека и «Включить»; выключение —
 * одним нажатием. Результат приходит в «Заметки» и Telegram.
 */
interface Pilot {
  id: string; title: string; hint: string;
  /** Сводки секретаря — настройкой; остальные — регулярной задачей бота. */
  secretary?: 'morning' | 'evening' | 'meeting';
  schedule?: { phrase: string; instruction: string };
  web?: boolean;
}

const PILOTS: Pilot[] = [
  { id: 'morning', title: 'Утром — ваш день', hint: 'встречи, сроки, просрочки, что ждёт решения · 9:00', secretary: 'morning' },
  { id: 'evening', title: 'Вечером — итоги', hint: 'что сделано, что перенесено, что завтра · 18:30', secretary: 'evening' },
  { id: 'meeting', title: 'Перед встречей — справка', hint: 'кто будет, прошлые решения, открытые задачи · за 15 мин', secretary: 'meeting' },
  { id: 'staff', title: 'Сводка отчётов сотрудников', hint: 'по человеку: сделано, риски, кто не прислал · по будням 9:30', schedule: { phrase: 'по будням в 9:30', instruction: 'Сведи вчерашние отчёты сотрудников в одну сводку: по человеку — что сделано, статус «по плану» или «риски», кто не прислал.' } },
  { id: 'silent', title: 'Кто не ответил', hint: 'сообщения и поручения без ответа больше 1 дня · по будням 10:00', schedule: { phrase: 'по будням в 10:00', instruction: 'Какие мои сообщения и поручения остались без ответа больше 1 дня? Список и вежливые напоминания черновиками.' } },
  { id: 'week', title: 'Недельный обзор', hint: 'закрыто, перенесено, просрочено, риски · пятница 16:00', schedule: { phrase: 'каждую пятницу в 16:00', instruction: 'Недельный обзор: что закрыто, что переносится, что просрочено, главные риски следующей недели.' } },
  { id: 'competitors', title: 'Мониторинг конкурентов', hint: 'сайты и цены 5 конкурентов, со ссылками · понедельник 9:00', web: true, schedule: { phrase: 'каждый понедельник в 9:00', instruction: 'Что нового у наших конкурентов: сайты, цены, новости — со ссылками на источники.' } },
];

export function BotAutopilots({ web, onPreview }: { web: boolean; onPreview: (s: Scenario) => void }) {
  const [prefs, setPrefs] = useState<SecretaryPrefs | null>(null);
  const [rows, setRows] = useState<AnthillSchedule[]>([]);
  const [example, setExample] = useState<{ pilot: Pilot; text: string } | null>(null);
  const load = useCallback(() => {
    void api.secretaryPrefs().then(setPrefs).catch(() => undefined);
    void api.anthillSchedules().then(setRows).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('teamcrm:bot-schedules', load);
    return () => window.removeEventListener('teamcrm:bot-schedules', load);
  }, [load]);

  const row = (p: Pilot) => rows.find((r) => r.title === p.title && r.status !== 'done');
  const isOn = (p: Pilot) => (p.secretary === 'morning' ? !!prefs?.morningAt : p.secretary === 'evening' ? !!prefs?.eveningAt
    : p.secretary === 'meeting' ? !!prefs?.meetingBriefMin : row(p)?.status === 'active');

  const secretaryPatch = (p: Pilot, on: boolean): Partial<SecretaryPrefs> => (p.secretary === 'morning' ? { morningAt: on ? '09:00' : null }
    : p.secretary === 'evening' ? { eveningAt: on ? '18:30' : null } : { meetingBriefMin: on ? 15 : null });

  const toggle = async (p: Pilot) => {
    try {
      if (isOn(p)) {
        // выключается за одно нажатие
        if (p.secretary) setPrefs(await api.saveSecretaryPrefs(secretaryPatch(p, false)));
        else { const r = row(p); if (r) await api.anthillDeleteSchedule(r.id); load(); }
        toastSaved('Выключено', p.title);
        return;
      }
      if (p.secretary === 'meeting') { setPrefs(await api.saveSecretaryPrefs(secretaryPatch(p, true))); toastSaved('Включено', p.title); return; }
      if (p.secretary) {
        // первое включение — с примером выпуска на своих данных
        const text = (await api.secretaryBrief(p.secretary)).text;
        setExample({ pilot: p, text });
        return;
      }
      onPreview({
        id: `pilot-${p.id}`, label: p.title, prompt: p.id === 'competitors' ? 'Что нового у конкурентов ({who}): сайты, цены, новости — со ссылками на источники.' : p.schedule!.instruction,
        params: p.id === 'competitors' ? [{ key: 'who', label: 'Конкуренты', text: 'до 5 названий или сайтов' }] : undefined,
        schedule: { phrase: p.schedule!.phrase, title: p.title },
      });
    } catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
  };

  return (
    <section className="bs-pilots" aria-label="Автопилоты">
      <div className="bs-sub">Автопилоты</div>
      {PILOTS.map((p) => {
        const off = p.web && !web;
        const on = isOn(p);
        return (
          <label key={p.id} className={`bs-pilot${off ? ' is-off' : ''}`}>
            <input type="checkbox" checked={on} disabled={off} onChange={() => void toggle(p)} aria-label={p.title} />
            <span className="bs-pilot-text"><b>{p.title}</b><span className="dim">{off ? 'нужен интернет по тарифу' : p.hint}</span></span>
          </label>
        );
      })}
      <div className="dim bs-note">Результат приходит в чат «Заметки» и в Telegram, если он привязан.</div>
      {example && (
        <Dialog open onOpenChange={(o) => { if (!o) setExample(null); }} size="md" title={`${example.pilot.title}: пример выпуска`}
          footer={(
            <>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setExample(null)}>Отмена</button>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => void api.saveSecretaryPrefs(secretaryPatch(example.pilot, true))
                .then((x) => { setPrefs(x); toastSaved('Включено', example.pilot.title); setExample(null); })
                .catch((e) => toastSaved('Не получилось', e instanceof ApiError ? e.message : ''))}>Включить</button>
            </>
          )}>
          <RichText text={example.text} />
        </Dialog>
      )}
    </section>
  );
}

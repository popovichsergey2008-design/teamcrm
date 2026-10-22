import { useEffect, useState } from 'react';
import './sla-targets.css';
import { api, type SupportSla } from '../../lib/api';

/**
 * Раздел 4 ТЗ-34 (#4620): «Целевые метрики (SLA) поддержки» — цель из документа
 * рядом с фактом из базы за 30 дней.
 *
 * Чего база не знает, то так и названо: «не измеряется». Правдоподобная цифра там,
 * где её никто не мерил, хуже пустой клетки — по ней начнут принимать решения.
 */
type Verdict = 'ok' | 'miss' | 'none';
interface Row { target: string; fact: string; verdict: Verdict; note?: string }

const sec = (n: number) => `${String(n).replace('.', ',')} с`;
const pct = (n: number) => `${String(n).replace('.', ',')}%`;
const NOT_MEASURED: Omit<Row, 'target'> = { fact: 'не измеряется', verdict: 'none' };

export function slaRows(s: SupportSla): Row[] {
  const upTo = (v: number | null, max: number, fmt: (n: number) => string, note?: string): Omit<Row, 'target'> =>
    v === null ? { fact: 'нет данных за 30 дней', verdict: 'none', note } : { fact: fmt(v), verdict: v <= max ? 'ok' : 'miss', note };
  return [
    { target: '1. Скорость открытия шторки поддержки: менее 0.15 секунды (нативная плавность 120 Гц без загрузки веб-страниц).', ...NOT_MEASURED },
    { target: '2. Количество действий для вызова помощи: 1 движение (встряхивание, тап или Cmd+K).', ...NOT_MEASURED },
    {
      target: '3. Количество скриншотов от пользователя: 0 штук.',
      fact: `${s.userScreenshots} шт.`,
      verdict: s.userScreenshots === 0 ? 'ok' : 'miss',
      note: s.userScreenshots ? `в ${s.conversationsWithScreenshots} из ${s.conversations} обращений` : `обращений: ${s.conversations}`,
    },
    { target: '4. Ответ умного AI-ассистента с кнопкой готового действия: до 1 секунды.', ...upTo(s.aiFirstSeconds, 1, sec, 'медиана первого ответа помощника') },
    { target: '5. Ответ живого продуктового инженера (Support Hero): 25–45 секунд 24/7/365.', ...upTo(s.humanFirstSeconds, 45, sec, 'медиана первого ответа человека') },
    {
      target: '6. Подключение к голосовому/экранному Huddle внутри приложения: 20–30 секунд.',
      ...upTo(s.huddleConnectSeconds, 30, sec, s.huddleCount ? `медиана от просьбы до «принял», созвонов: ${s.huddleCount}` : undefined),
    },
    { target: '7. Выполнение настроек в 1 тап без перехода на компьютер: более 85% всех обращений.', ...NOT_MEASURED },
    {
      target: '8. Оценка счастья пользователя в приложении (оценка в 1 тап после решения): не ниже 99%.',
      ...(s.happyPercent === null
        ? { fact: 'нет оценок за 30 дней', verdict: 'none' as const }
        : { fact: pct(s.happyPercent), verdict: s.happyPercent >= 99 ? 'ok' as const : 'miss' as const, note: `«Хорошо» и «Отлично» из ${s.csatCount} оценок` }),
    },
  ];
}

const LABEL: Record<Verdict, string> = { ok: 'в цели', miss: 'мимо цели', none: '—' };

export function SlaTargets() {
  const [s, setS] = useState<SupportSla | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api.supportSla().then(setS).catch(() => setErr(true)); }, []);
  if (err) return <div className="dim sla-err">Цели по документу: не удалось загрузить факт.</div>;
  if (!s) return null;
  return (
    <section className="sla">
      <div className="drawer-section-title">Целевые метрики (SLA) поддержки — цель по документу и факт за 30 дней</div>
      <div className="sla-scroll">
        <table className="sla-table">
          <thead><tr><th>Цель по документу</th><th>Факт</th><th>Итог</th></tr></thead>
          <tbody>
            {slaRows(s).map((r) => (
              <tr key={r.target}>
                <td>{r.target}</td>
                <td><b>{r.fact}</b>{r.note && <div className="dim sla-note">{r.note}</div>}</td>
                <td><span className={`sla-verdict sla-${r.verdict}`}>{LABEL[r.verdict]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

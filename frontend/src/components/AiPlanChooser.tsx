import { useState } from 'react';
import './ai-plan.css';
import { Icon } from './Icon';
import { Dialog } from './ui/dialog';
import { api, ApiError } from '../lib/api';
import type { AiPlanCode, AiPlanView } from '../types';

/** Что даёт тариф — те же слова на выборе при регистрации и в настройках (ТЗ-33, §10). */
export const PLAN_CARDS: { code: AiPlanCode; title: string; lead: string; yes: string[]; no: string[]; note?: string }[] = [
  {
    code: 'AI_BASIC',
    title: 'Базовый',
    lead: 'ИИ работает с данными QEVO',
    yes: ['задачи голосом и текстом', 'созвоны: расшифровка, итоги, задачи', 'брифинги и «Фокус дня»', 'чаты: задачи из сообщений, сводки', 'аналитика проектов и «Пульс»'],
    no: ['поиск в интернете', 'чтение внешних сайтов'],
  },
  {
    code: 'AI_EXTENDED',
    title: 'Расширенный',
    lead: 'Всё из «Базового» и интернет',
    yes: ['всё из «Базового»', 'поиск в интернете', 'чтение сайтов по ссылке', 'сведения о компаниях и конкурентах', 'внешние источники в ответах — с пометкой'],
    no: [],
    note: 'Интернет-запросы считаются отдельно, по месячному лимиту.',
  },
];

export function PlanCards({ current, busy, onPick, pickLabel }: {
  current?: AiPlanCode | null;
  busy?: boolean;
  onPick?: (code: AiPlanCode) => void;
  pickLabel?: (code: AiPlanCode) => string;
}) {
  return (
    <div className="aip-cards">
      {PLAN_CARDS.map((c) => (
        <section key={c.code} className={`aip-card${current === c.code ? ' aip-current' : ''}`} aria-label={`Тариф «${c.title}»`}>
          <header>
            <b>{c.title}</b>
            {current === c.code && <span className="ui-badge ui-badge-info">ваш тариф</span>}
          </header>
          <div className="dim">{c.lead}</div>
          <ul>
            {c.yes.map((y) => <li key={y}><Icon name="check" size={13} /> {y}</li>)}
            {c.no.map((n) => <li key={n} className="aip-no"><Icon name="close" size={13} /> {n}</li>)}
          </ul>
          {c.note && <div className="dim aip-note">{c.note}</div>}
          {onPick && (
            <button className={`ui-btn ui-btn-${c.code === 'AI_EXTENDED' ? 'primary' : 'outline'} ui-btn-sm`} disabled={busy} onClick={() => onPick(c.code)}>
              {pickLabel ? pickLabel(c.code) : `Выбрать «${c.title}»`}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * Выбор тарифа при регистрации (ТЗ-33, §9–10). Обязательный шаг онбординга: без него
 * путь не завершается. «Расширенный» сначала — пробный, с маленьким жёстким лимитом.
 */
export default function AiPlanChooser({ onClose, onDone }: { onClose: () => void; onDone: (v: AiPlanView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (code: AiPlanCode) => {
    setBusy(true); setErr('');
    try { onDone(await api.aiPlanSelect(code)); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не сохранилось');
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Тариф ИИ" size="lg"
      description="Выберите, как работает ИИ в вашей компании. Сменить тариф можно позже в «Настройки → Тариф и ИИ».">
      <PlanCards busy={busy} onPick={(c) => void pick(c)}
        pickLabel={(c) => (c === 'AI_EXTENDED' ? 'Попробовать «Расширенный» — 14 дней' : 'Выбрать «Базовый»')} />
      <div className="dim aip-note">Пробный «Расширенный»: 14 дней и 50 интернет-запросов. Потом — «Базовый», если не продлить.</div>
      {err && <div className="error-text" role="alert">{err}</div>}
    </Dialog>
  );
}

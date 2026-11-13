import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { navigate } from '../../lib/router';
import type { TrialStepView } from './pulse-api';

const GO: Record<TrialStepView['key'], () => void> = {
  invite: () => navigate({ section: 'settings', tab: 'team' }),
  tasks: () => navigate({ section: 'projects' }),
  reviewer: () => navigate({ section: 'projects' }),
  close: () => navigate({ section: 'tasks' }),
};
const HOW: Record<TrialStepView['key'], string> = {
  invite: 'Настройки → Команда → пригласить по почте или ссылкой',
  tasks: 'В проекте — «+ Задача», у каждой укажите срок',
  reviewer: 'В карточке задачи — поле «Проверяет» или колонка «На проверке» на доске',
  close: 'Отметьте сделанное — «Готово» в карточке задачи',
};

/**
 * Экран новой команды (#4890, п. 11): пока данных мало — не пустые блоки «мало данных»,
 * а четыре шага; каждый включает свою часть индекса. Рядом — пример готового пульса.
 * Все шаги сделаны — сервер сам отдаёт обычный Пульс.
 */
export function Trial({ steps, done, daysLeft }: { steps: TrialStepView[]; done: number; daysLeft: number | null }) {
  const left = steps.length - done;
  return (
    <section className="pulse-card pt-card" aria-label="Пульс включится через несколько шагов">
      <div className="pt-main">
        <div className="pulse-cap">Пульс включится через {left} {left === 1 ? 'шаг' : left < 5 ? 'шага' : 'шагов'}{daysLeft != null ? ` · пробный период: ещё ${daysLeft} дн.` : ''}</div>
        <div className="pulse-headline">Пока данных мало — вот что нужно, чтобы пульс заработал</div>
        <div className="pt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Сделано шагов">
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
        <div className="dim pulse-small">{done} из {steps.length} · каждый шаг включает часть индекса</div>
        {steps.map((s) => (
          <div key={s.key} className={`pt-step${s.done ? ' is-done' : ''}`}>
            <span className="pt-box" aria-hidden="true">{s.done && <Icon name="check" size={14} />}</span>
            <div className="pt-text">
              <b>{s.title}</b>
              <span className="dim pulse-small">{s.enables} · {s.progress}{s.done ? '' : ` · ${HOW[s.key]}`}</span>
            </div>
            {!s.done && <Button size="sm" variant="primary" onClick={GO[s.key]}>Сделать сейчас</Button>}
          </div>
        ))}
      </div>
      <aside className="pt-example" aria-label="Пример готового пульса">
        <div className="pulse-cap">Так будет выглядеть ваш пульс · пример</div>
        <div className="pt-example-body">
          <Ring value={64} zone="normal" />
          <p>«Команда закрывает больше, чем получает. Главное — 3 задачи ждут вашей проверки.»</p>
        </div>
      </aside>
    </section>
  );
}

/** Кольцо индекса: цвет по зоне, без красного «Критично» (п. 1). */
export function Ring({ value, zone, size = 120 }: { value: number; zone: string; size?: number }) {
  const c = 2 * Math.PI * 28;
  return (
    <div className={`pulse-score pz-${zone}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="28" className="pulse-ring-bg" />
        <circle cx="32" cy="32" r="28" className="pulse-ring" strokeDasharray={`${(Math.max(0, Math.min(100, value)) / 100) * c} ${c}`} />
      </svg>
      <b>{Math.round(value)}</b>
      <span>из 100</span>
    </div>
  );
}

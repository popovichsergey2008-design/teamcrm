/**
 * Направления задачи — галочками (задача #1295): для кого работа. Несколько сразу:
 * «API и форма на странице» — это и бэкенд, и фронтенд. Коды те же, что у людей в
 * «Команде», поэтому по ним подбирается исполнитель.
 */

export const DIRECTIONS: [string, string][] = [
  ['backend', 'Бэкенд'], ['frontend', 'Фронтенд'], ['content', 'Контент'],
  ['design', 'Дизайн'], ['qa', 'Тестирование'], ['analytics', 'Аналитика'],
];

export const directionLabel = (code: string) => DIRECTIONS.find(([c]) => c === code)?.[1] ?? code;

export function DirectionsPicker({ value, onChange, disabled, auto }: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Отмечено автоматически по тексту — подписываем, чтобы человек видел и мог поправить. */
  auto?: boolean;
}) {
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((x) => x !== code) : [...value, code]);
  return (
    <div className="field">
      <label>
        Направления{auto && value.length > 0 && <span className="dim directions-auto"> · отмечено по тексту</span>}
      </label>
      <div className="directions-picker" role="group" aria-label="Направления задачи">
        {DIRECTIONS.map(([code, label]) => (
          <label key={code} className={`directions-chip${value.includes(code) ? ' on' : ''}`}>
            <input type="checkbox" checked={value.includes(code)} disabled={disabled} onChange={() => toggle(code)} />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}

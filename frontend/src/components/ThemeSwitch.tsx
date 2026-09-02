import { useState } from 'react';
import { getThemeChoice, setThemeChoice, ThemeChoice } from '../lib/theme';
import { Icon, IconName } from './Icon';

const OPTIONS: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
  { value: 'system', label: 'Как в системе', icon: 'monitor' },
];

/**
 * Выбор темы: три состояния, «как в системе» — полноценный вариант, а не отсутствие выбора.
 *
 * В меню под аватаром переключатель стоит значками — там тесно и рядом подпись пункта.
 * В личном кабинете места достаточно, и варианты подписаны: значок солнца сам по себе
 * не говорит, включена тема или предлагается включить.
 */
export function ThemeSwitch({ labels = false }: { labels?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice());

  const pick = (value: ThemeChoice) => {
    setChoice(value);
    setThemeChoice(value);
  };

  return (
    <div className={`theme-switch${labels ? ' theme-switch-wide' : ''}`} role="group" aria-label="Тема оформления">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          className={`theme-option ${choice === o.value ? 'active' : ''}`}
          onClick={() => pick(o.value)}
          title={o.label}
          aria-pressed={choice === o.value}
        >
          <Icon name={o.icon} size={15} />
          {labels && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

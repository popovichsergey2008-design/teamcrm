export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'teamcrm.theme';

/**
 * Тема оформления. Три состояния, а не два: «как в системе» — это отдельный выбор,
 * иначе человек, работающий по расписанию светлая/тёмная, вынужден переключать руками.
 * Явный выбор записывается в data-theme и перебивает системную настройку.
 */
export function getThemeChoice(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  applyTheme(choice);
}

/** Вызывается до отрисовки, чтобы не мигало светлым при тёмной теме. */
export function initTheme(): void {
  applyTheme(getThemeChoice());
}

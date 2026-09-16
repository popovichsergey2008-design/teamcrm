import { useEffect } from 'react';

/**
 * Закрыть всплывашку щелчком мимо неё или клавишей Esc.
 *
 * Живая жалоба: «невозможно закрыть эти выпадашки без перезагрузки». Каждое такое
 * окошко писалось отдельно, и закрытие в них то забывали, то делали по-своему —
 * участники задачи, история, закреплённое, выбор доски. Поэтому правило одно и
 * общее, а не по копии в каждом месте.
 *
 * Как это работает:
 *
 * 1. Слушаем `mousedown`, а не `click`: щелчок по кнопке внутри чужой всплывашки
 *    успевает сработать до её закрытия, и действие не теряется.
 * 2. Всплывашку помечаем `data-pop` — щелчок внутри неё закрытием не считается.
 * 3. `ignore` — кнопка, которая всплывашку открыла: она сама переключает своё
 *    состояние, и если закрыть её здесь, то повторное нажатие тут же откроет окно
 *    заново («не закрывается»).
 * 4. Подписываемся через таймер: тот же щелчок, что открыл окно, не должен его
 *    сразу закрыть.
 */
export function useDismiss(open: boolean, close: () => void, ignore?: string): void {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-pop]')) return;
      if (ignore && el?.closest(ignore)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ignore]);
}

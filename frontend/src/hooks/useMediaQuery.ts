import { useEffect, useState } from 'react';

/** Живое значение медиа-запроса: меняется при повороте телефона и изменении окна. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Телефон — узкий экран (ТЗ-9, волна 1).
 *
 * Порог общий с CSS (`--phone-max` = 720px): ниже него панель разделов заменяется
 * нижними вкладками, окна поверх страницы становятся полноэкранными листами, а
 * таблицы — карточками. Один порог на код и стили — иначе однажды кнопка появится,
 * а место под неё нет.
 */
export const PHONE_MAX_PX = 720;
export function useIsPhone(): boolean {
  return useMediaQuery(`(max-width: ${PHONE_MAX_PX}px)`);
}
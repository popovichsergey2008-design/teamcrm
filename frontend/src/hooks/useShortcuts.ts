import { useEffect, useRef } from 'react';
import type { Section } from '../lib/router';

/**
 * Горячие клавиши приложения.
 *
 * Требование ТЗ — любое действие за один шорткат. Переходы сделаны аккордом
 * «G, затем буква раздела», как в почте и трекерах: одиночные буквы под переходы
 * отдавать нельзя, их слишком мало, а понадобятся они и в других местах.
 *
 * Раскладка учитывается: человек не переключает язык ради шортката, поэтому
 * рядом с латинской буквой всегда стоит та, что физически на той же клавише.
 */

/** Через сколько аккорд «G + буква» перестаёт ждать вторую клавишу. */
const CHORD_MS = 1200;

const GO: Record<string, Section> = {
  f: 'focus', а: 'focus',
  p: 'projects', з: 'projects',
  c: 'chat', с: 'chat',
  r: 'radar', к: 'radar',
  s: 'settings', ы: 'settings',
};

const isTyping = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
};

export function useShortcuts(enabled: boolean, actions: {
  newTask: () => void;
  /** #4807 §2: V — поставить задачу голосом. */
  voice?: () => void;
  palette: () => void;
  help: () => void;
  toggleSidebar: () => void;
  go: (section: Section) => void;
}) {
  // экшены меняются на каждый рендер — держим их в ссылке, чтобы не пересобирать слушатель
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    if (!enabled) return;
    let chordAt = 0;

    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      const key = e.key.toLowerCase();

      // Ctrl/Cmd+K работает даже из поля ввода: это выход из любого места
      if ((e.ctrlKey || e.metaKey) && key === 'k') {
        e.preventDefault();
        a.palette();
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      // вторая клавиша аккорда
      if (chordAt && Date.now() - chordAt < CHORD_MS) {
        chordAt = 0;
        const section = GO[key];
        if (section) { e.preventDefault(); a.go(section); return; }
      }

      if (key === 'g' || key === 'п') { chordAt = Date.now(); return; }
      if (key === 'c' || key === 'с') { e.preventDefault(); a.newTask(); return; }
      if ((key === 'v' || key === 'м') && a.voice) { e.preventDefault(); a.voice(); return; }
      // #4807 §2: на доске «/» — поиск по этой доске, F — фильтры; в остальных разделах — как раньше
      const boardSearch = shown<HTMLInputElement>('.bb-search-input');
      if ((key === '/' || key === '.') && boardSearch) { e.preventDefault(); boardSearch.focus(); return; }
      if (key === 'f' || key === 'а') {
        const filters = shown<HTMLButtonElement>('.bb-filters-btn');
        if (filters) { e.preventDefault(); filters.click(); return; }
      }
      if (key === '/' || key === '.') { e.preventDefault(); a.palette(); return; }
      if (key === '?' || (e.shiftKey && key === '7')) { e.preventDefault(); a.help(); return; }
      if (key === '[' || key === 'х') { e.preventDefault(); a.toggleSidebar(); }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Элемент на экране (не в скрытом разделе): доска живёт в фоне под другими разделами. */
function shown<T extends HTMLElement>(selector: string): T | null {
  const el = document.querySelector<T>(selector);
  return el && el.offsetParent !== null ? el : null;
}

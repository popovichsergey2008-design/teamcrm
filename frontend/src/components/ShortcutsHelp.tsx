import { useEffect } from 'react';
import { Icon } from './Icon';

/**
 * Подсказка по клавишам (открывается по «?»).
 *
 * Шорткаты, о которых нельзя узнать, не существуют: человек продолжает кликать
 * мышью и не замечает, что интерфейс задумывался быстрым.
 */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Действия',
    rows: [
      ['C', 'Новая задача'],
      ['Ctrl + K  /  /', 'Поиск и команды'],
      ['?', 'Эта подсказка'],
      ['Esc', 'Закрыть окно'],
    ],
  },
  {
    title: 'Переходы',
    rows: [
      ['G затем F', 'Фокус дня'],
      ['G затем P', 'Проекты и доски'],
      ['G затем C', 'Чаты & Миты'],
      ['G затем R', 'Пульс команды'],
      ['G затем S', 'Настройки'],
    ],
  },
  {
    title: 'Интерфейс',
    rows: [
      ['[', 'Свернуть или развернуть панель'],
      ['Alt + ←', 'Назад по истории'],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette shortcuts" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Горячие клавиши">
        <div className="palette-input-row">
          <Icon name="help" size={18} />
          <span className="shortcuts-title">Горячие клавиши</span>
          <kbd className="nav-kbd">Esc</kbd>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <div className="palette-group">{g.title}</div>
              {g.rows.map(([keys, what]) => (
                <div key={keys} className="shortcuts-row">
                  <span className="shortcuts-keys">{keys}</span>
                  <span>{what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="palette-foot">
          <span className="muted">Раскладка не важна — работают и русские буквы на тех же клавишах</span>
        </div>
      </div>
    </div>
  );
}

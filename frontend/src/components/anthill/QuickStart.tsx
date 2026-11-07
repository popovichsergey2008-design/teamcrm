import { useState } from 'react';
import { Icon } from '../Icon';
import { QUICK_START } from './quick-start';
import './quick-start.css';

/**
 * Быстрый старт (#1326): десять направлений, подпункты раскрываются по нажатию.
 * Нажатие на подпункт сразу отправляет боту готовую просьбу.
 */
export function QuickStart({ onPick }: { onPick: (prompt: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="qs" aria-label="Быстрый старт">
      <div className="qs-title">С чего начать — выберите, что взять на себя боту</div>
      <ol className="qs-list">
        {QUICK_START.map((g, i) => {
          const on = open === i;
          return (
            <li key={g.title} className={`qs-group${on ? ' is-open' : ''}`}>
              <button type="button" className="qs-head" aria-expanded={on} onClick={() => setOpen(on ? null : i)}>
                <span className="qs-n">{i + 1}</span>
                <Icon name={g.icon} size={15} />
                <span className="qs-name">{g.title}</span>
                <Icon name={on ? 'chevron-up' : 'chevron-down'} size={14} />
              </button>
              {on && (
                <ul className="qs-items">
                  {g.items.map((it) => (
                    <li key={it.label}>
                      <button type="button" className="qs-item" onClick={() => onPick(it.prompt)} title={it.prompt}>
                        {it.label}
                        <Icon name="arrow-right" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <div className="dim qs-note">Действия — письма, встречи, задачи, напоминания — бот сначала покажет на подтверждение.</div>
    </div>
  );
}

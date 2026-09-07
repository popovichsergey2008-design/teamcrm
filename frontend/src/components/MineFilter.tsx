import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { MineMode } from '../lib/board-filter';
import { TASK_VIEWS, taskViewLabel } from '../lib/task-views';

/**
 * «Мои задачи» — один выпадающий фильтр вместо россыпи кнопок в шапке доски.
 *
 * Раньше здесь стояли две кнопки-тумблера и отдельный список постановщиков: три
 * элемента управления ради одного вопроса «чьи задачи показать». В шапке проекта и без
 * них тесно, а на узком экране они переносились на вторую строку.
 *
 * Внутри — те же три ответа, но по одному: что делаю я (включая работу соисполнителем),
 * что я поручил другим, и что поручил конкретный человек.
 */
export function MineFilter({ mode, creatorId, creators, count, inWorkOnly, onChange }: {
  mode: MineMode;
  creatorId: string;
  /** Кто ставил задачи на этой доске: список строится по ней, а не по всей команде. */
  creators: [string, string][];
  /** Сколько задач видно при текущем выборе — рядом с названием, как счётчик. */
  count: number;
  /** «Только в работе»: скрыть завершённые карточки. */
  inWorkOnly: boolean;
  onChange: (next: { mode: MineMode; creatorId: string; inWorkOnly: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const active = mode !== 'off' || !!creatorId || inWorkOnly;
  const creatorName = creators.find(([id]) => id === creatorId)?.[1];
  const label = creatorName ? `Поставил ${creatorName}`
    : mode === 'both' ? 'Вся моя работа'
      : taskViewLabel(mode) || 'Мои задачи';

  /** Выбор — переключатель: повторное нажатие на активный пункт снимает фильтр. */
  const pick = (next: MineMode) => {
    onChange({ mode: next === mode ? 'off' : next, creatorId: '', inWorkOnly });
    setOpen(false);
  };

  return (
    <span className="mine-filter" ref={boxRef}>
      <button
        className={`view-btn mine-toggle ${active ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Показать только свои задачи или задачи конкретного постановщика"
      >
        <Icon name="user" size={14} /> {label}
        {active && <span className="view-count">{count}</span>}
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <div className="mine-filter-pop" role="menu" aria-label="Чьи задачи показать">
          {/* Виды задач — те же четыре слова, что и в разделе «Задачи». */}
          {TASK_VIEWS.map((v) => (
            <button
              key={v.key}
              className={`mine-filter-item ${mode === v.key ? 'active' : ''}`}
              onClick={() => pick(v.key)}
            >
              <Icon name={v.icon} size={14} /> {v.label}
              <span className="dim">{v.hint}</span>
            </button>
          ))}
          <button className={`mine-filter-item ${mode === 'both' ? 'active' : ''}`} onClick={() => pick('both')}>
            <Icon name="board" size={14} /> Вся моя работа
            <span className="dim">делаю, помогаю и поручил вместе</span>
          </button>

          {/*
            «Только в работе» — не вид, а состояние, поэтому стоит отдельно и работает
            вместе с любым видом. На доске он выключен по умолчанию: колонка «Готово»
            и есть смысл доски, и прятать её содержимое без спроса нельзя.
          */}
          <label className="mine-filter-switch">
            <input
              type="checkbox"
              checked={inWorkOnly}
              onChange={(e) => onChange({ mode, creatorId, inWorkOnly: e.target.checked })}
            />
            Только в работе
            <span className="dim">скрыть завершённые</span>
          </label>

          {creators.length > 0 && (
            <>
              <div className="mine-filter-head">Кто поставил</div>
              <div className="mine-filter-list">
                {creators.map(([id, name]) => (
                  <button
                    key={id}
                    className={`mine-filter-item ${creatorId === id ? 'active' : ''}`}
                    onClick={() => {
                      // выбор человека — отдельный вопрос: роли при этом сбрасываем,
                      // иначе «мне» и «поставил Сергей» дают пустой экран и загадку
                      onChange({ mode: 'off', creatorId: creatorId === id ? '' : id, inWorkOnly });
                      setOpen(false);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}

          {active && (
            <button className="mine-filter-reset" onClick={() => { onChange({ mode: 'off', creatorId: '', inWorkOnly: false }); setOpen(false); }}>
              Показать все задачи
            </button>
          )}
        </div>
      )}
    </span>
  );
}

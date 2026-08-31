import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { PeoplePicker } from './PeoplePicker';

/**
 * «Пригласить сотрудника» — прямо из идущего созвона.
 *
 * Раньше состав собирали ДО звонка, в панели: приходилось заранее знать, кто нужен,
 * а на деле это выясняется по ходу разговора — «позови ещё Петра, он в курсе».
 * Поэтому кнопка живёт здесь, в шапке созвона, рядом со ссылкой для внешнего гостя:
 * два способа позвать человека стоят вместе.
 *
 * Список людей — общий с остальными местами, откуда зовут в разговор: одно действие
 * должно выглядеть одинаково, где бы человек его ни делал.
 */
export function CallInvite({ present, onInvite }: {
  /** Кто уже в комнате: их не показываем — звать того, кто на связи, незачем. */
  present: string[];
  onInvite: (userIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Отметить или снять сразу всех: на планёрку зовут команду, а не по одному. */
  const setAll = (ids: string[], selected: boolean) => setChosen((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
    return next;
  });

  const send = () => {
    if (!chosen.size) return;
    onInvite([...chosen]);
    setNote(`Позвали: ${chosen.size}. Им сейчас звонит телефон.`);
    setChosen(new Set());
    setOpen(false);
    setTimeout(() => setNote(''), 4000);
  };

  return (
    <span className="call-invite" ref={boxRef}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Позвать сотрудника в этот созвон"
      >
        <Icon name="user-plus" size={15} /> Пригласить сотрудника
      </button>

      {note && <span className="dim call-invite-note">{note}</span>}

      {open && (
        <div className="call-invite-pop" role="dialog" aria-label="Кого позвать в созвон">
          <div className="call-starter-head">Кого зовём</div>

          <PeoplePicker
            exclude={present}
            chosen={chosen}
            onToggle={toggle}
            onSetAll={setAll}
            emptyHint="Звать больше некого — вся команда уже на связи."
          />

          <button className="btn btn-primary btn-sm call-starter-go" onClick={send} disabled={!chosen.size}>
            <Icon name="phone" size={14} /> Позвать{chosen.size > 0 ? ` · ${chosen.size}` : ''}
          </button>
        </div>
      )}
    </span>
  );
}

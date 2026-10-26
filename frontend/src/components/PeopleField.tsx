import { Icon } from './Icon';
import { Field } from './ui/field';
import { Select } from './ui/select';

export interface PersonOption { id: string; name: string }

/**
 * Люди в задаче: выбранные плашками с крестиком и «+ добавить» под ними.
 *
 * Одним компонентом для соисполнителей и наблюдателей и для всех мест, где их
 * выбирают: в открытой карточке (TaskDrawer), в первом окне постановки и в форме
 * «Новая задача» (#4661). Соисполнители и наблюдатели отличаются смыслом, а не
 * устройством, и два почти одинаковых блока разошлись бы на первой же правке.
 */
export function PeopleField({ label, hint, people, users, exclude, onAdd, onRemove, disabled }: {
  label: string;
  hint: string;
  /** Кто уже выбран. */
  people: PersonOption[];
  /** Из кого выбирать. */
  users: PersonOption[];
  /** Кого не предлагать вовсе: например, исполнителя в соисполнители. */
  exclude?: string[];
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
  disabled?: boolean;
}) {
  const taken = new Set([...people.map((p) => String(p.id)), ...(exclude ?? []).map(String)]);
  return (
    <Field label={<span title={hint}>{label}</span>}>
      {people.length > 0 && (
        <div className="people-chips">
          {people.map((p) => (
            <span key={p.id} className="people-chip">
              {p.name}
              <button
                type="button"
                className="people-chip-x"
                onClick={() => onRemove(String(p.id))}
                disabled={disabled}
                title="Убрать из задачи"
                aria-label={`Убрать ${p.name}`}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Значение всегда пустое: выбранный сразу уходит в список выше, поле снова «+ добавить». */}
      <Select
        ariaLabel={`Добавить: ${label.toLowerCase()}`}
        className="tv2-wide"
        value=""
        disabled={disabled}
        onValueChange={(v) => { if (v) onAdd(v); }}
        options={[
          { value: '', label: '+ добавить' },
          ...users.filter((u) => !taken.has(String(u.id))).map((u) => ({ value: String(u.id), label: u.name })),
        ]}
      />
    </Field>
  );
}

/** Выбранные id → плашки с именами; незнакомый id (человек ушёл из списка) не показываем. */
export function peopleOf(ids: string[] | undefined, users: PersonOption[]): PersonOption[] {
  const byId = new Map(users.map((u) => [String(u.id), u]));
  return (ids ?? []).map((id) => byId.get(String(id))).filter((u): u is PersonOption => !!u);
}

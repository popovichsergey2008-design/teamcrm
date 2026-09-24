import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, TagItem, TagSettings, TagSuggestion } from '../lib/api';
import { labelTextColor } from '../lib/labels';
import { tagsReady, TagsValue } from '../lib/tags';

/**
 * Теги задачи перед её созданием — с подсказками ИИ и подтверждением человека
 * (ТЗ «Теги задач + автоматическая AI-разметка»).
 *
 * Зачем подтверждение. Проставленный моделью тег, которого никто не видел, хуже, чем
 * отсутствие тегов: через месяц в фильтре стоят метки, за которые никто не отвечает,
 * доверия к ним нет — и фильтром перестают пользоваться. Поэтому ИИ делает черновую
 * работу, а последнее слово за постановщиком: он подтверждает набор либо сознательно
 * говорит «без тегов». До этого задача не создаётся — и так же считает сервер.
 *
 * Подсказки просим не на каждую букву (это и дорого, и список прыгает под руками), а
 * когда человек дописал название и перестал печатать. Молчание модели работу не
 * останавливает: теги выбираются руками.
 */
export function TaskTagsField({ task, value, onChange, compact, mode = 'create' }: {
  /** Из чего подбирать: название, описание, шаги, проект. */
  task: { title: string; description?: string; checklist?: string[]; projectName?: string | null };
  value: TagsValue;
  onChange: (next: TagsValue) => void;
  /** Плотный вид — для списка черновиков в быстрой команде. */
  compact?: boolean;
  /**
   * `create` — задача ещё не создана: ИИ подбирает сам, подтверждение обязательно.
   * `edit` — задача живёт: теги молча не меняем (ТЗ, п. 39), подбор только по кнопке.
   */
  mode?: 'create' | 'edit';
}) {
  const [all, setAll] = useState<TagItem[]>([]);
  const [settings, setSettings] = useState<TagSettings | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [maybe, setMaybe] = useState<TagSuggestion[]>([]);
  const [proposed, setProposed] = useState<string | null>(null);
  const [similar, setSimilar] = useState<{ tag: TagItem; name: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  /** По какому тексту уже спрашивали: дёргать модель за то же самое — впустую. */
  const askedFor = useRef('');

  useEffect(() => {
    api.listTags()
      .then((r) => { setAll(r.items); setSettings(r.settings); })
      .catch(() => setSettings({ aiTagging: false, requireConfirmation: false, whoCanCreate: 'all' }));
  }, []);

  const ask = useCallback(async () => {
    const title = task.title.trim();
    if (title.length < 3) return;
    const key = `${title}|${(task.description ?? '').slice(0, 200)}`;
    if (askedFor.current === key) return;
    askedFor.current = key;
    setAsking(true); setErr('');
    try {
      const r = await api.suggestTags({
        title,
        description: task.description,
        checklist: task.checklist,
        projectName: task.projectName ?? undefined,
      });
      setSuggestions(r.suggestions);
      setMaybe(r.maybe);
      setProposed(r.proposed);
      // Уверенные подсказки подставляем сразу, но как ПРЕДЛОЖЕНИЕ: подтверждает человек.
      const add = r.suggestions.map((s) => s.tagId).filter((id) => !value.tagIds.includes(id));
      if (add.length) {
        onChange({
          ...value,
          tagIds: [...value.tagIds, ...add],
          suggested: [...new Set([...value.suggested, ...add])],
          confirmed: false,
        });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Подсказки не пришли — выберите теги сами');
    } finally {
      setAsking(false);
    }
  }, [task.title, task.description, task.checklist, task.projectName, value, onChange]);

  useEffect(() => {
    // В живой задаче подсказки сами не приходят: переписал название — и теги вдруг
    // другие, а человек этого не просил. Там подбор только по кнопке.
    if (!settings?.aiTagging || mode !== 'create') return;
    const timer = window.setTimeout(() => { void ask(); }, 3000);
    return () => window.clearTimeout(timer);
  }, [settings?.aiTagging, mode, task.title, task.description, ask]);

  const byId = new Map(all.map((t) => [String(t.id), t]));
  const chosen = value.tagIds.map((id) => byId.get(id)).filter((t): t is TagItem => !!t);
  const canCreate = settings ? settings.whoCanCreate !== 'admins' : false;
  const ready = tagsReady(settings, value);
  const gated = mode === 'create' && !!settings?.aiTagging && settings.requireConfirmation;
  const visible = all.filter((t) => !t.archived_at && t.name.toLowerCase().includes(query.trim().toLowerCase()));

  /** Любая правка набора снимает подтверждение: подтверждали не это. */
  const toggle = (id: string) => {
    const has = value.tagIds.includes(id);
    onChange({
      ...value,
      tagIds: has ? value.tagIds.filter((x) => x !== id) : [...value.tagIds, id],
      confirmed: false,
      confirmedWithoutTags: false,
    });
  };

  const createTag = async (name: string, force = false) => {
    setErr('');
    try {
      const tag = await api.createTag({ name, force });
      setAll((prev) => [...prev, tag]);
      setQuery('');
      setSimilar(null);
      onChange({ ...value, tagIds: [...value.tagIds, String(tag.id)], confirmed: false, confirmedWithoutTags: false });
    } catch (e) {
      /*
        «Похожий тег уже есть» — не ошибка, а развилка: взять существующий или
        настоять на своём. Без этой развилки в компании заводятся «SEO», «seo» и
        «СЕО», и фильтр по тегу перестаёт что-либо значить.
      */
      const details = e instanceof ApiError ? (e.details as { similar?: TagItem } | undefined) : undefined;
      const found = details?.similar;
      if (found) {
        setSimilar({ tag: found, name });
        setErr(`Похожий тег уже есть: «${found.name}»`);
        return;
      }
      setErr(e instanceof ApiError ? e.message : 'Тег не создался');
    }
  };

  return (
    <div className={`tags-field${compact ? ' tags-compact' : ''}`}>
      <div className="tags-head">
        <label>Теги</label>
        {settings?.aiTagging && (
          <span className="dim tags-ai-note">{asking ? 'ИИ подбирает теги…' : 'ИИ подбирает, подтверждаете вы'}</span>
        )}
      </div>

      <div className="tags-chips">
        {chosen.map((t) => {
          const fromAi = value.suggested.includes(String(t.id)) && !value.confirmed;
          return (
            <span
              key={t.id}
              className={`label-chip${fromAi ? ' tag-ai' : ''}`}
              style={{ background: t.color, color: labelTextColor(t.color) }}
              title={fromAi ? 'Предложил ИИ — подтвердите или уберите' : undefined}
            >
              {fromAi && <Icon name="sparkles" size={11} />}
              {t.name}
              <button
                className="tag-chip-x"
                onClick={() => toggle(String(t.id))}
                title="Убрать тег"
                aria-label={`Убрать тег ${t.name}`}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          );
        })}
        <button className="btn btn-ghost btn-sm" onClick={() => setPickOpen(!pickOpen)}>
          <Icon name="plus" size={13} /> тег
        </button>
        {mode === 'edit' && settings?.aiTagging && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { askedFor.current = ''; void ask(); }}
            disabled={asking}
            title="Пересобрать подсказки по текущему тексту задачи"
          >
            <Icon name="sparkles" size={13} /> {asking ? 'Подбираю…' : 'Подобрать теги'}
          </button>
        )}
      </div>

      {/* Неуверенные подсказки — отдельно и невыбранными: «возможно подходит» (ТЗ, п. 28). */}
      {maybe.length > 0 && !value.confirmed && (
        <div className="tags-maybe">
          <span className="dim">Возможно подходит:</span>
          {maybe.filter((m) => !value.tagIds.includes(m.tagId)).map((m) => (
            <button
              key={m.tagId}
              className="label-chip label-off"
              style={{ borderColor: m.color }}
              onClick={() => onChange({
                ...value,
                tagIds: [...value.tagIds, m.tagId],
                suggested: [...new Set([...value.suggested, m.tagId])],
                confirmed: false,
              })}
            >
              + {m.name}
            </button>
          ))}
        </div>
      )}

      {pickOpen && (
        <div className="label-pick tags-pick">
          <input
            className="input input-sm"
            placeholder="Поиск тега…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSimilar(null); }}
          />
          <div className="tags-pick-list">
            {visible.map((t) => {
              const has = value.tagIds.includes(String(t.id));
              return (
                <button
                  key={t.id}
                  className={`label-chip ${has ? '' : 'label-off'}`}
                  style={{
                    background: has ? t.color : 'transparent',
                    borderColor: t.color,
                    color: has ? labelTextColor(t.color) : undefined,
                  }}
                  onClick={() => toggle(String(t.id))}
                >
                  {t.name}
                </button>
              );
            })}
            {!visible.length && <span className="dim">Ничего не найдено</span>}
          </div>
          {query.trim().length >= 2 && canCreate && !similar && (
            <button className="btn btn-sm" onClick={() => void createTag(query.trim())}>
              <Icon name="plus" size={13} /> Создать тег «{query.trim()}»
            </button>
          )}
          {similar && (
            <div className="tags-similar">
              <button className="btn btn-sm" onClick={() => { toggle(String(similar.tag.id)); setSimilar(null); setErr(''); }}>
                Использовать «{similar.tag.name}»
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void createTag(similar.name, true)}>
                Всё равно создать новый
              </button>
            </div>
          )}
        </div>
      )}

      {/* Модель предложила НАЗВАНИЕ нового тега: завести его может только человек (ТЗ, п. 25). */}
      {proposed && canCreate && !value.confirmed && (
        <div className="dim tags-proposed">
          ИИ предлагает новый тег «{proposed}».{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => void createTag(proposed)}>Создать</button>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {gated && !ready && (
        <div className="tags-confirm">
          {value.tagIds.length > 0 ? (
            <button className="btn btn-sm" onClick={() => onChange({ ...value, confirmed: true, confirmedWithoutTags: false })}>
              <Icon name="check" size={13} /> Подтвердить теги{suggestions.length ? ` (${value.tagIds.length})` : ''}
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => onChange({ ...value, confirmed: false, confirmedWithoutTags: true })}>
              <Icon name="check" size={13} /> Подтвердить без тегов
            </button>
          )}
          <span className="dim">Без этого задача не создаётся</span>
        </div>
      )}
      {gated && ready && (
        <div className="dim tags-ok">
          <Icon name="check" size={12} /> {value.confirmedWithoutTags ? 'Без тегов — подтверждено' : 'Теги подтверждены'}
        </div>
      )}
    </div>
  );
}

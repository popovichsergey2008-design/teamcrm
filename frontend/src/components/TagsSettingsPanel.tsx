import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { EmptyState } from './EmptyState';
import { api, ApiError, TagItem, TagSettings } from '../lib/api';
import { labelTextColor } from '../lib/labels';
import { useEscape } from '../hooks/useEscape';

/** Цвета тегов: различимые между собой и читаемые с белым или тёмным текстом. */
const PALETTE = ['#2f5fbf', '#2f7d5d', '#7c4dbf', '#a35a10', '#b03a48', '#55606f', '#146b73', '#8a6d00'];

/**
 * Теги компании — управление списком (ТЗ «Теги задач», п. 14).
 *
 * Здесь видно то, чего не видно в задаче: сколько задач помечено тегом, какие теги
 * базовые, какие завела компания и что уже в архиве. Удаления нет намеренно: тег,
 * которым размечены сто задач, нельзя стереть — вместе с ним исчезнет смысл этих ста
 * задач. Есть архив: тег остаётся там, где стоял, но не предлагается в новых.
 */
export function TagsSettingsPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [items, setItems] = useState<TagItem[]>([]);
  const [settings, setSettings] = useState<TagSettings | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; color: string; aiDescription: string }>({
    name: '', color: PALETTE[0], aiDescription: '',
  });

  const reload = () => {
    api.listTags(true)
      .then((r) => { setItems(r.items); setSettings(r.settings); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Теги не загрузились'));
  };
  useEffect(reload, []);

  const saveSettings = async (patch: Partial<TagSettings>) => {
    setErr('');
    try { setSettings(await api.saveTagSettings(patch)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Настройка не сохранилась'); }
  };

  const create = async (force = false) => {
    const value = name.trim();
    if (value.length < 2) return;
    setErr('');
    try {
      await api.createTag({ name: value, color: PALETTE[items.length % PALETTE.length], force });
      setName('');
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Тег не создался'); }
  };

  const save = async (id: string) => {
    setErr('');
    try {
      await api.updateTag(id, { name: draft.name.trim(), color: draft.color, aiDescription: draft.aiDescription });
      setEditing(null);
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Правка не сохранилась'); }
  };

  const archive = async (tag: TagItem) => {
    setErr('');
    try {
      if (tag.archived_at) await api.restoreTag(String(tag.id)); else await api.archiveTag(String(tag.id));
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const visible = items.filter((t) => (showArchived ? true : !t.archived_at));

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="tag" size={18} /> Теги задач</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="dim" style={{ fontSize: 12 }}>
          Теги — своя классификация компании: по ним фильтруют список задач. Пять базовых
          есть у всех, остальное вы добавляете под свою работу.
        </div>

        {settings && (
          <div className="drawer-section">
            <div className="drawer-section-title">Разметка через ИИ</div>
            <label className="notify-row" style={{ cursor: canManage ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                checked={settings.aiTagging}
                disabled={!canManage}
                onChange={(e) => void saveSettings({ aiTagging: e.target.checked })}
              />
              <span>
                Автоматически подбирать теги через Anthill AI
                <span className="dim" style={{ display: 'block', fontSize: 12 }}>
                  ИИ предлагает теги по тексту задачи. Пока предложения не подтвердит постановщик,
                  задача не создаётся — молча проставленный тег хуже, чем его отсутствие.
                </span>
              </span>
            </label>

            <div className="field">
              <label>Кто может заводить новые теги</label>
              <select
                className="input"
                value={settings.whoCanCreate}
                disabled={!canManage}
                onChange={(e) => void saveSettings({ whoCanCreate: e.target.value as TagSettings['whoCanCreate'] })}
              >
                <option value="all">Все сотрудники</option>
                <option value="managers">Руководители</option>
                <option value="admins">Только владелец</option>
              </select>
              <span className="dim" style={{ fontSize: 12 }}>
                Ограничение спасает от «SEO», «seo» и «СЕО» в одном списке.
              </span>
            </div>
          </div>
        )}

        {canManage && (
          <div className="drawer-section">
            <div className="drawer-section-title">Новый тег</div>
            <div className="team-rate">
              <input
                className="input"
                placeholder="название тега"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
              />
              <button className="btn btn-sm" onClick={() => void create()}>Добавить</button>
            </div>
            {err && (
              <div className="error-text">
                {err}
                {err.startsWith('Похожий тег') && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void create(true)}>
                    Всё равно создать
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="drawer-section">
          <div className="drawer-section-title">
            Список ({visible.length})
            <button className="btn btn-ghost btn-sm" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Скрыть архив' : 'Показать архив'}
            </button>
          </div>

          {!visible.length && <EmptyState compact icon="tag" title="Тегов нет" hint="Добавьте первый — он сразу появится в задачах." />}

          {visible.map((t) => (
            <div key={t.id} className={`tag-row${t.archived_at ? ' tag-archived' : ''}`}>
              {editing === String(t.id) ? (
                <>
                  <input className="input input-sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  <div className="tags-chips">
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        className={`tag-color${draft.color === c ? ' on' : ''}`}
                        style={{ background: c }}
                        onClick={() => setDraft({ ...draft, color: c })}
                        title={`Цвет ${c}`}
                        aria-label={`Цвет ${c}`}
                      />
                    ))}
                  </div>
                  <input
                    className="input input-sm"
                    placeholder="когда применять — подсказка для ИИ"
                    value={draft.aiDescription}
                    onChange={(e) => setDraft({ ...draft, aiDescription: e.target.value })}
                  />
                  <div className="tags-chips">
                    <button className="btn btn-sm" onClick={() => void save(String(t.id))}>Сохранить</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Отмена</button>
                  </div>
                </>
              ) : (
                <>
                  <span className="label-chip" style={{ background: t.color, color: labelTextColor(t.color) }}>{t.name}</span>
                  <span className="dim tag-row-sub">
                    {t.is_default ? 'базовый' : 'свой'} · задач: {t.used ?? 0}
                    {t.archived_at ? ' · в архиве' : ''}
                  </span>
                  {canManage && (
                    <span className="tag-row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(String(t.id));
                          setDraft({ name: t.name, color: t.color, aiDescription: t.ai_description ?? '' });
                        }}
                      >
                        Изменить
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void archive(t)}>
                        {t.archived_at ? 'Вернуть' : 'В архив'}
                      </button>
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

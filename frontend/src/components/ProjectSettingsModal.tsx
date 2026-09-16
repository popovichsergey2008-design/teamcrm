import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { PROJECTS_CHANGED } from './ProjectsNav';

/**
 * Настройки проекта.
 *
 * Здесь живёт то, что относится к доске целиком, а не к отдельной задаче. Первое —
 * место доски в списке: после импорта из YouGile и Битрикса свои доски тонут среди
 * десятков чужих.
 *
 * Почему не в левой панели, где это было сначала: панель — это переход между
 * досками, а не место, где их настраивают. Заказчик сказал ровно это.
 */
export function ProjectSettingsModal({ project, onClose, onChanged }: {
  project: {
    id: string; name: string; is_default?: boolean; is_support?: boolean;
    owner_user_id?: string | null; visibility?: string;
  };
  onClose: () => void;
  onChanged: () => void;
}) {
  useEscape(onClose);
  /** Название правится здесь: раньше переименовать проект было нельзя вовсе. */
  const [name, setName] = useState(project.name);
  /** all — видят все сотрудники; members — только участники и руководство. */
  const [visibility, setVisibility] = useState(project.visibility === 'members' ? 'members' : 'all');
  const [members, setMembers] = useState<{ user_id: string; full_name: string }[]>([]);

  useEffect(() => {
    if (visibility !== 'members') return;
    api.projectMembers(String(project.id)).then(setMembers).catch(() => undefined);
  }, [visibility, project.id]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === project.name) return;
    setErr(''); setDone(''); setBusy(true);
    try {
      await api.updateProject(String(project.id), { name: next });
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone('Название изменено');
    } catch (e) {
      setName(project.name);
      setErr(e instanceof ApiError ? e.message : 'Не удалось переименовать');
    } finally { setBusy(false); }
  };

  /*
    Видимость — не переключатель «на всякий случай».

    «Только свои» закрывает доску от остальной команды: список её не покажет и по
    прямой ссылке она не откроется. Поэтому при закрытии сразу говорим, кто внутри:
    люди, у которых в проекте есть задачи, попадают в список автоматически.
  */
  const changeVisibility = async (next: 'all' | 'members') => {
    const prev = visibility;
    setErr(''); setDone(''); setBusy(true);
    setVisibility(next);
    try {
      await api.updateProject(String(project.id), { visibility: next });
      if (next === 'members') setMembers(await api.projectMembers(String(project.id)));
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone(next === 'members'
        ? 'Проект виден только участникам — те, у кого здесь есть задачи, уже внутри'
        : 'Проект снова виден всей команде');
    } catch (e) {
      setVisibility(prev);
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить видимость');
    } finally { setBusy(false); }
  };

  const addMember = async (userId: string) => {
    if (!userId) return;
    setErr(''); setBusy(true);
    try { setMembers(await api.addProjectMembers(String(project.id), [userId])); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось добавить'); }
    finally { setBusy(false); }
  };

  const dropMember = async (userId: string) => {
    setErr(''); setBusy(true);
    try { setMembers(await api.removeProjectMember(String(project.id), userId)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось убрать'); }
    finally { setBusy(false); }
  };
  const [isDefault, setIsDefault] = useState(project.is_default === true);
  const [isSupport, setIsSupport] = useState(project.is_support === true);
  /** Ответственный за проект: один человек, к которому идут с вопросами «что по проекту». */
  const [owner, setOwner] = useState(project.owner_user_id ? String(project.owner_user_id) : '');
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  useEffect(() => { api.listUsers().then((u) => setPeople(u.filter((x: any) => x.isActive !== false))).catch(() => undefined); }, []);
  const changeOwner = async (userId: string) => {
    setErr(''); setDone(''); setBusy(true);
    const prev = owner;
    setOwner(userId);
    try {
      await api.setProjectOwner(String(project.id), userId || null);
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone(userId ? 'Ответственный назначен — виден в шапке чата проекта' : 'Ответственный снят');
    } catch (e) {
      setOwner(prev);
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить');
    } finally { setBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  /** Изменения применяются сразу: это переключатель, а не форма с сохранением. */
  const toggleDefault = async (next: boolean) => {
    setErr(''); setDone(''); setBusy(true);
    setIsDefault(next); // отклик мгновенный, откатим при ошибке
    try {
      await api.setProjectDefault(String(project.id), next);
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone(next ? 'Доска будет первой в списке' : 'Доска убрана из основных');
    } catch (e) {
      setIsDefault(!next);
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить');
    } finally { setBusy(false); }
  };

  /** Сюда падают обращения из кнопки «Поддержка». Один проект на компанию. */
  const toggleSupport = async (next: boolean) => {
    setErr(''); setDone(''); setBusy(true);
    setIsSupport(next);
    try {
      await api.setSupportProject(String(project.id), next);
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone(next ? 'Обращения из «Поддержки» будут попадать в этот проект' : 'Проект больше не принимает обращения');
    } catch (e) {
      setIsSupport(!next);
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить');
    } finally { setBusy(false); }
  };

  const resetOrder = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      await api.resetProjectOrder();
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone('Порядок восстановлен: основные доски наверху, остальные по алфавиту');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось упорядочить');
    } finally { setBusy(false); }
  };

  /**
   * Доски по умолчанию внутри проекта.
   *
   * Проект из YouGile или Битрикса приезжает с чужими колонками, и работа по нему
   * идёт не по тем правилам, что по остальным. Одно нажатие ставит в начало
   * привычный набор; созданное вручную остаётся целым, вместе с задачами, — просто
   * уезжает правее. Доска перестраивается сразу: `onChanged` перечитывает её.
   */
  const addDefaultColumns = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      const res = await api.ensureDefaultColumns(String(project.id));
      onChanged();
      setDone(res.added.length
        ? `Добавлены доски: ${res.added.join(', ')} — они встали первыми`
        : 'Все доски по умолчанию уже были в проекте — они переставлены в начало');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось добавить доски по умолчанию');
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="settings" size={16} /> Настройки проекта · {project.name}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/*
          Название и доступ — первым делом.

          Раньше проект нельзя было ни переименовать, ни закрыть от посторонних:
          опечатка в названии жила вечно, а доска с наймом или деньгами клиента была
          открыта всей компании.
        */}
        <div className="drawer-section">
          <div className="drawer-section-title">Название проекта</div>
          <div className="drawer-row">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }}
              disabled={busy}
              aria-label="Название проекта"
            />
            <button
              className="btn btn-sm"
              onClick={() => void rename()}
              disabled={busy || !name.trim() || name.trim() === project.name}
            >
              Сохранить
            </button>
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Кто видит проект</div>
          <span className="view-switch" role="group" aria-label="Видимость проекта">
            <button
              className={`view-btn ${visibility === 'all' ? 'active' : ''}`}
              onClick={() => void changeVisibility('all')}
              disabled={busy}
            >
              Вся команда
            </button>
            <button
              className={`view-btn ${visibility === 'members' ? 'active' : ''}`}
              onClick={() => void changeVisibility('members')}
              disabled={busy}
            >
              Только участники
            </button>
          </span>
          <p className="dim">
            «Только участники» убирает доску из списков у остальных и закрывает её по прямой
            ссылке. Руководство и ответственный за проект видят её всегда.
          </p>
        </div>

        {visibility === 'members' && (
          <div className="drawer-section">
            <div className="drawer-section-title">Участники проекта</div>
            <div className="project-members">
              {members.map((m) => (
                <span key={m.user_id} className="chip">
                  {m.full_name}
                  <button
                    className="msg-act"
                    onClick={() => void dropMember(m.user_id)}
                    title="Убрать из проекта"
                    aria-label={`Убрать ${m.full_name}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              {!members.length && <span className="dim">Пока никого — добавьте людей ниже.</span>}
            </div>
            <select
              className="input"
              value=""
              onChange={(e) => { void addMember(e.target.value); e.currentTarget.value = ''; }}
              disabled={busy}
              aria-label="Добавить участника проекта"
            >
              <option value="">Добавить участника…</option>
              {people
                .filter((u) => !members.some((m) => String(m.user_id) === String(u.id)))
                .map((u) => <option key={u.id} value={String(u.id)}>{u.fullName}</option>)}
            </select>
          </div>
        )}

        <div className="drawer-section">
          <div className="drawer-section-title">Ответственный</div>
          <select className="input" value={owner} disabled={busy} onChange={(e) => changeOwner(e.target.value)} aria-label="Ответственный за проект">
            <option value="">— не назначен —</option>
            {people.map((u) => <option key={u.id} value={String(u.id)}>{u.fullName}</option>)}
          </select>
          <p className="dim">К нему идут с вопросами «что по проекту»; показывается в шапке чата проекта и в сведениях.</p>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Доски по умолчанию в этом проекте</div>
          <p className="dim">
            Привычный набор — «Новые», «В работе», «На тестировании», «Готово» — встанет
            в начало проекта, перед созданными вручную. Ничего не удаляется и не
            переименовывается: свои доски остаются вместе с задачами, просто уезжают
            правее. Те, что уже есть, второй раз не заводятся.
          </p>
          <button className="btn" onClick={addDefaultColumns} disabled={busy}>
            <Icon name="plus" size={14} /> Добавить доски по умолчанию
          </button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Поддержка</div>
          <label className="notify-row" title="Обращения сотрудников из кнопки «Поддержка» становятся задачами здесь">
            <input type="checkbox" checked={isSupport} disabled={busy} onChange={(e) => toggleSupport(e.target.checked)} />
            Проект поддержки — сюда попадают обращения из кнопки «Поддержка»
          </label>
          <p className="dim">
            Один проект на компанию: отметите здесь — с прежнего пометка снимется. Пока
            ничего не выбрано, первое обращение само заведёт проект «Поддержка».
          </p>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Место в списке досок</div>
          <label className="notify-row" title="Основные доски всегда идут первыми, что бы ни принёс очередной импорт">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={busy}
              onChange={(e) => toggleDefault(e.target.checked)}
            />
            Основная доска компании — всегда первой в списке
          </label>
          <p className="dim">
            Порядок общий для всей компании: доски — общая рабочая поверхность, и «у меня
            по-другому» здесь только мешает договариваться, где что лежит. Переставить
            доски местами можно перетаскиванием в левой панели.
          </p>
        </div>

        <div className="drawer-section">
          {/* Название с уточнением: рядом теперь есть доски ВНУТРИ проекта, и два
              «по умолчанию» на одном экране путают. Здесь — порядок в левой панели. */}
          <div className="drawer-section-title">Порядок проектов в левой панели</div>
          <p className="dim">
            После импорта из YouGile и Битрикса список превращается в кашу: чужие доски
            вперемешку со своими. Одно нажатие возвращает понятный вид. Задачи и сами
            доски при этом не трогаются — меняется только порядок в списке.
          </p>
          <button className="btn" onClick={resetOrder} disabled={busy}>
            <Icon name="list" size={14} /> Восстановить порядок по умолчанию
          </button>
        </div>

        {done && <div className="file-ok"><Icon name="check" size={13} /> {done}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>
    </div>
  );
}

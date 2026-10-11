import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { OptionSelect } from '../ui/option-select';
import { api, ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import type { Project, User } from '../../types';
import './draft-row.css';

/** То, что человек выбрал в строке, но ещё не сохранил: уходит в «Создать» и в пакет. */
export interface DraftChoice { assigneeId?: string; projectId?: string; deadlineAt?: string }

const dateOf = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
/** Дата из поля → конец рабочего дня, как у сроков, названных на встрече. */
const isoOf = (date: string) => (date ? new Date(`${date}T18:00:00`).toISOString() : '');
const stamp = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Черновик задачи со встречи: ИИ услышал поручение так, человек правит и решает.
 *
 * Не путать три роли (ТЗ-22, §12): кто произнёс фразу, кто поставил задачу, кто
 * должен выполнить. Уверенность в исполнителе видна (§14): названный и найденный —
 * просто имя; угаданный — «ИИ предполагает»; не найденный — «выберите».
 */
export function DraftRow({ draft, projects, users, onApply, onReject, onSaved, selected, onSelect, onChoice }: {
  draft: any; projects: Project[]; users: User[];
  onApply: (d: any, patch: DraftChoice) => void;
  onReject: (d: any) => void;
  onSaved: () => void;
  /** выбор для «Создать выбранные» — только на экране итогов */
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onChoice?: (choice: DraftChoice) => void;
}) {
  const [assigneeId, setAssigneeId] = useState(draft.assignee_id ?? '');
  const [projectId, setProjectId] = useState(draft.project_id ?? '');
  const [deadline, setDeadline] = useState(dateOf(draft.deadline_at));
  /**
   * Правка черновика.
   *
   * ИИ слышит имя неточно и сжимает поручение до неузнаваемости — до создания задачи
   * это надо уметь исправить. Иначе остаётся один путь: создать заведомо кривую задачу
   * и переписывать её уже на доске, объясняя исполнителю, что имелось в виду.
   */
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title ?? '');
  const [description, setDescription] = useState(draft.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // выбранное в строке — наверх, чтобы пакет создал задачи с ним, а не с услышанным ИИ
  const choice: DraftChoice = {
    assigneeId: assigneeId !== (draft.assignee_id ?? '') ? assigneeId : undefined,
    projectId: projectId !== (draft.project_id ?? '') ? projectId : undefined,
    deadlineAt: deadline !== dateOf(draft.deadline_at) ? isoOf(deadline) : undefined,
  };
  useEffect(() => { onChoice?.(choice); }, [assigneeId, projectId, deadline]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!title.trim()) return setErr('Название не может быть пустым');
    setBusy(true); setErr('');
    try {
      await api.updateMeetingDraft(draft.id, {
        title: title.trim(),
        description: description.trim() || null,
        assigneeId: assigneeId || null,
        projectId: projectId || null,
        deadlineAt: isoOf(deadline),
      });
      setEditing(false);
      onSaved(); // список перечитывается: человек видит уже исправленную версию
      toastSaved('Изменения сохранены');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  const cancel = () => {
    setTitle(draft.title ?? '');
    setDescription(draft.description ?? '');
    setAssigneeId(draft.assignee_id ?? '');
    setProjectId(draft.project_id ?? '');
    setDeadline(dateOf(draft.deadline_at));
    setEditing(false);
    setErr('');
  };

  const conf = draft.confidence == null ? null : Number(draft.confidence);
  // уверенность — про исполнителя, которого назвал ИИ; выбрал человек — вопрос снят
  const guessed = !!assigneeId && assigneeId === String(draft.assignee_id ?? '') && conf != null && conf < 0.85;
  const sec = draft.source_sec == null ? null : Number(draft.source_sec);
  const author = users.find((u) => String(u.id) === String(draft.author_id ?? ''))?.fullName ?? draft.author_hint ?? null;

  return (
    <div className={`team-row draft-row${draft.status === 'failed' ? ' draft-failed' : ''}`}>
      <div className="draft-top">
        {onSelect && (
          <input
            type="checkbox" className="draft-check" checked={!!selected} onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Создать задачу «${draft.title}»`}
          />
        )}
        <div className="draft-main">
          {editing ? (
            <>
              <input
                className="input" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="Название задачи" aria-label="Название задачи" autoFocus
              />
              <textarea
                className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Описание (необязательно)" aria-label="Описание задачи" style={{ marginTop: 4 }}
              />
            </>
          ) : (
            <>
              <div className="team-head">
                <span>{draft.title}</span>
                {draft.priority === 'urgent' && <span className="ui-badge ui-badge-danger draft-urgent">срочно</span>}
              </div>
              {draft.description && <div className="dim" style={{ fontSize: 12 }}>{draft.description}</div>}
            </>
          )}
        </div>
      </div>

      {draft.quote && (
        // цитата-источник: по ней видно, откуда взялось предложение, и заметно, если ИИ выдумал
        <div className="dim draft-quote">«{draft.quote}»</div>
      )}
      <div className="dim draft-meta">
        {author && <span>Поставил: {author}</span>}
        {draft.source_speaker && draft.source_speaker !== author && <span>Сказал(а): {draft.source_speaker}</span>}
        {sec != null && (
          <button
            className="link-btn" title="Открыть этот момент записи"
            onClick={() => navigate(`/meetings/${encodeURIComponent(String(draft.meeting_id))}?t=${Math.round(sec)}`)}
          >
            <Icon name="play" size={11} /> {stamp(sec)}
          </button>
        )}
      </div>
      {draft.assignee_hint && !assigneeId && (
        <div className="draft-unsure">На встрече прозвучало «{draft.assignee_hint}» — сотрудник не опознан, выберите исполнителя.</div>
      )}
      {!draft.assignee_hint && !assigneeId && <div className="draft-unsure">Исполнитель не определён — выберите.</div>}
      {guessed && <div className="draft-unsure">ИИ предполагает исполнителя — проверьте.</div>}
      {draft.status === 'failed' && draft.error_message && (
        <div className="error-text" style={{ fontSize: 12 }}>Не создалась: {draft.error_message}</div>
      )}
      {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}

      <div className="draft-fields">
        <OptionSelect className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-label="Исполнитель">
          <option value="">— исполнитель —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </OptionSelect>
        <OptionSelect className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Проект">
          <option value="">— проект —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
        <input type="date" className="input" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="Срок" title="Срок" />
      </div>

      <div className="team-rate" style={{ marginTop: 4 }}>
        {editing ? (
          <>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={save} disabled={busy}>Сохранить</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={cancel} disabled={busy}>Отмена</button>
          </>
        ) : (
          <>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onApply(draft, choice)} disabled={busy}>
              {draft.status === 'failed' ? 'Повторить' : 'Создать задачу'}
            </button>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEditing(true)} disabled={busy}>
              <Icon name="edit" size={13} /> Редактировать
            </button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onReject(draft)} disabled={busy}>Не создавать</button>
          </>
        )}
      </div>
    </div>
  );
}

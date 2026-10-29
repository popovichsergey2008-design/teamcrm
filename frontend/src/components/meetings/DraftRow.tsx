import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { DatePicker } from '../DatePicker';
import { OptionSelect } from '../ui/option-select';
import { api, ApiError, type DraftProof, type TagItem } from '../../lib/api';
import { labelTextColor } from '../../lib/labels';
import { AudioClip } from './AudioClip';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import type { Project, User } from '../../types';
import './draft-row.css';

/** То, что человек выбрал в строке, но ещё не сохранил: уходит в «Создать» и в пакет. */
export interface DraftChoice { assigneeId?: string; projectId?: string; deadlineAt?: string }

const dateOf = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
/** Дата из поля → конец рабочего дня, как у сроков, названных на встрече. */
const isoOf = (date: string) => (date ? new Date(`${date}T18:00:00`).toISOString() : '');
/** Теги компании — один запрос на весь список черновиков, а не на каждую строку. */
let companyTags: Promise<TagItem[]> | null = null;
function useCompanyTags(): TagItem[] {
  const [tags, setTags] = useState<TagItem[]>([]);
  useEffect(() => {
    companyTags ??= api.listTags().then((r) => r.items).catch(() => { companyTags = null; return []; });
    let alive = true;
    void companyTags.then((t) => { if (alive) setTags(t); });
    return () => { alive = false; };
  }, []);
  return tags;
}

const stamp = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Черновик задачи со встречи: ИИ услышал поручение так, человек правит и решает.
 *
 * Не путать три роли (ТЗ-22, §12): кто произнёс фразу, кто поставил задачу, кто
 * должен выполнить. Уверенность в исполнителе видна (§14): названный и найденный —
 * просто имя; угаданный — «ИИ предполагает»; не найденный — «выберите».
 */
export function DraftRow({ draft, projects, users, onApply, onReject, onSaved, selected, onSelect, onChoice, proof, recordingUrl, duplicate }: {
  draft: any; projects: Project[]; users: User[];
  onApply: (d: any, patch: DraftChoice) => void;
  onReject: (d: any) => void;
  onSaved: () => void;
  /** выбор для «Создать выбранные» — только на экране итогов */
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onChoice?: (choice: DraftChoice) => void;
  /** фрагмент записи с поручением (ТЗ-25, §34) — послушать ещё до создания задачи */
  proof?: DraftProof;
  recordingUrl?: string | null;
  /** уже существующая задача по той же договорённости (§10) */
  duplicate?: { taskId: string; projectId: string; title: string };
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
  /** теги (#4604): ИИ подобрал их из тегов компании, человек правит вместе с текстом */
  const tagsOf = () => ((draft.tag_ids ?? []) as unknown[]).map(String);
  const [tagIds, setTagIds] = useState<string[]>(tagsOf);
  const allTags = useCompanyTags();
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
        tagIds,
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
    setTagIds(tagsOf());
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
                className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Описание (необязательно)" aria-label="Описание задачи" style={{ marginTop: 4 }}
              />
              {allTags.length > 0 && (
                <div className="draft-tags" role="group" aria-label="Теги задачи">
                  {allTags.map((t) => {
                    const on = tagIds.includes(String(t.id));
                    return (
                      <button
                        key={t.id} type="button" aria-pressed={on}
                        className={`label-chip${on ? '' : ' label-off'}`}
                        style={on ? { background: t.color, color: labelTextColor(t.color) } : { borderColor: t.color }}
                        onClick={() => setTagIds(on ? tagIds.filter((x) => x !== String(t.id)) : [...tagIds, String(t.id)])}
                      >{t.name}</button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="team-head">
                <button type="button" className="draft-title" onClick={() => setEditing(true)} title="Нажмите, чтобы исправить название и описание">
                  {draft.title}
                </button>
                {draft.priority === 'urgent' && <span className="ui-badge ui-badge-danger draft-urgent">срочно</span>}
              </div>
              {draft.description && <div className="dim" style={{ fontSize: 12 }}>{draft.description}</div>}
              <DraftTags ids={tagsOf()} ai={((draft.ai_tag_ids ?? []) as unknown[]).map(String)} all={allTags} />
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
      {duplicate && (
        <div className="draft-unsure">
          Похоже, задача уже есть: «{duplicate.title}»{' '}
          <button type="button" className="link-btn" onClick={() => navigate({ section: 'projects', projectId: duplicate.projectId, taskId: duplicate.taskId })}>Открыть</button>
        </div>
      )}
      {proof && recordingUrl && (
        <div className="draft-proof">
          <AudioClip
            compact url={recordingUrl} start={proof.startSec} end={proof.endSec}
            label={`Контекст · ${Math.round(proof.endSec - proof.startSec)} сек`}
          />
          {proof.consent && (
            <div className="draft-unsure">
              {proof.consent.users.length ? `Встречу не видят: ${proof.consent.users.slice(0, 3).join(', ')}${proof.consent.users.length > 3 ? ' и др.' : ''}` : ''}
              {proof.consent.users.length && proof.consent.guest ? '; ' : ''}
              {proof.consent.guest ? 'во фрагменте говорит гость' : ''}
              {' — фрагмент покажем только с вашего разрешения.'}
            </div>
          )}
          {/* формулировку переписали до неузнаваемости (§37) — сервер сверил её с репликой */}
          {proof.drifted && (
            <div className="draft-unsure">Формулировка заметно отличается от сказанного — послушайте фрагмент.</div>
          )}
        </div>
      )}
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
        <OptionSelect className="input" value={projectId} onChange={(e) => { setProjectId(e.target.value); if (e.target.value) setErr(''); }} aria-label="Проект" aria-invalid={!projectId && !!err}>
          <option value="">— проект —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
        <DatePicker value={deadline} onChange={setDeadline} ariaLabel="Срок" placeholder="срок" />
      </div>

      <div className="team-rate" style={{ marginTop: 4 }}>
        {editing ? (
          <>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={save} disabled={busy}>Сохранить</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={cancel} disabled={busy}>Отмена</button>
          </>
        ) : (
          <>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => (projectId ? onApply(draft, choice) : setErr('Выберите проект — без проекта задачу создать нельзя'))} disabled={busy}>
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

/** Теги черновика в строке: подобранные ИИ — со звёздочкой, пока человек их не трогал. */
function DraftTags({ ids, ai, all }: { ids: string[]; ai: string[]; all: TagItem[] }) {
  const chosen = ids.map((id) => all.find((t) => String(t.id) === id)).filter((t): t is TagItem => !!t);
  if (!chosen.length) return null;
  return (
    <div className="draft-tags">
      {chosen.map((t) => (
        <span
          key={t.id} className="label-chip label-chip-sm" style={{ background: t.color, color: labelTextColor(t.color) }}
          title={ai.includes(String(t.id)) ? 'Подобрал ИИ — поправьте в «Редактировать», если не так' : undefined}
        >
          {ai.includes(String(t.id)) && <Icon name="sparkles" size={10} />} {t.name}
        </span>
      ))}
    </div>
  );
}

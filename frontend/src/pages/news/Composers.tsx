import { useEffect, useMemo, useState } from 'react';
import { DatePicker } from '../../components/DatePicker';
import { Icon } from '../../components/Icon';
import { MentionField } from '../../components/MentionField';
import { Dialog, confirmAction } from '../../components/ui/dialog';
import { Checkbox } from '../../components/ui/checkbox';
import { OptionSelect } from '../../components/ui/option-select';
import { api, ApiError, NewsPost, NewsVisibility } from '../../lib/api';
import { MentionUser, stillMentioned } from '../../lib/mentions';
import { BADGES } from './shared';

type Group = { id: string; name: string };
type Project = { id: string; name: string };

/** Пароль, ключ, номер карты в тексте — спросить до публикации на всю компанию (§55). */
async function passesCheck(text: string): Promise<boolean> {
  const r = await api.feedCheck(text).catch(() => ({ warning: null }));
  if (!r.warning) return true;
  return confirmAction({ title: 'Точно публикуем?', description: `${r.warning}. Проверьте текст перед публикацией.`, confirmLabel: 'Опубликовать всё равно', danger: true });
}

/** Кому показать (§19): всем, отделу, проекту, своим людям. Проверяет всё равно сервер. */
function Audience({ value, onChange, groups, projects, team, groupIds, setGroupIds, projectId, setProjectId, userIds, setUserIds, allow = ['all', 'department', 'project', 'custom'] }: {
  value: NewsVisibility; onChange: (v: NewsVisibility) => void;
  groups: Group[]; projects: Project[]; team: MentionUser[];
  groupIds: string[]; setGroupIds: (v: string[]) => void;
  projectId: string; setProjectId: (v: string) => void;
  userIds: string[]; setUserIds: (v: string[]) => void;
  allow?: NewsVisibility[];
}) {
  const labels: Record<NewsVisibility, string> = { all: 'Всей компании', department: 'Отделу', project: 'Проекту', custom: 'Выбранным людям' };
  return (
    <div className="feed-audience">
      <OptionSelect className="input" value={value} onChange={(e) => onChange(e.target.value as NewsVisibility)} aria-label="Кому показать">
        {allow.filter((v) => v !== 'department' || groups.length).map((v) => <option key={v} value={v}>{labels[v]}</option>)}
      </OptionSelect>
      {value === 'department' && (
        <OptionSelect className="input" value="" onChange={(e) => { const id = String(e.target.value); if (id && !groupIds.includes(id)) setGroupIds([...groupIds, id]); }} aria-label="Добавить отдел">
          <option value="">+ отдел</option>
          {groups.filter((g) => !groupIds.includes(String(g.id))).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </OptionSelect>
      )}
      {value === 'project' && (
        <OptionSelect className="input" value={projectId} onChange={(e) => setProjectId(String(e.target.value))} aria-label="Проект">
          <option value="">Выберите проект</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
      )}
      {value === 'custom' && (
        <OptionSelect className="input" value="" onChange={(e) => { const id = String(e.target.value); if (id && !userIds.includes(id)) setUserIds([...userIds, id]); }} aria-label="Добавить человека">
          <option value="">+ человек</option>
          {team.filter((u) => !userIds.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </OptionSelect>
      )}
      {(value === 'department' ? groupIds : value === 'custom' ? userIds : []).length > 0 && (
        <div className="feed-chosen">
          {value === 'department' && groupIds.map((id) => (
            <button key={id} type="button" className="feed-chip" onClick={() => setGroupIds(groupIds.filter((x) => x !== id))}>
              {groups.find((g) => String(g.id) === id)?.name ?? id} <Icon name="close" size={11} />
            </button>
          ))}
          {value === 'custom' && userIds.map((id) => (
            <button key={id} type="button" className="feed-chip" onClick={() => setUserIds(userIds.filter((x) => x !== id))}>
              {team.find((u) => u.id === id)?.fullName ?? id} <Icon name="close" size={11} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useDirectory(open: boolean) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    if (!open) return;
    api.listGroups().then((g: any[]) => setGroups(g.map((x) => ({ id: String(x.id), name: x.name })))).catch(() => undefined);
    api.listProjects().then((p: any[]) => setProjects(p.map((x) => ({ id: String(x.id), name: x.name })))).catch(() => undefined);
  }, [open]);
  return { groups, projects };
}

/**
 * Новость или важное объявление (§39–41). Объявление — подтверждение «Ознакомился»,
 * срок действия, кнопка-ссылка, закрепление. Черновик не стирается от промаха мимо окна.
 */
export function PostComposer({ open, announcement, team, canPin, onClose, onPublished }: {
  open: boolean; announcement: boolean; team: MentionUser[]; canPin: boolean;
  onClose: () => void; onPublished: (p: NewsPost) => void;
}) {
  const { groups, projects } = useDirectory(open);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<NewsVisibility>('all');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [requiresAck, setRequiresAck] = useState(true);
  const [activeUntil, setActiveUntil] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [pin, setPin] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const publish = async () => {
    if (!body.trim()) return;
    if (!(await passesCheck(`${title}\n${body}`))) return;
    setBusy(true);
    setErr('');
    try {
      const post = await api.feedCreate({
        type: announcement ? 'announcement' : 'manual',
        title: title.trim() || undefined,
        body: body.trim(),
        visibility,
        groupIds: visibility === 'department' ? groupIds : undefined,
        userIds: visibility === 'custom' ? userIds : undefined,
        projectId: visibility === 'project' && projectId ? projectId : undefined,
        mentionIds: stillMentioned(mentionIds, body, team),
        requiresAck: announcement ? requiresAck : undefined,
        // «до 15-го» — до конца 15-го по часам человека, а не до полуночи UTC в его начале
        activeUntil: announcement && activeUntil ? new Date(`${activeUntil}T23:59:59`).toISOString() : undefined,
        ctaLabel: announcement && ctaLabel.trim() && ctaUrl.trim() ? ctaLabel.trim() : undefined,
        ctaUrl: announcement && ctaLabel.trim() && ctaUrl.trim() ? ctaUrl.trim() : undefined,
        pin: pin || undefined,
      });
      const failed: string[] = [];
      for (const f of files) { try { await api.feedAttach(post.id, f); } catch { failed.push(f.name); } }
      setTitle(''); setBody(''); setMentionIds([]); setFiles([]); setPin(false); setCtaLabel(''); setCtaUrl(''); setActiveUntil('');
      onPublished(failed.length ? post : await api.feedGet(post.id).catch(() => post));
      if (failed.length) setErr(`Опубликовано, но не приложились: ${failed.join(', ')}`);
      else onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось опубликовать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title={announcement ? 'Важное объявление' : 'Новость компании'}
      description={announcement ? 'Объявление выделено в ленте, приходит уведомлением (письмо, Telegram, push) тем, кому адресовано, и просит нажать «Ознакомился». Вы увидите, кто ознакомился.' : undefined}
      size="lg"
      footer={(
        <>
          <label className="ui-btn ui-btn-outline ui-btn-sm feed-attach" title="Скриншот, GIF, короткое видео или файл">
            <Icon name="paperclip" size={14} /> Файл
            <input type="file" multiple hidden onChange={(e) => { setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 10)); e.target.value = ''; }} />
          </label>
          <span className="feed-grow" />
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Отмена</button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void publish()} disabled={busy || !body.trim()}>{busy ? 'Публикую…' : 'Опубликовать'}</button>
        </>
      )}
    >
      <div className="feed-form">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={announcement ? 'Заголовок: о чём объявление' : 'Заголовок (необязательно)'} maxLength={200} aria-label="Заголовок" />
        <MentionField
          rows={6}
          placeholder={announcement ? 'Что важно знать? Через @ можно позвать человека' : 'Что нового? Через @ можно позвать человека'}
          value={body}
          users={team}
          onChange={setBody}
          onMention={(id) => setMentionIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
        />
        <Audience value={visibility} onChange={setVisibility} groups={groups} projects={projects} team={team}
          groupIds={groupIds} setGroupIds={setGroupIds} projectId={projectId} setProjectId={setProjectId} userIds={userIds} setUserIds={setUserIds} />
        {announcement && (
          <div className="feed-form-grid">
            <Checkbox checked={requiresAck} onCheckedChange={setRequiresAck} label="Просить «Ознакомился»" />
            <label className="feed-inline-field"><span className="dim">Действует до</span>
              <DatePicker value={activeUntil} onChange={setActiveUntil} placeholder="бессрочно" />
            </label>
            <input className="input" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Кнопка: «Открыть регламент»" maxLength={60} aria-label="Текст кнопки" />
            <input className="input" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://… или /projects/12" maxLength={500} aria-label="Ссылка кнопки" />
          </div>
        )}
        {canPin && <Checkbox checked={pin} onCheckedChange={setPin} label="Закрепить сверху ленты (до трёх)" />}
        {files.length > 0 && (
          <div className="feed-chosen">
            {files.map((f, i) => (
              <button key={`${f.name}-${i}`} type="button" className="feed-chip" title="Убрать файл" onClick={() => setFiles(files.filter((_, x) => x !== i))}>
                <Icon name="paperclip" size={11} /> {f.name} <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * «Сказать спасибо» (§21, §87): коллега → за что → бейдж → предпросмотр → опубликовать.
 * Пять–десять секунд — поэтому всё на одном экране, без лишних шагов.
 */
export function KudosDialog({ open, team, meId, presetUserId, onClose, onPublished }: {
  open: boolean; team: MentionUser[]; meId: string; presetUserId?: string;
  onClose: () => void; onPublished: (p: NewsPost) => void;
}) {
  const [to, setTo] = useState(presetUserId ?? '');
  const [text, setText] = useState('');
  const [badge, setBadge] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open && presetUserId) setTo(presetUserId); }, [open, presetUserId]);
  const person = team.find((u) => u.id === to);
  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      const p = await api.feedKudos({ toUserId: to, text: text.trim(), badge: badge || undefined });
      setTo(''); setText(''); setBadge('');
      onPublished(p);
      onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title="Сказать спасибо"
      description="Благодарность увидят коллеги, а получатель — сразу уведомлением. В оценку работы она не идёт."
      footer={(
        <>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Отмена</button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void send()} disabled={busy || !to || text.trim().length < 3}>
            <Icon name="heart" size={14} /> Поблагодарить
          </button>
        </>
      )}
    >
      <div className="feed-form">
        <OptionSelect className="input" value={to} onChange={(e) => setTo(String(e.target.value))} aria-label="Кого благодарим">
          <option value="">Кого благодарим?</option>
          {team.filter((u) => u.id !== meId).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </OptionSelect>
        <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="За что спасибо? «Спасибо за быструю помощь с интеграцией — спас релиз!»" maxLength={1000} aria-label="За что спасибо" />
        <div className="feed-badges" role="radiogroup" aria-label="Бейдж">
          {BADGES.map((b) => (
            <button key={b.key} type="button" role="radio" aria-checked={badge === b.key} className={`feed-badge-pick${badge === b.key ? ' on' : ''}`} onClick={() => setBadge(badge === b.key ? '' : b.key)}>
              {b.emoji} {b.label}
            </button>
          ))}
        </div>
        {person && text.trim().length >= 3 && (
          <div className="feed-preview-card" aria-label="Предпросмотр">
            <div className="dim">Так увидят коллеги:</div>
            <div>❤️ Вы благодарите <b>{person.fullName}</b></div>
            <blockquote className="feed-kudos-text">«{text.trim()}»</blockquote>
            {badge && <span className="feed-kudos-badge">{BADGES.find((b) => b.key === badge)?.emoji} {BADGES.find((b) => b.key === badge)?.label}</span>}
          </div>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/** Быстрый опрос (§31): вопрос, 2–10 вариантов, срок, анонимно, несколько ответов. */
export function PollDialog({ open, team, onClose, onPublished }: {
  open: boolean; team: MentionUser[]; onClose: () => void; onPublished: (p: NewsPost) => void;
}) {
  const { groups, projects } = useDirectory(open);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [deadline, setDeadline] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [multiple, setMultiple] = useState(false);
  const [visibility, setVisibility] = useState<NewsVisibility>('all');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const filled = options.filter((o) => o.trim());
  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      const p = await api.feedPoll({
        question: question.trim(), options: filled, anonymous, multiple,
        deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
        visibility, groupIds: visibility === 'department' ? groupIds : undefined,
        userIds: visibility === 'custom' ? userIds : undefined, projectId: visibility === 'project' && projectId ? projectId : undefined,
      });
      setQuestion(''); setOptions(['', '']); setDeadline(''); setAnonymous(false); setMultiple(false);
      onPublished(p);
      onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать опрос'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title="Быстрый опрос"
      description="Простой вопрос — без хаоса в чатах. Результат виден на лету, после срока опрос закроется сам."
      footer={(
        <>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Отмена</button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void send()} disabled={busy || question.trim().length < 3 || filled.length < 2}>Опубликовать опрос</button>
        </>
      )}
    >
      <div className="feed-form">
        <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Вопрос: «Во сколько пятничный разбор?»" maxLength={300} aria-label="Вопрос" />
        {options.map((o, i) => (
          <div key={i} className="feed-poll-edit">
            <input className="input" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Вариант ${i + 1}`} maxLength={120} aria-label={`Вариант ${i + 1}`} />
            {options.length > 2 && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon-sm" aria-label="Убрать вариант" onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm feed-earlier" onClick={() => setOptions([...options, ''])}><Icon name="plus" size={13} /> Вариант</button>
        )}
        <div className="feed-form-grid">
          <label className="feed-inline-field"><span className="dim">Закрыть</span><DatePicker value={deadline} onChange={setDeadline} withTime placeholder="без срока" /></label>
          <Checkbox checked={anonymous} onCheckedChange={setAnonymous} label="Анонимно — кто как голосовал, не видно никому" />
          <Checkbox checked={multiple} onCheckedChange={setMultiple} label="Можно выбрать несколько" />
        </div>
        <Audience value={visibility} onChange={setVisibility} groups={groups} projects={projects} team={team}
          groupIds={groupIds} setGroupIds={setGroupIds} projectId={projectId} setProjectId={setProjectId} userIds={userIds} setUserIds={setUserIds} />
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * «Объявить релиз» (решение 11.10): проект → что вошло (закрытые задачи) → текст →
 * скриншот. Авторы считаются сами — из исполнителей и соисполнителей выбранных задач.
 */
export function ReleaseDialog({ open, onClose, onPublished }: {
  open: boolean; onClose: () => void; onPublished: (p: NewsPost) => void;
}) {
  const { projects } = useDirectory(open);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof api.feedReleaseTasks>>>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!projectId) { setTasks([]); return; }
    api.feedReleaseTasks(projectId).then((t) => { setTasks(t); setPicked(new Set(t.slice(0, 10).map((x) => x.id))); }).catch(() => setTasks([]));
  }, [projectId]);
  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  const send = async () => {
    if (!(await passesCheck(`${title}\n${body}`))) return;
    setBusy(true);
    setErr('');
    try {
      const p = await api.feedRelease({ projectId, title: title.trim(), body: body.trim() || undefined, taskIds: [...picked] });
      for (const f of files) { try { await api.feedAttach(p.id, f); } catch { /* текст важнее картинки */ } }
      setTitle(''); setBody(''); setFiles([]); setProjectId('');
      onPublished(await api.feedGet(p.id).catch(() => p));
      onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось объявить релиз'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title="Объявить релиз"
      description="Что вышло и кто это сделал. Если проект закрытый, релиз увидят только его участники."
      size="lg"
      footer={(
        <>
          <label className="ui-btn ui-btn-outline ui-btn-sm feed-attach" title="Скриншот, GIF или короткое видео">
            <Icon name="image" size={14} /> Медиа
            <input type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 6)); e.target.value = ''; }} />
          </label>
          <span className="feed-grow" />
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Отмена</button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void send()} disabled={busy || !projectId || title.trim().length < 3}><Icon name="rocket" size={14} /> Объявить</button>
        </>
      )}
    >
      <div className="feed-form">
        <OptionSelect className="input" value={projectId} onChange={(e) => setProjectId(String(e.target.value))} aria-label="Проект">
          <option value="">Проект</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={project ? `Что вышло в «${project.name}»?` : 'Название релиза'} maxLength={200} aria-label="Название релиза" />
        <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Что теперь можно делать? «Внешних клиентов можно звать на встречу без аккаунта»" aria-label="Описание" />
        {projectId && (
          <div className="feed-release-tasks">
            <div className="dim">Что вошло — закрытые задачи за 30 дней ({picked.size}):</div>
            {tasks.length === 0 && <div className="dim">Закрытых задач за 30 дней нет — авторы посчитаются по проекту.</div>}
            {tasks.map((t) => (
              <Checkbox key={t.id} checked={picked.has(t.id)} onCheckedChange={(on) => setPicked((cur) => { const n = new Set(cur); if (on) n.add(t.id); else n.delete(t.id); return n; })}
                label={<span>{t.title}{t.assigneeName ? <span className="dim"> · {t.assigneeName}</span> : null}</span>} />
            ))}
          </div>
        )}
        {files.length > 0 && <div className="feed-chosen">{files.map((f, i) => <button key={i} type="button" className="feed-chip" onClick={() => setFiles(files.filter((_, x) => x !== i))}>{f.name} <Icon name="close" size={11} /></button>)}</div>}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

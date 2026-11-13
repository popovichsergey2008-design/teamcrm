import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import {
  migrationApi, uploadArchive, MigrationChatKind, MigrationJob, MigrationReport, MigrationSource,
} from './migration-api';
import './migration.css';

/**
 * Экран переезда из Slack и Telegram (#4902, п. 4 и п. 15).
 *
 * Путь человека: выбрать карточку → загрузить архив → увидеть, что в нём (каналы,
 * люди, сколько сообщений) → отметить нужное → перенос с полоской хода → отчёт
 * «перенесено / не удалось». Отчёт обязателен: перенос без него — лотерея, а
 * «что не перенеслось и почему» человек должен узнать здесь, а не через месяц.
 */

const KIND: Record<MigrationChatKind, string> = {
  channel: 'канал',
  private: 'закрытый канал',
  dm: 'личная переписка',
  mpim: 'групповая личка',
  tg_group: 'группа',
  tg_channel: 'канал',
  tg_personal: 'личная переписка',
};

const num = (n: number) => n.toLocaleString('ru-RU');

/** 1 сообщение, 2 сообщения, 5 сообщений. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const count = (n: number, one: string, few: string, many: string) => `${num(n)} ${plural(n, one, few, many)}`;

/** Строка отчёта ровно в том виде, как просил заказчик: «Перенесено: …; приглашено …; не удалось: …». */
export function reportLine(r: MigrationReport, source: MigrationSource): string {
  const what = source === 'slack' ? ['канал', 'канала', 'каналов'] : ['чат', 'чата', 'чатов'];
  const parts = [
    `Перенесено: ${count(r.chats, what[0], what[1], what[2])}, ${count(r.messages, 'сообщение', 'сообщения', 'сообщений')}, ${count(r.files, 'файл', 'файла', 'файлов')}`,
  ];
  if (r.invited) parts.push(`приглашено ${num(r.invited)}`);
  parts.push(r.failedTotal ? `не удалось: ${num(r.failedTotal)}` : 'не удалось: ничего');
  return parts.join('; ');
}

const STAGE: Record<string, string> = {
  start: 'Готовимся…',
  read: 'Открываем архив…',
  invite: 'Рассылаем приглашения…',
  chat: 'Создаём чат',
  files: 'Переносим файлы',
  messages: 'Переносим сообщения',
  done: 'Завершаем…',
};

const dateOnly = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '');

export default function MigrationImport() {
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [uploading, setUploading] = useState<{ source: MigrationSource; part: number; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [invite, setInvite] = useState(true);
  const [projects, setProjects] = useState(true);
  const [history, setHistory] = useState<MigrationJob[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const slackInput = useRef<HTMLInputElement>(null);
  const tgInput = useRef<HTMLInputElement>(null);

  // Вернулись на экран посреди переноса — показываем его, а не пустые карточки
  useEffect(() => {
    migrationApi.jobs().then((list) => {
      setHistory(list);
      const live = list.find((j) => j.status === 'scanning' || j.status === 'running');
      if (live) migrationApi.job(live.id).then(setJob).catch(() => undefined);
    }).catch(() => undefined);
    return () => abort.current?.abort();
  }, []);

  // Пока архив разбирается или переносится — спрашиваем ход раз в полторы секунды
  const jobId = job?.id;
  const live = job?.status === 'scanning' || job?.status === 'running';
  useEffect(() => {
    if (!jobId || !live) return;
    const t = setInterval(() => {
      migrationApi.job(jobId).then(setJob).catch(() => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, live]);

  // Разбор закончился — отмечаем то, что сервер предлагает по умолчанию
  const scanKey = job?.status === 'ready' ? job.id : null;
  useEffect(() => {
    if (!scanKey || !job?.scan) return;
    const prev = job.options?.chatKeys;
    setPicked(new Set(prev?.length ? prev : job.scan.chats.filter((c) => c.selected).map((c) => c.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const upload = async (source: MigrationSource, file: File | undefined) => {
    if (!file) return;
    setErr('');
    setJob(null);
    abort.current = new AbortController();
    setUploading({ source, part: 0, name: file.name });
    try {
      const made = await uploadArchive(source, file, (part) => setUploading({ source, part, name: file.name }), abort.current.signal);
      setJob(made);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr(e instanceof ApiError ? e.message : 'Архив не загрузился');
    } finally {
      setUploading(null);
      if (slackInput.current) slackInput.current.value = '';
      if (tgInput.current) tgInput.current.value = '';
    }
  };

  const start = async () => {
    if (!job) return;
    setErr('');
    setBusy(true);
    try {
      setJob(await migrationApi.start(job.id, { chatKeys: [...picked], invite, projects }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Перенос не запустился');
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setJob(null);
    setErr('');
    migrationApi.jobs().then(setHistory).catch(() => undefined);
  };

  const toggle = (key: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  return (
    <div className="mig">
      <div className="mig-head">
        <h2>Переезд из Slack и Telegram</h2>
        <p className="mig-lead">
          Перенесите переписку за вечер: каналы, сообщения с авторами и датами, ветки и файлы.
          <strong> История переносится целиком, без ограничения по времени</strong> — в отличие от 90 дней на бесплатном Slack.
        </p>
      </div>

      {err && <div className="mig-alert mig-alert-danger" role="alert"><Icon name="alert" size={16} /> {err}</div>}

      {uploading && (
        <div className="mig-panel" aria-live="polite">
          <div className="mig-row"><Icon name="upload" size={16} /> Загружаем «{uploading.name}» — {Math.round(uploading.part * 100)}%</div>
          <Bar part={uploading.part} />
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => abort.current?.abort()}>Отменить</button>
        </div>
      )}

      {!uploading && !job && (
        <div className="mig-cards">
          <section className="mig-card">
            <div className="mig-card-title"><Icon name="hash" size={18} /> Slack</div>
            <ol className="mig-steps">
              <li><b>Slack → Настройки → Импорт/экспорт → Экспорт</b> (нужны права администратора пространства).</li>
              <li>Выберите период «Вся история» и дождитесь письма от Slack.</li>
              <li>Скачайте архив .zip по ссылке из письма и загрузите его сюда.</li>
            </ol>
            <ul className="mig-notes">
              <li>Открытые каналы становятся чатами проектов.</li>
              <li>Участники, которых ещё нет в команде, получают приглашения на почту.</li>
              <li>История, ветки и файлы сохраняются, авторы и даты — как были.</li>
            </ul>
            <input ref={slackInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => upload('slack', e.target.files?.[0])} />
            <button className="ui-btn ui-btn-primary" onClick={() => slackInput.current?.click()}>
              <Icon name="upload" size={16} /> Загрузить архив Slack (.zip)
            </button>
          </section>

          <section className="mig-card">
            <div className="mig-card-title"><Icon name="send" size={18} /> Telegram</div>
            <ol className="mig-steps">
              <li><b>Telegram Desktop → чат → ⋮ → Экспорт истории чата → формат JSON</b>.</li>
              <li>Отметьте фото и файлы, если их тоже нужно перенести.</li>
              <li>Запакуйте папку экспорта в .zip и загрузите сюда (можно и один result.json — тогда без файлов).</li>
            </ol>
            <ul className="mig-notes">
              <li>Каждый выбранный чат становится группой в QEVO.</li>
              <li>Полный экспорт аккаунта тоже подходит — нужные чаты выберете после загрузки.</li>
              <li>Бот Telegram не может прочитать старую историю — поэтому нужен экспорт из Telegram Desktop.</li>
            </ul>
            <input ref={tgInput} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={(e) => upload('telegram', e.target.files?.[0])} />
            <button className="ui-btn ui-btn-primary" onClick={() => tgInput.current?.click()}>
              <Icon name="upload" size={16} /> Загрузить экспорт Telegram
            </button>
          </section>
        </div>
      )}

      {job?.status === 'scanning' && (
        <div className="mig-panel" aria-live="polite">
          <div className="mig-row"><Icon name="hourglass" size={16} /> Разбираем «{job.fileName}»: ищем каналы, людей и сообщения…</div>
          <Bar part={null} />
        </div>
      )}

      {job?.status === 'ready' && job.scan && (
        <div className="mig-panel">
          <div className="mig-panel-title">
            {job.source === 'slack' ? 'Архив Slack' : 'Экспорт Telegram'} «{job.fileName}»
          </div>
          <p className="mig-dim">
            В архиве: {count(job.scan.chats.length, 'чат', 'чата', 'чатов')}, {count(job.scan.messages, 'сообщение', 'сообщения', 'сообщений')},{' '}
            {count(job.scan.files, 'файл', 'файла', 'файлов')}, {count(job.scan.people, 'участник', 'участника', 'участников')}
            {job.source === 'slack' && ` (с почтой — ${num(job.scan.peopleWithEmail)})`}.
          </p>
          {job.error && <div className="mig-alert mig-alert-warn"><Icon name="alert" size={16} /> {job.error}</div>}
          {job.scan.warnings.map((w) => <div key={w} className="mig-alert mig-alert-warn"><Icon name="info" size={16} /> {w}</div>)}

          <div className="mig-list-head">
            <span>Что переносим</span>
            <span className="mig-list-actions">
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setPicked(new Set(job.scan!.chats.map((c) => c.key)))}>Все</button>
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setPicked(new Set())}>Ни одного</button>
            </span>
          </div>
          <ul className="mig-chats">
            {job.scan.chats.map((c) => (
              <li key={c.key}>
                <label className="mig-chat">
                  <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
                  <span className="mig-chat-title">{c.kind === 'channel' || c.kind === 'private' ? `#${c.title}` : c.title}</span>
                  <span className="mig-chat-meta">
                    {KIND[c.kind]} · {count(c.messages, 'сообщение', 'сообщения', 'сообщений')}
                    {c.files ? ` · ${count(c.files, 'файл', 'файла', 'файлов')}` : ''}
                    {c.firstAt ? ` · ${dateOnly(c.firstAt)} — ${dateOnly(c.lastAt)}` : ''}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {job.source === 'slack' && (
            <div className="mig-options">
              <label><input type="checkbox" checked={projects} onChange={(e) => setProjects(e.target.checked)} /> Открытые каналы → чаты проектов (найдём проект по названию или заведём новый)</label>
              <label><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} /> Пригласить в команду тех, кого ещё нет (письмо на почту из Slack)</label>
              <p className="mig-dim">Личные переписки переносятся, только если оба собеседника уже в команде. Остальные — повторной загрузкой того же архива, когда приглашённые придут: дублей не будет.</p>
            </div>
          )}

          <div className="mig-actions">
            <button className="ui-btn ui-btn-primary" disabled={busy || !picked.size} onClick={start}>
              <Icon name="rocket" size={16} /> Перенести {picked.size ? count(picked.size, 'чат', 'чата', 'чатов') : ''}
            </button>
            <button className="ui-btn ui-btn-ghost" onClick={again}>Загрузить другой архив</button>
          </div>
        </div>
      )}

      {job?.status === 'running' && <Running job={job} />}

      {job?.status === 'done' && job.report && <Report job={job} report={job.report} onAgain={again} />}

      {job?.status === 'failed' && (
        <div className="mig-panel">
          <div className="mig-alert mig-alert-danger" role="alert"><Icon name="alert" size={16} /> {job.error ?? 'Архив не удалось разобрать'}</div>
          <button className="ui-btn ui-btn-primary" onClick={again}>Загрузить другой архив</button>
        </div>
      )}

      {!job && !uploading && history.some((h) => h.status === 'done' || h.status === 'ready') && (
        <div className="mig-history">
          <div className="mig-panel-title">Прошлые загрузки</div>
          <ul>
            {history.filter((h) => h.status === 'done' || h.status === 'ready').slice(0, 5).map((h) => (
              <li key={h.id}>
                <button className="mig-link" onClick={() => migrationApi.job(h.id).then(setJob).catch(() => undefined)}>
                  {h.source === 'slack' ? 'Slack' : 'Telegram'} · {h.fileName} · {new Date(h.createdAt).toLocaleString('ru-RU')}
                </button>
                <span className="mig-dim"> — {h.status === 'done' && h.report ? reportLine(h.report, h.source) : 'ждёт запуска'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Bar({ part }: { part: number | null }) {
  return (
    <div
      className={`mig-bar ${part === null ? 'mig-bar-busy' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={part === null ? undefined : Math.round(part * 100)}
    >
      <span style={part === null ? undefined : { width: `${Math.max(2, Math.round(part * 100))}%` }} />
    </div>
  );
}

function Running({ job }: { job: MigrationJob }) {
  const p = job.progress ?? {};
  const part = p.total ? Math.min(1, (p.done ?? 0) / p.total) : null;
  return (
    <div className="mig-panel" aria-live="polite">
      <div className="mig-panel-title">Переносим «{job.fileName}»</div>
      <div className="mig-row">
        {STAGE[p.stage ?? 'start'] ?? 'Переносим…'}{p.chat ? ` «${p.chat}»` : ''}
        {p.chatsTotal ? ` · чат ${Math.min((p.chatsDone ?? 0) + 1, p.chatsTotal)} из ${p.chatsTotal}` : ''}
      </div>
      <Bar part={part} />
      <p className="mig-dim">
        {p.total ? `${num(p.done ?? 0)} из ${count(p.total, 'сообщения', 'сообщений', 'сообщений')}` : ''}
        {p.files ? ` · файлов: ${num(p.files)}` : ''}
        {' '}Можно закрыть экран — перенос идёт на сервере.
      </p>
    </div>
  );
}

function Report({ job, report, onAgain }: { job: MigrationJob; report: MigrationReport; onAgain: () => void }) {
  const [showFailed, setShowFailed] = useState(report.failedTotal > 0 && report.failedTotal <= 10);
  return (
    <div className="mig-panel">
      <div className="mig-panel-title"><Icon name="check-circle" size={18} /> Перенос завершён</div>
      <p className="mig-summary">{reportLine(report, job.source)}.</p>
      <ul className="mig-facts">
        <li>Авторы из команды: {num(report.usersMatched)}; подписаны именем из {job.source === 'slack' ? 'Slack' : 'Telegram'} (нет в команде): {num(report.outsiders)}.</li>
        {report.invited > 0 && <li>Приглашения отправлены: {report.invitedEmails.join(', ')}. Когда люди примут их, загрузите тот же архив ещё раз — их сообщения подпишутся их именами, дублей не будет.</li>}
        {report.projectsCreated.length > 0 && <li>Новые проекты: {report.projectsCreated.join(', ')}.</li>}
        {report.duplicates > 0 && <li>Уже были перенесены раньше и пропущены: {count(report.duplicates, 'сообщение', 'сообщения', 'сообщений')}.</li>}
        {report.relinked > 0 && <li>Сообщений переподписано на новых сотрудников: {num(report.relinked)}.</li>}
        {report.skippedService > 0 && <li>Служебные строки («вошёл в канал», «сменил тему») не переносились: {num(report.skippedService)}.</li>}
        <li>Время переноса: {Math.max(1, Math.round(report.durationMs / 1000))} с.</li>
      </ul>

      {report.chatList.length > 0 && (
        <>
          <div className="mig-list-head"><span>Перенесённые чаты</span></div>
          <ul className="mig-chats">
            {report.chatList.map((c) => (
              <li key={c.chatId}>
                <button className="mig-link" onClick={() => navigate(`/chat/${c.chatId}`)}>{c.title}</button>
                <span className="mig-dim"> — {count(c.messages, 'сообщение', 'сообщения', 'сообщений')}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.failedTotal > 0 && (
        <div className="mig-failed">
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowFailed((v) => !v)} aria-expanded={showFailed}>
            <Icon name={showFailed ? 'chevron-up' : 'chevron-down'} size={14} /> Что не удалось перенести ({num(report.failedTotal)})
          </button>
          {showFailed && (
            <ul>
              {report.failed.map((f, i) => <li key={i}><b>{f.what}</b>: {f.reason}</li>)}
              {report.failedTotal > report.failed.length && <li className="mig-dim">…и ещё {num(report.failedTotal - report.failed.length)}</li>}
            </ul>
          )}
        </div>
      )}

      <div className="mig-actions">
        <button className="ui-btn ui-btn-primary" onClick={onAgain}>Перенести ещё архив</button>
      </div>
    </div>
  );
}

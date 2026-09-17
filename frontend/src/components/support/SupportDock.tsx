import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { collectSupportContext, describeContext } from '../../lib/support-context';
import { shrinkImage } from '../../lib/image-shrink';
import { stampLabel } from '../../lib/chat-text';
import { useAuth } from '../../state/auth';
import { Icon } from '../Icon';
import { MessageText } from '../MessageText';
import type { SupportConversation, SupportDesk } from '../../types';

/** Оценка: четыре лица вместо звёзд — на них отвечают, не задумываясь (ТЗ-8, разд. 31). */
const FACES: { score: number; face: string; label: string }[] = [
  { score: 1, face: '😞', label: 'Плохо' },
  { score: 2, face: '😐', label: 'Так себе' },
  { score: 3, face: '🙂', label: 'Хорошо' },
  { score: 4, face: '😍', label: 'Отлично' },
];

/** Почему низкая оценка — списком, а не полем: так отвечают, а не закрывают окно. */
const REASONS = ['долго ждал', 'проблема не решена', 'сложно объяснили', 'пришлось повторять', 'другое'];

/** Время ответа человеческими словами: «около 30 секунд», а не «28.4 s». */
function etaText(sec: number | null): string {
  if (!sec) return 'Ищем свободного специалиста';
  if (sec < 90) return `Ответим примерно за ${Math.max(10, Math.round(sec / 10) * 10)} сек`;
  const min = Math.round(sec / 60);
  return `Ответим примерно за ${min} ${min === 1 ? 'минуту' : min < 5 ? 'минуты' : 'минут'}`;
}

/**
 * Служба заботы — панель поверх CRM (ТЗ-8).
 *
 * Открывается кнопкой в правом нижнем углу из любого раздела и не уводит человека
 * со страницы: он видит свою задачу и разговор одновременно — именно поэтому
 * панель, а не отдельный экран (разд. 2.1, 4).
 *
 * Что здесь принципиально:
 *
 * 1. Никакой анкеты. Поле ввода и «Отправить» — всё. Тема, категория и номер
 *    обращения человеку не нужны (разд. 2.2).
 * 2. Кнопка «Позвать человека» видна всегда, пока разговор ведёт помощник (разд. 8).
 * 3. Что уходит специалисту — видно до отправки: строка контекста внизу (разд. 50).
 * 4. Закрывает разговор сам человек: «всё работает?» с оценкой (разд. 21, 31).
 */
export function SupportDock() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState<SupportDesk | null>(null);
  const [conv, setConv] = useState<SupportConversation | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [lowReason, setLowReason] = useState<number | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.supportDesk();
      setDesk(d);
      setConv(d.conversation);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Служба заботы сейчас недоступна');
    }
  }, []);

  // Панель узнаёт о себе, только когда её открыли: фоновые запросы ради кнопки не нужны.
  useEffect(() => { if (open && !desk) void load(); }, [open, desk, load]);

  /*
    Живой разговор: ответ специалиста должен появляться сам.

    Слушаем всегда, а не только при открытой панели: если человеку ответили, пока
    он работал, кнопка обязана это показать — иначе он ждёт у закрытой двери.
  */
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void load(); };
    for (const ev of ['support.message.created', 'support.status.changed', 'support.agent.joined', 'support.resolved']) {
      socket.on(ev, refresh);
    }
    return () => {
      for (const ev of ['support.message.created', 'support.status.changed', 'support.agent.joined', 'support.resolved']) {
        socket.off(ev, refresh);
      }
    };
  }, [load]);

  // Лента всегда на последней реплике: разговор читают с конца.
  useEffect(() => {
    if (!open) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, conv?.messages.length, view]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    setText('');
    try {
      // Контекст собираем в момент отправки: важно, где человек был, когда написал.
      const next = await api.supportSend(body, collectSupportContext());
      setConv(next);
      void load();
    } catch (e) {
      setText(body); // не теряем написанное
      setErr(e instanceof ApiError ? e.message : 'Сообщение не отправилось');
    } finally { setBusy(false); }
  };

  const attach = async (file: File) => {
    setBusy(true); setErr('');
    try {
      const small = await shrinkImage(file);
      setConv(await api.supportAttach(small, text.trim()));
      setText('');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл не отправился');
    } finally { setBusy(false); }
  };

  const callHuman = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportCallHuman(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось позвать'); }
    finally { setBusy(false); }
  };

  const confirm = async (ok: boolean, csat?: number, reason?: string) => {
    if (!conv) return;
    setBusy(true);
    try {
      setConv(await api.supportConfirm(conv.id, ok, csat, reason));
      setLowReason(null);
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const reopen = async (id: string) => {
    setBusy(true);
    try {
      setConv(await api.supportReopen(id));
      setView('chat');
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось открыть заново'); }
    finally { setBusy(false); }
  };

  const online = desk?.team.filter((t) => t.online) ?? [];
  const agent = conv?.participants.find((p) => p.role === 'agent');
  /** Ждём ответа человека о результате — тогда лента уступает место вопросу. */
  const asksResult = conv?.status === 'waiting_user';
  const ctx = describeContext(collectSupportContext());

  if (!user || user.role === 'client') return null;

  return (
    <>
      {/*
        Кнопка службы заботы — всегда под рукой, в правом нижнем углу.

        Не в меню и не в настройках: у человека, у которого что-то сломалось, нет сил
        искать, где тут просят о помощи (разд. 3.1).
      */}
      {!open && (
        <button className="support-fab" onClick={() => setOpen(true)} title="Служба заботы TeamCRM">
          <Icon name="support" size={20} />
          <span className="support-fab-text">Помощь</span>
          {online.length > 0 && <span className="support-fab-dot" aria-hidden="true" />}
        </button>
      )}

      {open && (
        <aside className="support-dock" role="dialog" aria-label="Служба заботы">
          <header className="support-head">
            <span className="support-head-mark" aria-hidden="true"><Icon name="support" size={18} /></span>
            <div className="support-head-title">
              <b>{agent ? agent.full_name : 'Служба заботы'}</b>
              <span className="dim support-head-sub">
                {agent
                  ? 'Специалист на связи'
                  : conv?.status === 'waiting_agent'
                    ? 'Ищем свободного специалиста'
                    : etaText(desk?.etaSeconds ?? null)}
                {online.length > 0 && !agent && <span className="support-online"> · {online.length} на связи</span>}
              </span>
            </div>
            <button
              className={`msg-icon${view === 'history' ? ' active' : ''}`}
              onClick={() => setView(view === 'history' ? 'chat' : 'history')}
              title="Мои прошлые обращения"
              aria-label="Мои прошлые обращения"
            >
              <Icon name="clock" size={15} />
            </button>
            <button className="msg-icon" onClick={() => setOpen(false)} title="Закрыть" aria-label="Закрыть">
              <Icon name="close" size={15} />
            </button>
          </header>

          {err && <div className="error-text support-err">{err}</div>}

          {view === 'history' ? (
            <div className="support-feed">
              {!desk?.history.length && (
                <p className="dim support-empty">Здесь появятся ваши прошлые обращения.</p>
              )}
              {desk?.history.map((h) => (
                <div key={h.id} className="support-history-row">
                  <div className="support-history-head">
                    <b>{h.subject || 'Обращение'}</b>
                    <span className="dim">{new Date(h.createdAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                  <div className="dim support-history-sub">
                    {h.statusText}
                    {h.agentName ? ` · ${h.agentName}` : ''}
                    {h.csat ? ` · оценка ${h.csat}/4` : ''}
                  </div>
                  {h.closedAt && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reopen(h.id)}>
                      Проблема снова появилась
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="support-feed" ref={feedRef}>
                {!conv && (
                  <div className="support-hello">
                    <p><b>Расскажите, что случилось.</b></p>
                    <p className="dim">
                      Сначала ответит AnthillBot — он видит, на каком вы экране, и знает систему.
                      Если не поможет, позовём живого специалиста: контекст не потеряется.
                    </p>
                  </div>
                )}
                {conv?.messages.map((m) => (
                  m.kind === 'system' ? (
                    <div key={m.id} className="support-system">
                      {m.authorName ? `${m.authorName} ${m.body}` : m.body}
                    </div>
                  ) : (
                    <div key={m.id} className={`support-msg support-msg-${m.kind}`}>
                      <div className="support-msg-who">
                        {m.kind === 'user' ? 'Вы' : m.kind === 'ai' ? 'AnthillBot' : m.authorName ?? 'Специалист'}
                        <span className="dim support-msg-time">{stampLabel(m.createdAt)}</span>
                      </div>
                      {m.body && <MessageText text={m.body} className="support-msg-text" />}
                      {m.fileId && (
                        <a className="support-file" href={`/api/files/${m.fileId}`} target="_blank" rel="noreferrer">
                          <Icon name="paperclip" size={13} /> {m.fileName ?? 'файл'}
                        </a>
                      )}
                    </div>
                  )
                ))}
              </div>

              {/*
                «Всё работает?» — единственный способ закрыть разговор.

                Специалист может считать, что починил; знает это только человек
                (разд. 21). Низкая оценка сразу спрашивает причину — иначе цифра
                ничего не объясняет.
              */}
              {asksResult && (
                <div className="support-ask">
                  <b>Всё работает?</b>
                  <div className="support-ask-row">
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setLowReason(0)}>
                      Да, проблема решена
                    </button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => void confirm(false)}>
                      Нет, нужна помощь
                    </button>
                  </div>
                  {lowReason !== null && (
                    <div className="support-csat">
                      <span className="dim">Как прошла помощь?</span>
                      <div className="support-faces">
                        {FACES.map((f) => (
                          <button
                            key={f.score}
                            className="support-face"
                            title={f.label}
                            disabled={busy}
                            onClick={() => (f.score <= 2 ? setLowReason(f.score) : void confirm(true, f.score))}
                          >
                            {f.face}
                          </button>
                        ))}
                      </div>
                      {!!lowReason && lowReason <= 2 && (
                        <div className="support-reasons">
                          {REASONS.map((r) => (
                            <button key={r} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void confirm(true, lowReason, r)}>
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="support-compose">
                <label className="chat-tool" title="Приложить снимок экрана или файл">
                  <Icon name="paperclip" size={17} />
                  <input
                    type="file"
                    hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.currentTarget.value = ''; }}
                  />
                </label>
                <textarea
                  className="input"
                  value={text}
                  rows={1}
                  placeholder="Что случилось?"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
                <button className="chat-send" disabled={busy || !text.trim()} onClick={() => void send()} title="Отправить" aria-label="Отправить">
                  <Icon name="send" size={17} />
                </button>
              </div>

              <footer className="support-foot">
                {/* Человек вправе знать, что уходит вместе с сообщением (разд. 50). */}
                <span className="dim support-ctx" title="Эти данные уйдут специалисту вместе с сообщением">
                  <Icon name="info" size={12} /> {ctx.join(' · ')}
                </span>
                {conv && !conv.agentId && conv.status !== 'closed' && (
                  <button className="btn btn-sm support-human" disabled={busy} onClick={() => void callHuman()}>
                    <Icon name="user" size={13} /> Позвать человека
                  </button>
                )}
              </footer>
            </>
          )}
        </aside>
      )}
    </>
  );
}

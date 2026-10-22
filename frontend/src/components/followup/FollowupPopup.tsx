import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AssistantProposal } from '../../lib/api';
import { feedback } from '../../lib/feedback';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { confirmAction, Dialog } from '../ui/dialog';
import './followup.css';

/**
 * Итоги клиенту сразу после звонка (#1525, фича 5 «ВАУ-секретаря»).
 *
 * Итог встречи готов — окно всплывает у организатора поверх любого экрана (событие
 * followup.ready) и на странице итогов. Тексты — дословно из документа заказчика.
 * «Отправить в Telegram»: клиент уже запускал нашего бота — итоги уходят сразу, одной
 * кнопкой (текст виден в окне); нет — ссылка t.me/<бот>?start=<код>, по ней бот сам
 * пришлёт итоги. Остальные каналы — «Во внешний чат», «Письмом», «Скопировать».
 */

const SHOWN = 'qevo.followupPopup.';
const OPEN = ['new', 'seen', 'snoozed', 'failed'];

/** Окно уже показывали — само второй раз не всплывает (страница итогов проверяет этот ключ). */
function markShown(id: string) {
  try { localStorage.setItem(SHOWN + id, '1'); } catch { /* приватный режим — не страшно */ }
}

type Stage = { kind: 'ask' } | { kind: 'link'; url: string; code: string; note: string } | { kind: 'done'; text: string };

export default function FollowupPopup({ id, onClose }: { id: string; onClose: () => void }) {
  const [p, setP] = useState<AssistantProposal | null>(null);
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState<Stage>({ kind: 'ask' });
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  // хозяин окна передаёт onClose стрелкой — от неё загрузка не должна повторяться
  const gone = useRef(onClose);
  gone.current = onClose;

  useEffect(() => {
    let off = false;
    api.proposal(id).then((r) => {
      if (off) return;
      // не наше окно (другой навык) или уже решено — молча закрываемся
      if (r.skill !== 'followup' || !OPEN.includes(r.status)) { gone.current(); return; }
      markShown(id);
      setP(r);
      setBody(String(r.payload.body ?? ''));
      setSubject(String(r.payload.subject ?? ''));
    }).catch(() => { if (!off) gone.current(); });
    return () => { off = true; };
  }, [id]);

  if (!p) return null;

  const pay = p.payload as { subject?: string; agreements?: string | null; chatId?: string | null; email?: string | null; tgLinked?: boolean };
  const has = (k: string) => p.actions.some((a) => a.key === k);
  const close = () => { setOpen(false); window.setTimeout(onClose, 180); };
  const done = (text: string) => {
    feedback('action.confirmed');
    setStage({ kind: 'done', text });
    window.dispatchEvent(new Event('qevo:followup-done'));
  };

  const run = async (key: string, params: Record<string, unknown> = {}) => {
    setErr(''); setBusy(key + String(params.via ?? ''));
    try {
      const r = await api.proposalAct(p.id, key, { body, subject, ...params });
      const m = /https:\/\/t\.me\/\S+?\?start=(c_[A-Za-z0-9_-]+)/.exec(r.text);
      if (key === 'send_tg' && m) {
        // ссылка выдана (или отправлена клиенту): ждём, когда он нажмёт «Запустить»
        setStage({ kind: 'link', url: m[0], code: m[1], note: params.via ? r.text.split(' Ссылка для клиента:')[0] : '' });
        if (params.via) feedback('action.confirmed');
        window.dispatchEvent(new Event('qevo:followup-done'));
      } else {
        done(r.text);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
    } finally { setBusy(''); }
  };

  const viaOther = async (key: 'send_chat' | 'send_mail') => {
    const where = key === 'send_chat' ? 'во внешний чат клиента' : `письмом на ${pay.email ?? 'почту клиента'}`;
    const ok = await confirmAction({
      title: 'Отправить итоги клиенту?',
      description: `Текст уйдёт ${where} от вашего имени — так, как он сейчас в окне.`,
      confirmLabel: key === 'send_chat' ? 'Во внешний чат' : 'Письмом',
    });
    if (ok) await run(key);
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* нет доступа к буферу — текст виден в окне */ }
    setCopied(what);
    window.setTimeout(() => setCopied(''), 2000);
  };

  const copyText = async () => {
    await copy(body, 'text');
    await run('copy');
  };

  const subj = subject || pay.subject || 'Итоги встречи';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) close(); }}
      title="Я подготовил отчет для вашего клиента."
      size="md"
      footer={stage.kind === 'done'
        ? <Button variant="primary" onClick={close}>Готово</Button>
        : <Button variant="ghost" onClick={close}>Позже</Button>}
    >
      <div className="fu">
        <p className="fu-line"><span className="fu-k">Тема:</span> {subj}</p>
        {pay.agreements && <p className="fu-line"><span className="fu-k">Договоренности:</span> {pay.agreements}</p>}

        {stage.kind === 'ask' && (
          <>
            {has('send_tg') && <p className="fu-ask">Отправить клиенту в Telegram в 1 клик?</p>}
            {edit ? (
              <div className="fu-edit">
                {has('send_mail') && (
                  <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Тема" />
                )}
                <textarea className="input" rows={9} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Текст для клиента" />
              </div>
            ) : (
              <div className="fu-text" tabIndex={0} aria-label="Текст для клиента">{body}</div>
            )}
            {err && <div className="error-text fu-err" role="alert"><Icon name="alert" size={12} /> {err}</div>}
            {has('send_tg') && (
              <Button variant="primary" className="fu-main" loading={busy === 'send_tg'} disabled={!!busy || !body.trim()} onClick={() => void run('send_tg')}>
                <Icon name="send" size={15} /> Отправить в Telegram
              </Button>
            )}
            {has('send_tg') && !pay.tgLinked && (
              <p className="fu-hint">Клиент ещё не подключал бота QEVO — дам ссылку, по ней он сразу получит итоги.</p>
            )}
            <div className="fu-row">
              {has('send_chat') && (
                <Button size="sm" variant="outline" loading={busy === 'send_chat'} disabled={!!busy || !body.trim()} onClick={() => void viaOther('send_chat')}>
                  <Icon name="chat" size={14} /> Во внешний чат
                </Button>
              )}
              {has('send_mail') && (
                <Button size="sm" variant="outline" loading={busy === 'send_mail'} disabled={!!busy || !body.trim()} onClick={() => void viaOther('send_mail')}>
                  <Icon name="mail" size={14} /> Письмом
                </Button>
              )}
              <Button size="sm" variant="outline" loading={busy === 'copy'} disabled={!!busy || !body.trim()} onClick={() => void copyText()}>
                <Icon name="copy" size={14} /> Скопировать
              </Button>
              <Button size="sm" variant="ghost" aria-pressed={edit} disabled={!!busy} onClick={() => setEdit((v) => !v)}>
                <Icon name="edit" size={14} /> {edit ? 'Готово, текст поправлен' : 'Поправить текст'}
              </Button>
            </div>
          </>
        )}

        {stage.kind === 'link' && (
          <div className="fu-link">
            <p className="fu-ask">{stage.note || 'Клиент ещё не подключил Telegram.'}</p>
            <p className="fu-hint">Отправьте ему ссылку — по ней бот QEVO сразу пришлёт итоги, а следующие будут приходить туда же. Ссылка одноразовая, действует 14 дней.</p>
            <input className="input fu-url" readOnly value={stage.url} aria-label="Ссылка для клиента" onFocus={(e) => e.currentTarget.select()} />
            {err && <div className="error-text fu-err" role="alert"><Icon name="alert" size={12} /> {err}</div>}
            <div className="fu-row">
              <Button size="sm" variant="primary" onClick={() => void copy(stage.url, 'link')}>
                <Icon name={copied === 'link' ? 'check' : 'copy'} size={14} /> {copied === 'link' ? 'Ссылка скопирована' : 'Скопировать ссылку'}
              </Button>
              {pay.chatId && (
                <Button size="sm" variant="outline" loading={busy === 'send_tgchat'} disabled={!!busy}
                        onClick={() => void run('send_tg', { via: 'chat', code: stage.code })}>
                  <Icon name="chat" size={14} /> Отправить ссылку во внешний чат
                </Button>
              )}
              {pay.email && has('send_mail') && (
                <Button size="sm" variant="outline" loading={busy === 'send_tgmail'} disabled={!!busy}
                        onClick={() => void run('send_tg', { via: 'mail', code: stage.code })}>
                  <Icon name="mail" size={14} /> Отправить ссылку письмом
                </Button>
              )}
            </div>
          </div>
        )}

        {stage.kind === 'done' && (
          <p className="fu-done" role="status"><Icon name="check" size={16} /> {stage.text}</p>
        )}
        {copied === 'text' && stage.kind !== 'link' && <span className="fu-hint" role="status">Текст скопирован</span>}
      </div>
    </Dialog>
  );
}

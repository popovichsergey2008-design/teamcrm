import { createRoot } from 'react-dom/client';
import { useState, type MouseEvent } from 'react';
import '../legal/legal.css';
import { Dialog } from '../ui/dialog';
import { ApiError, request } from '../../lib/api';
import { LEGAL } from '../../legal';
import { LegalDoc } from '../legal/LegalDoc';

/** Откуда спросили согласие — пишется в журнал (#4675). */
export type ConsentVia = 'button' | 'screen' | 'access';

export interface RemoteConsentState { active: boolean; expiresAt: string | null; version: string }

/** Живое согласие по обращению — чтобы за одну сессию не спрашивать дважды. */
export const remoteConsentState = (conversationId: string) =>
  request<RemoteConsentState>('GET', `/support/desk/${conversationId}/remote-consent`);

/** Галочка + «Разрешить доступ»: в журнал на сервере — время, IP, устройство, версия текста. */
export const giveRemoteConsent = (conversationId: string, via: ConsentVia, extra?: { roomId?: string; grantId?: string }) =>
  request<RemoteConsentState>('POST', `/support/desk/${conversationId}/remote-consent`, { via, ...extra });

function ConsentHost({ intro, accept, onDone }: {
  intro?: string;
  accept: () => Promise<void>;
  onDone: (ok: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Текст политики — прямо в этом окне: второе окно поверх первого закрывало бы его щелчком «мимо». */
  const [doc, setDoc] = useState(false);
  const close = (ok: boolean) => { setOpen(false); onDone(ok); };
  const showPolicy = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setDoc((v) => !v);
  };
  const allow = async () => {
    if (!agreed || busy) return;
    setBusy(true); setErr('');
    try { await accept(); close(true); }
    catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : 'Не получилось сохранить согласие'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v && !busy) close(false); }}
      title="Помощь через удалённый доступ"
      footer={(
        <>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" disabled={busy} onClick={() => close(false)}>Отмена</button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={!agreed || busy} onClick={() => void allow()}>
            {busy ? 'Сохраняем…' : 'Разрешить доступ'}
          </button>
        </>
      )}
    >
      <div className="remote-consent">
        <p>
          {intro ?? 'Специалист поддержки подключится к созвону: вы покажете вкладку QEVO, а по просьбе специалиста сможете открыть ему настройки проекта на 15 минут.'}
        </p>
        <ul>
          <li>Сессию запускаете вы; согласие действует только на эту сессию.</li>
          <li>Показ можно поставить на паузу или завершить в любой момент.</li>
          <li>Перед показом закройте то, что показывать не хотите.</li>
        </ul>
        <p>
          Подробно — в{' '}
          <a href={LEGAL['remote-support'].path} target="_blank" rel="noopener" onClick={showPolicy} aria-expanded={doc}>Политике удалённой технической поддержки</a>
          {' '}(редакция от {LEGAL['remote-support'].date}, {LEGAL['remote-support'].version}).
        </p>
        {doc && (
          <div className="legal-dialog-body remote-consent-doc" tabIndex={0} role="region" aria-label="Текст Политики удалённой технической поддержки">
            <LegalDoc kind="remote-support" inDialog />
          </div>
        )}
        <label className="remote-consent-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={busy} />
          <span>Я прочитал(а) Политику удалённой поддержки и даю согласие на доступ специалиста</span>
        </label>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * Окно согласия на удалённую помощь (#4675). `accept` — что сделать по «Разрешить
 * доступ» (записать согласие на сервере); ошибка остаётся в окне, а не теряется.
 * Возвращает true, только если согласие записано.
 */
export function askRemoteConsent(opts: { accept: () => Promise<void>; intro?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => {
      resolve(ok);
      window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    root.render(<ConsentHost intro={opts.intro} accept={opts.accept} onDone={done} />);
  });
}

/**
 * Согласие перед показом экрана или доступом на 15 минут: уже дано на эту сессию —
 * не спрашиваем ('active'); нет — спрашиваем и записываем ('given'); отказ — false.
 */
export async function ensureRemoteConsent(
  conversationId: string, via: ConsentVia, extra?: { roomId?: string; grantId?: string; intro?: string },
): Promise<'active' | 'given' | false> {
  const state = await remoteConsentState(conversationId).catch(() => null);
  if (state?.active) return 'active';
  const ok = await askRemoteConsent({
    intro: extra?.intro,
    accept: async () => { await giveRemoteConsent(conversationId, via, { roomId: extra?.roomId, grantId: extra?.grantId }); },
  });
  return ok ? 'given' : false;
}

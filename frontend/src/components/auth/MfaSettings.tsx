import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth-api';

type Status = { enabled: boolean; recoveryLeft: number };
type Step =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; uri: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'disable' }
  | { kind: 'regen' };

/** QR-код ссылки otpauth:// — тёмные модули квадратами, светлый фон (сканеры не любят инверсию). */
function Qr({ text }: { text: string }) {
  const cells = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [text]);
  const pad = 4;
  const size = cells.n + pad * 2;
  return (
    <svg className="mfa-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR-код для приложения-генератора">
      <rect width={size} height={size} fill="#fff" />
      {cells.dark.map(([x, y]) => <rect key={`${x}-${y}`} x={x + pad} y={y + pad} width={1.02} height={1.02} fill="#000" />)}
    </svg>
  );
}

/**
 * Двухфакторный вход в профиле: включить по QR-коду, показать резервные коды один раз,
 * выключить паролем и кодом. Ленивый — у большинства этот экран не открывается никогда.
 */
export default function MfaSettings({ onEnabled }: { onEnabled?: () => void } = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => authApi.mfaStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void load(); }, []);

  const reset = (next: Step = { kind: 'idle' }) => { setStep(next); setPassword(''); setCode(''); setError(''); };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };

  if (!status) return null;

  return (
    <div className="mfa-box">
      <div className="drawer-section-title" style={{ marginTop: 18 }}>Вход по коду из приложения</div>
      {step.kind === 'idle' && (
        <>
          <p className="dim mfa-text">
            {status.enabled
              ? `Включён. После пароля QEVO спрашивает шесть цифр из приложения. Резервных кодов осталось: ${status.recoveryLeft}.`
              : 'Даже если пароль украдут, без телефона в аккаунт не войти. Нужно приложение-генератор: Google Authenticator, Яндекс Ключ, 1Password и т. п.'}
          </p>
          {status.enabled ? (
            <div className="mfa-row">
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => reset({ kind: 'regen' })}>Новые резервные коды</button>
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => reset({ kind: 'disable' })}>Выключить</button>
            </div>
          ) : (
            <button className="ui-btn ui-btn-primary ui-btn-md" style={{ width: '100%' }} onClick={() => reset({ kind: 'password' })}>Включить</button>
          )}
        </>
      )}

      {step.kind === 'password' && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await authApi.mfaSetup(password); reset({ kind: 'scan', secret: r.secret, uri: r.otpauthUri }); }); }}>
          <div className="field"><label htmlFor="mfa-pw">Ваш пароль</label><input id="mfa-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></div>
          <div className="error-text" role="alert">{error}</div>
          <div className="mfa-row">
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} type="submit">Дальше</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" type="button" onClick={() => reset()}>Отмена</button>
          </div>
        </form>
      )}

      {step.kind === 'scan' && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await authApi.mfaEnable(code); reset({ kind: 'codes', codes: r.recoveryCodes }); void load(); }); }}>
          <p className="dim mfa-text">Отсканируйте код приложением. На телефоне можно <a href={step.uri}>открыть ссылку</a> или ввести ключ вручную:</p>
          <Qr text={step.uri} />
          <code className="mfa-secret">{step.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <div className="field"><label htmlFor="mfa-code-set">Шесть цифр из приложения</label><input id="mfa-code-set" className="input auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus /></div>
          <div className="error-text" role="alert">{error}</div>
          <div className="mfa-row">
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !code.trim()} type="submit">Включить</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" type="button" onClick={() => reset()}>Отмена</button>
          </div>
        </form>
      )}

      {step.kind === 'codes' && (
        <>
          <p className="mfa-text"><b>Сохраните резервные коды.</b> Они нужны, если телефон потеряется: каждый код входит один раз. Больше мы их не покажем.</p>
          <ul className="mfa-codes">{step.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <div className="mfa-row">
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void navigator.clipboard?.writeText(step.codes.join('\n')).catch(() => undefined); }}>Скопировать</button>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { reset(); onEnabled?.(); }}>Я сохранил коды</button>
          </div>
        </>
      )}

      {(step.kind === 'disable' || step.kind === 'regen') && (
        <form onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (step.kind === 'disable') { await authApi.mfaDisable(password, code); reset(); }
            else { const r = await authApi.mfaRecoveryCodes(code); reset({ kind: 'codes', codes: r.recoveryCodes }); }
            void load();
          });
        }}>
          {step.kind === 'disable' && (
            <div className="field"><label htmlFor="mfa-pw-off">Ваш пароль</label><input id="mfa-pw-off" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></div>
          )}
          <div className="field"><label htmlFor="mfa-code-off">Код из приложения или резервный код</label><input id="mfa-code-off" className="input" autoComplete="one-time-code" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus={step.kind === 'regen'} /></div>
          <div className="error-text" role="alert">{error}</div>
          <div className="mfa-row">
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} type="submit">{step.kind === 'disable' ? 'Выключить' : 'Выдать новые коды'}</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" type="button" onClick={() => reset()}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}

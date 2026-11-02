import { FormEvent, useEffect, useState } from 'react';
import { fmtDate, pc, PcError } from './api';

interface Version {
  id: string; version: number; last4: string; status: 'pending' | 'active' | 'retired' | 'revoked'; note: string | null; expires_at: string | null;
  check_ok: boolean | null; check_message: string | null; checked_at: string | null; created_at: string; activated_at: string | null;
  revoked_at: string | null; revoke_reason: string | null; by_email: string | null;
}
interface Managed { name: string; service: string; purpose: string; source: 'registry' | 'env' | 'none'; envLast4: string | null; versions: Version[] }
interface EnvOnly { name: string; service: string; purpose: string; source: 'registry' | 'env' | 'none'; envLast4: string | null }
interface Data { managed: Managed[]; envOnly: EnvOnly[] }

const STATUS: Record<Version['status'], string> = { pending: 'добавлен, не используется', active: 'используется', retired: 'выведен', revoked: 'отозван' };
const SOURCE: Record<Managed['source'], string> = { registry: 'из реестра', env: 'из файла настроек сервера', none: 'не задан' };
const err = (e: unknown) => (e instanceof PcError ? e.message : 'Не получилось');

/**
 * Общие ключи платформы (§5.6). Значение вводится один раз и больше не показывается
 * никому: здесь только последние 4 символа, статус и проверка. Порядок замены —
 * добавить → проверить → активировать → (прежний выведен) → отозвать.
 */
export default function SecretsTab({ canManage }: { canManage: boolean }) {
  const [d, setD] = useState<Data | null>(null);
  const [e, setE] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const load = () => pc<Data>('GET', '/pc/owner/secrets').then(setD).catch((x) => setE(err(x)));
  useEffect(() => { void load(); }, []);

  const act = async (path: string, body?: unknown, ask?: string) => {
    if (ask && !window.confirm(ask)) return;
    setE('');
    try { await pc('POST', path, body ?? {}); await load(); } catch (x) { setE(err(x)); }
  };
  const revoke = (k: Managed, v: Version) => {
    const reason = window.prompt(v.status === 'active'
      ? `Отозвать действующий ключ ${k.service}? Сервер сразу перестанет его использовать${k.envLast4 ? ` и вернётся к ключу из файла настроек (${k.envLast4})` : ' — ключа не останется'}. Причина:`
      : 'Отозвать ключ? Значение будет стёрто без возможности вернуть. Причина:');
    if (reason === null) return;
    if (!reason.trim()) { setE('Укажите причину отзыва'); return; }
    void act(`/pc/owner/secrets/${v.id}/revoke`, { reason: reason.trim() });
  };

  if (!d) return e ? <p className="pc-err">{e}</p> : <p className="dim">Загрузка…</p>;
  return (
    <section>
      <p className="dim pc-meta">
        Ключ вводится один раз и больше не показывается никому — ни здесь, ни в журнале. Сервер подхватывает замену за 30 секунд, без перезапуска.
        Пока в реестре нет действующей версии, работает ключ из файла настроек сервера. Ключи компаний-клиентов здесь не хранятся.
      </p>
      {e && <p className="pc-err">{e}</p>}
      {d.managed.map((k) => (
        <div key={k.name} className="pc-card pc-gap">
          <div className="pc-row pc-between pc-wrap">
            <div>
              <b>{k.service}</b> <span className="pc-tag">{k.name}</span>
              <div className="dim">{k.purpose}</div>
              <div>Сейчас: {SOURCE[k.source]}{k.source === 'env' && k.envLast4 ? ` (${k.envLast4})` : ''}</div>
            </div>
            {canManage && adding !== k.name && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => setAdding(k.name)}>Добавить новую версию</button>}
          </div>
          {adding === k.name && <AddForm name={k.name} onDone={() => { setAdding(null); void load(); }} onCancel={() => setAdding(null)} />}
          {k.versions.length > 0 && (
            <div className="pc-table-wrap pc-gap">
              <table className="pc-table">
                <thead><tr><th>Версия</th><th>Ключ</th><th>Статус</th><th>Проверка</th><th>Добавлен</th><th /></tr></thead>
                <tbody>
                  {k.versions.map((v) => (
                    <tr key={v.id} className={v.status === 'revoked' || v.status === 'retired' ? 'dim' : ''}>
                      <td>v{v.version}</td>
                      <td className="pc-mono">{v.last4}{v.expires_at ? <div className="dim">до {v.expires_at}</div> : null}</td>
                      <td>{STATUS[v.status]}{v.revoke_reason ? <div className="dim">{v.revoke_reason}</div> : null}</td>
                      <td className={v.check_ok === false ? 'pc-down' : v.check_ok ? 'pc-up' : 'dim'}>{v.check_message ?? '—'}{v.checked_at ? <div className="dim">{fmtDate(v.checked_at)}</div> : null}</td>
                      <td>{fmtDate(v.created_at)}<div className="dim">{v.by_email ?? ''}{v.note ? ` · ${v.note}` : ''}</div></td>
                      <td>
                        {canManage && v.status !== 'revoked' && (
                          <div className="pc-actions">
                            <button type="button" className="pc-link" onClick={() => void act(`/pc/owner/secrets/${v.id}/check`)}>Проверить</button>
                            {(v.status === 'pending' || v.status === 'retired') && (
                              <button type="button" className="pc-link" onClick={() => void act(`/pc/owner/secrets/${v.id}/activate`, undefined,
                                `${v.status === 'retired' ? 'Вернуть' : 'Активировать'} v${v.version} (${v.last4})? Сервер начнёт использовать его в течение 30 секунд${v.check_ok === false ? '. ВНИМАНИЕ: проверка не прошла' : ''}.`)}>
                                {v.status === 'retired' ? 'Вернуть' : 'Активировать'}
                              </button>
                            )}
                            <button type="button" className="pc-link" onClick={() => revoke(k, v)}>Отозвать</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      <h3>Ключи в файле настроек сервера</h3>
      <p className="dim pc-meta">Эти ключи сервер читает при запуске (почта, оплата, вход через Google, Telegram) — заменяются пока только на сервере. Здесь видно, задан ли ключ.</p>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Сервис</th><th>Назначение</th><th>Ключ</th></tr></thead>
          <tbody>{d.envOnly.map((k) => (
            <tr key={k.name}><td>{k.service} <span className="pc-tag">{k.name}</span></td><td>{k.purpose}</td><td className="pc-mono">{k.envLast4 ?? <span className="pc-down">не задан</span>}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function AddForm({ name, onDone, onCancel }: { name: string; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault(); setBusy(true); setE('');
    try {
      const r = await pc<{ version: number; check: { ok: boolean | null; message: string } }>('POST', '/pc/owner/secrets', {
        name, value: value.trim(), note: note.trim() || undefined, expiresAt: expires || undefined,
      });
      setValue(''); // значение в памяти страницы дольше не держим
      setResult(`Добавлена v${r.version}. ${r.check.message}. Ключ ещё не используется — нажмите «Активировать».`);
    } catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  if (result) return <div className="pc-gap"><p>{result}</p><button type="button" className="pc-btn" onClick={onDone}>Готово</button></div>;
  return (
    <form className="pc-form pc-gap" onSubmit={submit} autoComplete="off">
      <label>Новый ключ (после сохранения его не увидит никто)
        <input type="password" value={value} onChange={(ev) => setValue(ev.target.value)} required maxLength={500} autoComplete="new-password" spellCheck={false} />
      </label>
      <div className="pc-row pc-wrap">
        <label>Пояснение<input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={300} placeholder="например, «ротация после ухода сотрудника»" /></label>
        <label>Действует до (если известно)<input type="date" value={expires} onChange={(ev) => setExpires(ev.target.value)} /></label>
      </div>
      {e && <p className="pc-err">{e}</p>}
      <div className="pc-actions">
        <button className="pc-btn" disabled={busy || !value.trim()}>{busy ? 'Проверяю…' : 'Сохранить и проверить'}</button>
        <button type="button" className="pc-btn pc-btn-ghost" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

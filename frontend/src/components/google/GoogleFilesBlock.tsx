import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { confirmAction } from '../ui/dialog';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { agoLabel } from '../../lib/presence';
import {
  connectGoogle, google, GoogleEntity, GoogleFile, googleKind, GoogleStatus, pickGoogleFiles,
} from '../../lib/google';
import './google.css';

/** Какой документ создаёт кнопка — словами, у каждой сущности свой (§54). */
const DOC_LABEL: Record<GoogleEntity, string> = {
  task: 'Рабочий документ',
  project: 'Документ проекта',
  client: 'Итоги для клиента',
  event: 'Протокол встречи',
};

/**
 * Файлы Google при задаче, проекте, клиенте или встрече (#1565, §37, §100–102).
 *
 * Три действия, и все — там, где человек уже работает: прикрепить файл с Диска,
 * создать Google-документ с данными QEVO, открыть. Сам файл живёт в Google; убрать
 * его отсюда — не значит удалить в Google.
 */
export function GoogleFilesBlock({ entityType, entityId, compact }: { entityType: GoogleEntity; entityId: string; compact?: boolean }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [files, setFiles] = useState<GoogleFile[] | null>(null);
  const [busy, setBusy] = useState<'' | 'pick' | 'doc'>('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    google.links(entityType, entityId).then(setFiles).catch(() => setFiles([]));
  }, [entityType, entityId]);
  useEffect(() => {
    load();
    google.status().then(setStatus).catch(() => setStatus(null));
  }, [load]);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(''), 4000);
    return () => window.clearTimeout(t);
  }, [note]);

  // сервер ещё не настроен и файлов нет — блок не показываем вовсе: кнопка, которая
  // ничего не может, хуже отсутствия кнопки
  if (status && !status.configured && !files?.length) return null;

  const acc = status?.account;
  const ready = !!acc && acc.status === 'active' && acc.drive;
  const fail = (e: unknown, fallback: string) => setErr(e instanceof ApiError ? e.message : fallback);

  const pick = async () => {
    if (!status?.picker) { setErr('Окно выбора файлов Google ещё не настроено на сервере'); return; }
    setErr(''); setBusy('pick');
    try {
      const ids = await pickGoogleFiles(status.picker);
      if (!ids.length) return;
      const r = await google.link(entityType, entityId, ids);
      setFiles(r.items);
      if (r.failed.length) setErr(`Не прикрепились: ${r.failed.length} из ${ids.length} — нет доступа или файл удалён`);
      else setNote(ids.length === 1 ? 'Файл прикреплён' : `Прикреплено файлов: ${ids.length}`);
    } catch (e) { fail(e, 'Не удалось прикрепить файлы'); }
    finally { setBusy(''); }
  };

  const createDoc = async () => {
    setErr(''); setBusy('doc');
    // окно открываем сразу, по нажатию: открытое после ответа сервера браузер заблокирует
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const r = await google.createDoc(entityType, entityId);
      setFiles(r.items);
      if (tab) tab.location.href = r.url; else window.open(r.url, '_blank', 'noopener');
      setNote('Документ создан и прикреплён');
    } catch (e) { tab?.close(); fail(e, 'Не удалось создать документ'); }
    finally { setBusy(''); }
  };

  const remove = async (f: GoogleFile) => {
    if (!(await confirmAction({
      title: `Убрать «${f.name}»?`,
      description: 'Файл останется в Google Диске — уберётся только ссылка здесь.',
      confirmLabel: 'Убрать',
    }))) return;
    try { await google.unlink(f.id); setFiles((list) => (list ?? []).filter((x) => x.id !== f.id)); }
    catch (e) { fail(e, 'Не удалось убрать файл'); }
  };

  return (
    <section className={`gfiles${compact ? ' gfiles-compact' : ''}`} aria-label="Файлы Google">
      <div className="gfiles-head">
        <h4><GoogleMark /> Google Диск</h4>
        {ready && (
          <div className="gfiles-actions">
            <Button size="sm" variant="outline" onClick={pick} loading={busy === 'pick'} disabled={!!busy}>
              <Icon name="paperclip" size={14} /> Прикрепить с Диска
            </Button>
            <Button size="sm" variant="outline" onClick={createDoc} loading={busy === 'doc'} disabled={!!busy}
              title="Новый Google-документ с данными отсюда — откроется в новой вкладке">
              <Icon name="file" size={14} /> {DOC_LABEL[entityType]}
            </Button>
          </div>
        )}
      </div>

      {status?.configured && !ready && (
        <div className="gfiles-connect">
          <span>
            {acc?.status === 'attention'
              ? 'Доступ к Google нужно подключить заново.'
              : acc && !acc.drive
                ? 'Разрешите доступ к Google Диску — и прикрепляйте файлы прямо отсюда.'
                : 'Подключите свой Google — прикрепляйте файлы с Диска и создавайте документы прямо отсюда.'}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void connectGoogle('drive').catch((e) => fail(e, 'Не удалось открыть Google'))}>
            Подключить Google Диск
          </Button>
          <Button size="sm" variant="link" onClick={() => navigate({ section: 'settings', tab: 'google' })}>Настройки</Button>
        </div>
      )}

      {files && files.length > 0 && (
        <ul className="gfiles-list">
          {files.map((f) => (
            <li key={f.id} className="gfiles-row">
              {f.iconUrl ? <img src={f.iconUrl} alt="" className="gfiles-icon" referrerPolicy="no-referrer" /> : <Icon name="file" size={16} />}
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="gfiles-name" title="Открыть в Google">{f.name}</a>
              <span className="gfiles-meta">
                {googleKind(f.mimeType)}
                {f.modifiedAt ? ` · изменён ${agoLabel(f.modifiedAt)}` : ''}
                {f.addedBy ? ` · ${f.origin === 'created' ? 'создал' : 'прикрепил'} ${f.addedBy}` : ''}
              </span>
              {f.canRemove && (
                <Button size="icon-sm" variant="ghost" onClick={() => void remove(f)} title="Убрать отсюда (в Google файл останется)" aria-label={`Убрать ${f.name}`}>
                  <Icon name="close" size={14} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files && files.length > 0 && (
        <p className="gfiles-hint">Права на файлы задаёт Google: если коллега не может открыть файл, откройте в Google «Настройки доступа».</p>
      )}
      {note && <p className="gfiles-ok" role="status"><Icon name="check" size={13} /> {note}</p>}
      {err && <p className="gfiles-err" role="alert">{err}</p>}
    </section>
  );
}

/** Значок Google — четыре цвета, чтобы блок узнавали с первого взгляда. */
export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

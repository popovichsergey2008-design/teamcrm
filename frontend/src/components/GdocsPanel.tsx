import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import type { Project } from '../types';

/**
 * Google-документы — слой 4 «переезда в один клик».
 *
 * Два пути, и оба нужны: найти ссылки, которые уже разбросаны по задачам и переписке,
 * и принести документы ссылками руками — переезд как раз про те регламенты и брифы,
 * о которых в системе ещё нет ни слова.
 *
 * Читаются документы, открытые «по ссылке». Это граница, и о ней сказано прямо: чужой
 * закрытый документ система прочитать не может и врать об этом не будет — он попадёт
 * в список с причиной «нет доступа».
 */

const STATUS_LABEL: Record<string, string> = {
  indexed: 'прочитан',
  pending: 'в очереди',
  no_access: 'нет доступа',
  unsupported: 'формат без текста',
  error: 'ошибка',
};

export function GdocsPanel() {
  const [status, setStatus] = useState<{ scanning: boolean; total: number; byStatus: Record<string, number> } | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [links, setLinks] = useState('');
  const [projectId, setProjectId] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reload = () => {
    api.gdocsStatus().then(setStatus).catch(() => undefined);
    api.gdocsList().then(setDocs).catch(() => undefined);
  };
  useEffect(() => {
    reload();
    api.listProjects().then(setProjects).catch(() => undefined);
  }, []);

  // Пока скан идёт, экран обновляется сам: молчащий экран читается как «ничего не
  // происходит», и человек жмёт кнопку второй раз.
  useEffect(() => {
    if (!status?.scanning) return;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
  }, [status?.scanning]);

  const scan = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api.gdocsScan();
      setMsg(r.started ? 'Ищу ссылки в задачах, комментариях и переписке…' : 'Скан уже идёт');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось запустить');
    }
  };

  const add = async () => {
    if (!links.trim()) return setErr('Вставьте ссылки на документы');
    setErr(''); setMsg('');
    try {
      const r = await api.gdocsAddLinks(links, projectId || undefined);
      setMsg(r.added ? `Добавлено документов: ${r.added}. Читаю…` : 'Ссылок на Google-документы в тексте не нашлось');
      setLinks('');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось добавить');
    }
  };

  const counts = status?.byStatus ?? {};
  const noAccess = Number(counts.no_access ?? 0);

  return (
    <div className="import-file">
      <p className="dim">
        Документы Google уезжают в базу знаний: по ним ищет поиск, их читает ИИ-помощник и
        видит секретарь. Читаются документы, открытые <b>«по ссылке»</b> — доступ к личным
        файлам мы не запрашиваем и не храним.
      </p>

      <div className="drawer-section">
        <div className="drawer-section-title">Найти в системе</div>
        <button className="btn btn-sm" onClick={scan} disabled={!!status?.scanning}>
          <Icon name="search" size={14} /> {status?.scanning ? 'Ищу…' : 'Просканировать задачи и переписку'}
        </button>
        <div className="dim">
          Соберём все ссылки на Google-документы из описаний задач, комментариев и чатов
          проектов — и прочитаем те, что открыты по ссылке.
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-section-title">Принести ссылками</div>
        <textarea
          className="input" rows={3} value={links}
          placeholder="Вставьте ссылки на документы — можно списком или прямо куском переписки"
          onChange={(e) => setLinks(e.target.value)}
        />
        <div className="import-target">
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— проект по умолчанию —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={add}>Добавить и прочитать</button>
        </div>
        <div className="dim">
          Документ живёт при проекте: знание без разреза по проекту потом нечем искать.
        </div>
      </div>

      {msg && <div className="dim">{msg}</div>}
      {err && <div className="error-text">{err}</div>}

      {status && status.total > 0 && (
        <div className="import-nums">
          <span><b>{status.total}</b> всего</span>
          <span><b>{counts.indexed ?? 0}</b> прочитано</span>
          {noAccess > 0 && <span><b>{noAccess}</b> без доступа</span>}
        </div>
      )}

      {noAccess > 0 && (
        // Не прячем проблему в счётчике: человеку нужно одно действие, и оно известно
        <div className="dim">
          Документы без доступа откроются, если в самом Google нажать «Доступ» →
          «Все, у кого есть ссылка» → «Читатель». После этого достаточно повторить скан.
        </div>
      )}

      {docs.length === 0 ? (
        <EmptyState
          compact icon="book" title="Документов пока нет"
          hint="Просканируйте задачи и переписку или принесите ссылки — прочитанные документы попадут в базу знаний."
        />
      ) : (
        <div className="import-sample">
          <table>
            <thead>
              <tr><th>Документ</th><th>Проект</th><th>Состояние</th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td title={d.url}>{d.title || d.url}</td>
                  <td>{d.project_name ?? '—'}</td>
                  <td>
                    {STATUS_LABEL[d.status] ?? d.status}
                    {d.error && <span className="dim"> · {String(d.error).slice(0, 60)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

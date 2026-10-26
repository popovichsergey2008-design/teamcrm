import { useState, type FormEvent } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { api, ApiError, type HubDecision, type HubItem } from '../../lib/api';
import { navigate } from '../../lib/router';
import { platform } from '../../platform';
import { categoryLabel, dayLabel, hostOf, itemIcon, originLabel, originPath, safeHref } from '../../lib/hub';

/** Текст ошибки сервера по-русски, без кодов. */
export function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Открыть запись: ссылку — в новой вкладке (только http/https), файл — скачать.
 * Файлы лежат за авторизацией, поэтому обычная ссылка на них дала бы 401.
 */
export async function openHubItem(item: HubItem): Promise<void> {
  if (item.kind === 'file' && item.fileId) {
    const blob = await api.authedBlob(`/api/files/${item.fileId}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = item.fileName ?? item.title; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  const href = safeHref(item.url);
  if (href) platform.openExternal(href);
}

/** Метка «ИИ»: запись положил библиотекарь; в подсказке — откуда он её взял. */
export function AiMark({ item, inline }: { item: Pick<HubItem, 'source' | 'origin'>; inline?: boolean }) {
  if (item.source !== 'ai') return null;
  const where = originLabel(item.origin);
  const path = originPath(item.origin);
  if (inline) {
    return (
      <span className="hub-ai-line">
        <span className="hub-ai" aria-label="Добавил ИИ"><Icon name="sparkles" size={11} /> ИИ</span>
        {path
          ? <button type="button" className="hub-linkish" onClick={() => navigate(path)}>{where}</button>
          : <span>{where}</span>}
      </span>
    );
  }
  return (
    <Tooltip content={`Добавил ИИ ${where}`}>
      <span className="hub-ai" tabIndex={0} aria-label={`Добавил ИИ ${where}`}><Icon name="sparkles" size={11} /> ИИ</span>
    </Tooltip>
  );
}

/** Строка записи: значок по категории, название, домен; действия — у тех, кто правит. */
export function ItemRow({ item, canEdit, compact, onPin, onEdit, onRemove, onError }: {
  item: HubItem;
  canEdit?: boolean;
  compact?: boolean;
  onPin?: (item: HubItem) => void;
  onEdit?: (item: HubItem) => void;
  onRemove?: (item: HubItem) => void;
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const openable = (item.kind === 'file' && !!item.fileId) || !!safeHref(item.url);
  const meta = [categoryLabel(item.section, item.category), item.kind === 'file' ? (item.fileName ?? 'файл') : hostOf(item.url)]
    .filter(Boolean).join(' · ');
  const open = async () => {
    setBusy(true);
    try { await openHubItem(item); } catch (e) { onError?.(errText(e, 'Не удалось открыть файл')); } finally { setBusy(false); }
  };
  return (
    <li className={`hub-row${compact ? ' hub-row-compact' : ''}`}>
      <span className="hub-row-icon" aria-hidden="true"><Icon name={itemIcon(item)} size={compact ? 14 : 16} /></span>
      <span className="hub-row-main">
        {openable ? (
          <button type="button" className="hub-row-title hub-linkish" onClick={() => void open()} aria-busy={busy} title={item.url ?? item.fileName ?? item.title}>
            {item.title}
          </button>
        ) : (
          <span className="hub-row-title">{item.title}</span>
        )}
        {!compact && item.body && item.kind === 'note' && <span className="hub-row-body">{item.body}</span>}
        {!compact && meta && <span className="hub-row-meta">{meta}</span>}
        {!compact && <AiMark item={item} inline />}
      </span>
      {item.pinned && compact && <span className="hub-pinned" title="Закреплено" aria-label="Закреплено"><Icon name="pin" size={12} /></span>}
      {compact && <AiMark item={item} />}
      {!compact && canEdit && (
        <span className="hub-row-acts">
          {onPin && (
            <Button variant="ghost" size="icon-sm" aria-pressed={item.pinned} onClick={() => onPin(item)}
              aria-label={item.pinned ? 'Открепить' : 'Закрепить в колонке'} title={item.pinned ? 'Открепить' : 'Закрепить в колонке'}>
              <Icon name="pin" size={14} />
            </Button>
          )}
          {onEdit && (
            <Button variant="ghost" size="icon-sm" onClick={() => onEdit(item)} aria-label="Изменить" title="Изменить">
              <Icon name="edit" size={14} />
            </Button>
          )}
          {onRemove && (
            <Button variant="ghost" size="icon-sm" onClick={() => onRemove(item)} aria-label="Убрать" title="Убрать">
              <Icon name="trash" size={14} />
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

/** Решение: дата, текст, кто сказал и переход к источнику — на секунду созвона или к сообщению. */
export function DecisionRow({ d, clamp }: { d: HubDecision; clamp?: boolean }) {
  return (
    <li className="hub-decision">
      <span className="hub-decision-date">{dayLabel(d.decidedAt)}{d.speaker ? ` · ${d.speaker}` : ''}</span>
      <span className={`hub-decision-text${clamp ? ' hub-clamp' : ''}`}>{d.text}</span>
      {d.link && (
        <button type="button" className="hub-linkish hub-decision-src" onClick={() => navigate(d.link!)}>
          {d.source === 'meeting' ? 'из созвона' : 'из чата'} <Icon name="chevron-right" size={12} />
        </button>
      )}
    </li>
  );
}

type Answer = Awaited<ReturnType<typeof api.hubAsk>>;

/** Вопрос про проект: ответ ИИ по документам, решениям и переписке — с источниками. */
export function AskBox({ projectId, big }: { projectId: string; big?: boolean }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true); setErr(''); setAnswer(null);
    try { setAnswer(await api.hubAsk(projectId, text)); }
    catch (ex) { setErr(errText(ex, 'Не получилось спросить — попробуйте ещё раз')); }
    finally { setBusy(false); }
  };
  return (
    <div className={`hub-ask${big ? ' hub-ask-big' : ''}`}>
      <form className="hub-ask-form" onSubmit={(e) => void submit(e)} role="search">
        <input
          className={`ui-input ${big ? 'ui-input-md' : 'ui-input-sm'}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Спросить про проект…"
          aria-label="Спросить про проект"
          maxLength={500}
        />
        <Button type="submit" variant="secondary" size={big ? 'icon' : 'icon-sm'} disabled={busy || !q.trim()} aria-label="Спросить" title="Спросить">
          <Icon name={busy ? 'clock' : 'search'} size={14} />
        </Button>
      </form>
      {busy && <p className="hub-hint" role="status">Ищу в документах, решениях и переписке проекта…</p>}
      {err && <p className="hub-err" role="alert">{err}</p>}
      {answer && (
        <div className="hub-answer" role="status">
          <p className="hub-answer-text">{answer.answer}</p>
          {answer.citations.length > 0 && (
            <ul className="hub-cites" aria-label="Источники">
              {answer.citations.map((c, i) => (
                <li key={i}>
                  {c.link
                    ? <button type="button" className="hub-cite" onClick={() => navigate(c.link!)} title="Открыть источник">[{i + 1}] {c.title ?? 'источник'}</button>
                    : <span className="hub-cite hub-cite-static">[{i + 1}] {c.title ?? 'источник'}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

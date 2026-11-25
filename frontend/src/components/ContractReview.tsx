import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ContractReview as Review, docsApi, RiskLevel } from '../lib/secretary-docs-api';
import { Icon } from './Icon';
import { SkeletonList } from './Skeleton';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import './contract-review.css';

const LEVEL: Record<RiskLevel, { label: string; cls: string }> = {
  high: { label: 'Высокий риск', cls: 'cr-high' },
  medium: { label: 'Обратить внимание', cls: 'cr-medium' },
  low: { label: 'На заметку', cls: 'cr-low' },
};

/** Проверка как текст — для чата задачи и буфера обмена. */
function asText(r: Review): string {
  const lines = [`Проверка договора «${r.fileName}»`, r.summary];
  const facts = [r.parties.length ? `Стороны: ${r.parties.join(', ')}` : '', r.subject ? `Предмет: ${r.subject}` : '', r.amount ? `Цена: ${r.amount}` : '', r.term ? `Срок: ${r.term}` : ''].filter(Boolean);
  if (facts.length) lines.push(facts.join('\n'));
  if (r.risks.length) {
    lines.push(`Риски (${r.risks.length}):`);
    r.risks.forEach((x, i) => lines.push(`${i + 1}. [${LEVEL[x.level].label}] ${x.topic}${x.quote ? ` — «${x.quote}»` : ''}\n   Чем опасно: ${x.why}${x.fix ? `\n   Как поправить: ${x.fix}` : ''}`));
  }
  if (r.missing.length) lines.push(`Не хватает: ${r.missing.join('; ')}`);
  lines.push('Это подсказка, а не юридическое заключение: важные договоры покажите юристу.');
  return lines.filter(Boolean).join('\n\n');
}

/**
 * «Проверить договор» (#1476, F21): риски и нетиповые пункты списком — с цитатой,
 * чем опасно и как переписать. Без ключа ИИ работает по типовым правилам (так и пишем).
 * Результат сохраняется на сервере по файлу — повторное открытие не тратит модель.
 */
export function ContractReviewDialog({ fileId, fileName, taskId, onClose }: { fileId: string; fileName: string; taskId?: string; onClose: () => void }) {
  const [r, setR] = useState<Review | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const run = async (force: boolean) => {
    setBusy(true); setErr(''); if (force) setR(null);
    try { setR(await docsApi.contract(fileId, force)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось проверить — попробуйте ещё раз'); } finally { setBusy(false); }
  };
  // проверка — при открытии окна для этого файла; run пересоздаётся на каждом рендере
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(false); }, [fileId]);

  const copy = async () => { if (r) { await navigator.clipboard.writeText(asText(r)).catch(() => undefined); setNote('Скопировано'); } };
  const toChat = async () => {
    if (!r || !taskId) return;
    try { await api.addComment(taskId, asText(r)); setNote('Отправлено в чат задачи'); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось отправить'); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={<><Icon name="shield" size={16} /> Проверка договора</>}
      description={fileName}
      footer={r ? (
        <div className="cr-foot">
          {note && <span className="cr-note"><Icon name="check" size={13} /> {note}</span>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(true)}><Icon name="refresh" size={14} /> Проверить заново</Button>
          <Button size="sm" variant="outline" onClick={() => void copy()}><Icon name="copy" size={14} /> Скопировать</Button>
          {taskId && <Button size="sm" variant="primary" onClick={() => void toChat()}><Icon name="send" size={14} /> В чат задачи</Button>}
        </div>
      ) : undefined}
    >
      {err && <div className="error-text cr-err"><Icon name="alert" size={13} /> {err}</div>}
      {!r && !err && (
        <div className="cr-wait">
          <SkeletonList rows={4} />
          <div className="dim">Читаю договор и ищу рискованные пункты — до минуты на большой документ.</div>
        </div>
      )}
      {r && (
        <div className="cr">
          {r.summary && <p className="cr-summary">{r.summary}</p>}
          {(r.parties.length > 0 || r.subject || r.amount || r.term) && (
            <dl className="cr-facts">
              {r.parties.length > 0 && <><dt>Стороны</dt><dd>{r.parties.join(', ')}</dd></>}
              {r.subject && <><dt>Предмет</dt><dd>{r.subject}</dd></>}
              {r.amount && <><dt>Цена и оплата</dt><dd>{r.amount}</dd></>}
              {r.term && <><dt>Срок</dt><dd>{r.term}</dd></>}
            </dl>
          )}
          {r.risks.length === 0 ? (
            <p className="cr-none"><Icon name="check-circle" size={15} /> Рискованных пунктов не нашли.</p>
          ) : (
            <ol className="cr-risks">
              {r.risks.map((x, i) => (
                <li key={`${x.topic}${i}`} className={`cr-risk ${LEVEL[x.level].cls}`}>
                  <div className="cr-risk-head"><span className="cr-level">{LEVEL[x.level].label}</span><b>{x.topic}</b></div>
                  {x.quote && <blockquote className="cr-quote">«{x.quote}»</blockquote>}
                  {x.why && <div><span className="dim">Чем опасно:</span> {x.why}</div>}
                  {x.fix && <div><span className="dim">Как поправить:</span> {x.fix}</div>}
                </li>
              ))}
            </ol>
          )}
          {r.missing.length > 0 && (
            <div className="cr-missing"><b>Чего не хватает:</b><ul>{r.missing.map((m) => <li key={m}>{m}</li>)}</ul></div>
          )}
          <p className="dim cr-disclaimer">
            {r.rulesOnly ? 'Проверено по типовым формулировкам без ИИ — для полной проверки подключите ключ ИИ в «Интеграциях». ' : ''}
            Это подсказка, а не юридическое заключение: важные договоры покажите юристу.
            {r.cached ? ` Проверено ${new Date(r.checkedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}
          </p>
        </div>
      )}
    </Dialog>
  );
}

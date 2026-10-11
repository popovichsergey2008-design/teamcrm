import { useState } from 'react';
import { Icon } from '../Icon';
import { api, PostcallQualityStats } from '../../lib/api';

/**
 * Качество итогов встреч за 30 дней (ТЗ-22, §52) — для владельца и руководителя.
 * Свёрнуто по умолчанию и грузится по раскрытию: это проверка «работает ли», а не
 * то, что нужно видеть каждый раз, открывая встречи.
 */
export function PostcallQuality() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState<PostcallQualityStats | null>(null);
  const [err, setErr] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !q) api.postcallQuality(30).then(setQ).catch(() => setErr(true));
  };
  const v = (n: number | null | undefined, unit = '%') => (n == null ? '—' : `${n}${unit}`);

  return (
    <div className="pcq">
      <button type="button" className="link-btn pcq-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /> Качество итогов встреч за 30 дней
      </button>
      {open && err && <div className="dim pcq-note">Не удалось загрузить.</div>}
      {open && q && (q.meetings === 0
        ? <div className="dim pcq-note">Пока не было созвонов с итогами.</div>
        : (
          <dl className="pcq-grid">
            <dt>Итоги разобраны</dt><dd>{v(q.reviewRate)} из {q.meetings}{q.unreviewed ? ` · висят дольше суток: ${q.unreviewed}` : ''}</dd>
            <dt>Время до разбора</dt><dd>{q.medianReviewMin == null ? '—' : q.medianReviewMin < 60 ? `${q.medianReviewMin} мин` : `${Math.round(q.medianReviewMin / 60)} ч`} (медиана)</dd>
            <dt>Черновики приняты</dt><dd>{v(q.acceptanceRate)}{q.openDrafts ? ` · ждут решения: ${q.openDrafts}` : ''}</dd>
            <dt>Встреча → задачи</dt><dd>{v(q.meetingToTask)} встреч</dd>
            <dt>Решения записаны</dt><dd>{v(q.decisionCapture)} встреч</dd>
            <dt>Письма клиентам ушли</dt><dd>{v(q.followupSendRate)}</dd>
            <dt>Исправляли исполнителя</dt><dd>{v(q.wrongAssignee)}</dd>
            <dt>Исправляли срок</dt><dd>{v(q.wrongDeadline)}</dd>
            <dt>Исправляли название</dt><dd>{v(q.titleEdited)}</dd>
          </dl>
        ))}
    </div>
  );
}

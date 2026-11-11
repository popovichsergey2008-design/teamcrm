import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { ApiError, request } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import './feedback.css';

/**
 * «Порекомендовали бы QEVO коллеге?» (ТЗ 10.11). Сервер решает, пора ли: после первого
 * созвона с ИИ-протоколом или 10-й задачи, созданной ИИ, и не чаще раза в 60 дней.
 * 9–10 — «Пригласить коллег» и просьба об отзыве; 0–6 — «Что улучшить?» в службу заботы.
 */
export default function NpsPrompt() {
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [improve, setImprove] = useState('');
  const [review, setReview] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // не в первую же секунду: человек пришёл работать, а не отвечать на вопросы
    const t = window.setTimeout(() => {
      request<{ due: boolean }>('GET', '/feedback/nps').then((r) => { if (r.due) setOpen(true); }).catch(() => undefined);
    }, 20_000);
    return () => window.clearTimeout(t);
  }, []);

  if (!open) return null;
  const close = () => setOpen(false);
  const submit = async (after?: () => void) => {
    if (score === null) return;
    setBusy(true); setErr('');
    try {
      await request('POST', '/feedback/nps', {
        score, improve: score <= 6 ? improve.trim() || undefined : undefined,
        review: score >= 9 ? review.trim() || undefined : undefined, consent: score >= 9 ? consent : undefined,
      });
      toastSaved('Спасибо за оценку!');
      close();
      after?.();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить'); } finally { setBusy(false); }
  };
  const promoter = score !== null && score >= 9;
  const critic = score !== null && score <= 6;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }} title="Порекомендовали бы QEVO коллеге?" size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Не сейчас</Button>
          {promoter && <Button variant="outline" disabled={busy} onClick={() => void submit(() => navigate({ section: 'settings', tab: 'billing' }))}><Icon name="users" size={14} /> Пригласить коллег</Button>}
          <Button variant="primary" disabled={score === null || busy || (promoter && !!review.trim() && !consent)} onClick={() => void submit()}>Отправить</Button>
        </>
      )}>
      <div className="nps-scale" role="radiogroup" aria-label="Оценка от 0 до 10">
        {Array.from({ length: 11 }, (_, i) => (
          <button key={i} type="button" role="radio" aria-checked={score === i} className={`nps-dot${score === i ? ' on' : ''}`} onClick={() => setScore(i)}>{i}</button>
        ))}
      </div>
      <div className="nps-ends dim"><span>Точно нет</span><span>Обязательно</span></div>
      {critic && (
        <label className="field" style={{ marginTop: 10 }}><span>Что улучшить?</span>
          <textarea className="input" rows={3} maxLength={2000} value={improve} onChange={(e) => setImprove(e.target.value)} placeholder="Ответ уйдёт в службу заботы — вам ответит живой человек" />
        </label>
      )}
      {promoter && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: '0 0 6px' }}>Спасибо! Можно мы опубликуем ваш отзыв на сайте?</p>
          <textarea className="input" rows={3} maxLength={3000} value={review} onChange={(e) => setReview(e.target.value)} placeholder="Пара предложений о том, чем QEVO помог" aria-label="Текст отзыва" />
          <label className="gbp-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Согласен на публикацию отзыва на qevo.one</label>
        </div>
      )}
      {err && <p className="error-text" role="alert">{err}</p>}
    </Dialog>
  );
}

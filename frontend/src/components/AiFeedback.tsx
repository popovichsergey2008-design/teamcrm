import { useState } from 'react';
import { ApiError } from '../lib/api';

/**
 * «ИИ определил правильно?» (ТЗ-12, разд. 59).
 *
 * Два нажатия, не больше: «Да» — и всё; «Нет» — отметить, что было не так, и отправить.
 * Причины — короткий список, одинаковый на сервере: свободный текст не посчитать и на
 * нём не поучиться. Отзыв можно переписать — сервер хранит один на человека.
 */

const REASONS: { key: string; label: string }[] = [
  { key: 'not_action', label: 'Это не задача' },
  { key: 'wrong_assigner', label: 'Неверный постановщик' },
  { key: 'wrong_assignee', label: 'Неверный исполнитель' },
  { key: 'wrong_project', label: 'Неверный проект' },
  { key: 'wrong_deadline', label: 'Неверный срок' },
  { key: 'wrong_text', label: 'Неверно сформулировано' },
];

export function AiFeedback({ send }: { send: (b: { correct: boolean; reasons?: string[] }) => Promise<unknown> }) {
  const [step, setStep] = useState<'ask' | 'why' | 'done'>('ask');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (correct: boolean) => {
    setBusy(true); setErr('');
    try {
      await send({ correct, reasons: correct ? [] : picked });
      setStep('done');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') return <span className="dim ai-fb">Спасибо — учтём.</span>;

  if (step === 'why') {
    return (
      <span className="ai-fb ai-fb-why">
        {REASONS.map((r) => (
          <label key={r.key} className="ai-fb-reason">
            <input
              type="checkbox"
              checked={picked.includes(r.key)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.key] : p.filter((x) => x !== r.key)))}
            />
            {r.label}
          </label>
        ))}
        <button className="btn btn-sm" disabled={busy || !picked.length} onClick={() => void submit(false)}>Отправить</button>
        {err && <span className="error-text">{err}</span>}
      </span>
    );
  }

  return (
    <span className="ai-fb">
      <span className="dim">ИИ определил правильно?</span>
      <button className="link-btn" disabled={busy} onClick={() => void submit(true)}>Да</button>
      <button className="link-btn" disabled={busy} onClick={() => setStep('why')}>Нет</button>
      {err && <span className="error-text">{err}</span>}
    </span>
  );
}

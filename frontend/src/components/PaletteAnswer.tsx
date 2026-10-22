import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';

/**
 * «Второй мозг» в командной строке (#1525, фича 3): вопрос — ответ появляется сам,
 * первым блоком. Формой документа: «14 августа на 12-й минуте созвона с Константином
 * решено: … Вот ссылка на созвон с воспроизведением с 12:15» — и ссылка живая: открывает
 * созвон и играет с нужной секунды.
 *
 * Отдельный кусок сборки: командная строка едет с первым экраном, ответ — по вопросу.
 */
type Answer = Awaited<ReturnType<typeof api.brainAnswer>>;

export function PaletteAnswer({ question, onGo }: { question: string; onGo: (path: string) => void }) {
  const [r, setR] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);

  // пауза — чтобы не спрашивать модель на каждое слово, пока человек допечатывает
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      api.brainAnswer(question)
        .then((x) => { if (alive) setR(x); })
        .catch(() => { if (alive) setFailed(true); });
    }, 700);
    return () => { alive = false; window.clearTimeout(t); };
  }, [question]);

  const link = (path: string, label: string) => (
    <a href={path} onClick={(e) => { e.preventDefault(); onGo(path); }}>{label}</a>
  );
  const sources = (r?.citations ?? []).filter((c) => c.title);

  return (
    <div className="palette-answer" aria-live="polite">
      <div className="palette-answer-head"><Icon name="robot" size={15} /> Ответ по архиву компании</div>
      {failed ? <div>Не удалось получить ответ. Проверьте ключ модели в настройках ИИ.</div>
        : !r ? <div className="muted">Собираю ответ…</div>
          : <div>{r.answer}{r.play && <> {link(r.play.link, r.play.label)}</>}</div>}
      {sources.length > 0 && (
        <div className="palette-answer-src">
          Источники:{' '}
          {sources.map((c, i) => (
            <span key={`${c.sourceType}:${c.sourceId}:${i}`}>
              {i > 0 && ' · '}
              {c.link ? link(c.link, String(c.title)) : c.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

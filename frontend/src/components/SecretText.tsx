import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../lib/api';
import { showToast } from '../lib/notifications';
import type { SecretInfo, SecretSpan } from './MessageText';
import './secret-text.css';

/**
 * Сообщение с паролем или ключом (#4902, п. 13): значение — точками, по клику видно.
 *
 * Отдельным ленивым куском: таких сообщений единицы, а первый экран у нас на пределе.
 * Видят сообщение только участники чата — сервер так отдаёт ленту, — поэтому значение
 * раскрываем на месте, без второго запроса. Рядом — «Перенести в „Секреты“ проекта»:
 * после переноса в тексте остаётся метка, а пароль живёт в зашифрованном хранилище.
 */
const MOVED = '🔒 в Секретах проекта';
const MASK = '••••••';
const token = (i: number) => `QQSECRETQ${i}QQ`;

/** FNV-1a — тот же отпечаток, что считает сервер (common/secrets.ts). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

interface Moved { id: string; title: string; kind: string }

/*
  Разбор разметки и подсветку цитаты получаем от MessageText, а не импортом: общий импорт
  заставил бы сборщик вынести их в отдельные куски первого экрана (+0,9 КБ при запасе 0,3).
*/
export default function SecretText({ text, className, mark, info, toHtml, markFragment }: {
  text: string; className?: string; mark?: string | null; info: SecretInfo;
  toHtml: (text: string) => string;
  markFragment: (root: HTMLElement, text: string) => () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fresh = !info.secret_of || info.secret_of === fingerprint(text);
  const [spans, setSpans] = useState<SecretSpan[]>(info.secret_spans ?? []);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState<Moved[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  /*
    Правку ленты присылают одним новым текстом — старые смещения тогда указывают не туда.
    Отпечаток не сошёлся: пока прячем по-старому (лучше лишнее, чем пароль), и
    спрашиваем у сервера отрезки для нового текста.
  */
  useEffect(() => {
    if (fresh) { setSpans(info.secret_spans ?? []); return; }
    let alive = true;
    request<{ spans: SecretSpan[] }>('GET', `/project-secrets/messages/${info.id}/spans`)
      .then((r) => { if (alive) setSpans(r.spans ?? []); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [fresh, info.id, info.secret_spans, text]);

  const html = useMemo(() => {
    const ok = spans.filter((s) => s.end <= text.length && s.start < s.end);
    let t = text;
    for (let i = ok.length - 1; i >= 0; i--) t = t.slice(0, ok[i].start) + token(i) + t.slice(ok[i].end);
    let h = toHtml(t);
    // внутри ссылки (href) кнопку не вставить — там просто точки
    h = h.replace(/="[^"]*"/g, (attr) => attr.replace(/QQSECRETQ\d+QQ/g, '******'));
    h = h.replace(/QQSECRETQ(\d+)QQ/g, (_, i) =>
      `<button type="button" class="secret-chip" data-secret="${i}" aria-label="Скрытый секрет — показать">${MASK}</button>`);
    h = h.split(MOVED).join(`<button type="button" class="secret-moved" data-secret-moved="1">${MOVED}</button>`);
    return { h, ok };
  }, [spans, text, toHtml]);

  // Раскрытый — показываем значение на месте точек; textContent, не HTML: это чужой текст.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLButtonElement>('button.secret-chip').forEach((b) => {
      const i = Number(b.dataset.secret);
      const s = html.ok[i];
      const shown = open === i && s;
      b.textContent = shown ? text.slice(s.start, s.end) : MASK;
      b.classList.toggle('open', !!shown);
      b.setAttribute('aria-expanded', shown ? 'true' : 'false');
    });
  }, [html, open, text]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !mark) return;
    return markFragment(root, mark);
  }, [html, mark, markFragment]);

  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('button');
    if (!el) return;
    if (el.dataset.secret !== undefined) {
      e.preventDefault();
      const i = Number(el.dataset.secret);
      setOpen((o) => (o === i ? null : i));
    } else if (el.dataset.secretMoved) {
      e.preventDefault();
      if (moved) { setMoved(null); return; }
      request<{ items: Moved[]; hidden: number }>('GET', `/project-secrets/messages/${info.id}`)
        .then((r) => {
          setMoved(r.items);
          if (!r.items.length) showToast({ title: 'Секреты проекта', body: r.hidden ? 'Секрет в проекте, к которому у вас нет доступа' : 'Секрет уже удалён', kind: 'saved' });
        })
        .catch((err: Error) => showToast({ title: 'Секреты проекта', body: err.message, kind: 'saved' }));
    }
  };

  const span = open !== null ? html.ok[open] : null;

  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v).then(() => showToast({ title: 'Скопировано', body: '', kind: 'saved' })).catch(() => undefined);
  };

  const move = async () => {
    if (!span || busy) return;
    setBusy(true);
    try {
      await request('POST', `/project-secrets/messages/${info.id}`, { start: span.start, end: span.end });
      // лента обновится событием правки: в тексте появится метка «🔒 в Секретах проекта»
      setOpen(null);
      showToast({ title: 'Перенесено в «Секреты» проекта', body: 'В сообщении осталась метка, значение — только у участников проекта', kind: 'saved' });
    } catch (err) {
      showToast({ title: 'Не перенесли', body: (err as Error).message, kind: 'saved' });
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (id: string) => {
    if (values[id] !== undefined) {
      setValues((v) => { const next = { ...v }; delete next[id]; return next; });
      return;
    }
    try {
      const r = await request<{ value: string }>('GET', `/project-secrets/${id}/value`);
      setValues((v) => ({ ...v, [id]: r.value }));
    } catch (err) {
      showToast({ title: 'Секреты проекта', body: (err as Error).message, kind: 'saved' });
    }
  };

  return (
    <>
      <div ref={ref} className={`msg-rich ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html.h }} />
      {span && (
        <div className="secret-bar" role="group" aria-label="Скрытый секрет">
          <span className="secret-hint">Скрыто от поиска, сводок и протоколов</span>
          <button type="button" className="secret-act" onClick={() => copy(text.slice(span.start, span.end))}>Скопировать</button>
          <button type="button" className="secret-act primary" disabled={busy} onClick={() => void move()}>
            Перенести в «Секреты» проекта
          </button>
        </div>
      )}
      {moved && moved.length > 0 && (
        <ul className="secret-list">
          {moved.map((m) => (
            <li key={m.id}>
              <span className="secret-title">{m.title}</span>
              <code className="secret-value">{values[m.id] ?? MASK}</code>
              <button type="button" className="secret-act" onClick={() => void reveal(m.id)}>{values[m.id] !== undefined ? 'Скрыть' : 'Показать'}</button>
              {values[m.id] !== undefined && <button type="button" className="secret-act" onClick={() => copy(values[m.id])}>Скопировать</button>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

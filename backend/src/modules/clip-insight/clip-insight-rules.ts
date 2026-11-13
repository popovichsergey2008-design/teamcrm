/**
 * #4902, п. 14 «Видео и голос → текст и задачи» — правила без базы и сети.
 *
 * Запись экрана: расшифровка, кратко, метки времени («0:42 баг») и задача-баг с видео.
 * Голосовое: текст и кратко в 1–2 строки. Модель делает лучше, но её может не быть —
 * тогда кратко и метки строятся здесь, правилами, и об этом честно сказано в ответе.
 */

export interface Segment { start: number; end: number; text: string }
export interface Mark { sec: number; label: string; text: string }

/** «0:42», «12:05», «1:02:07». */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function cutAt(text: string, max: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:—-]+$/, '')}…`;
}

/*
  Признаки проблемы. Основы слов без \b: в JS \b не видит кириллицу.
  Узко намеренно: «работает» само по себе не баг, «не работает» — баг.
*/
const BUG = /(баг|ошибк|ошибоч|не работа|не открыва|не грузит|не загружа|не сохраня|не отправля|не приход|не нажима|не показыва|не видно|сломал|слома|падает|упал|вылета|вылетел|зависа|завис|тормоз|съезжа|съехал|пропада|пропал|белый экран|пустой экран|крутится|глюч|некорректн|неправильн|криво|\berror\b|\bcrash|\bbug\b|exception)/i;

export function isBugPhrase(text: string): boolean {
  return BUG.test(String(text ?? ''));
}

/** Метки правилами: реплики с признаком проблемы, не чаще одной на 5 секунд, до 8 штук. */
export function bugMarks(segments: Segment[], max = 8): Mark[] {
  const out: Mark[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (!isBugPhrase(s.text)) continue;
    if (out.length && s.start - out[out.length - 1].sec < 5) continue;
    out.push({ sec: Math.max(0, Math.round(s.start)), label: 'баг', text: cutAt(s.text, 90) });
    if (out.length >= max) break;
  }
  return out;
}

/** Кратко правилами: первые одно-два предложения, не длиннее 160 знаков. */
export function summaryFallback(text: string, max = 160): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const sentences = t.match(/[^.!?…]+[.!?…]*/gu) ?? [t];
  let out = sentences[0].trim();
  if (sentences[1] && out.length + sentences[1].length < max) out = `${out} ${sentences[1].trim()}`;
  return cutAt(out, max);
}

/** Кратко нужно только длинному: короткое голосовое и так читается целиком. */
export function needsSummary(text: string): boolean {
  return String(text ?? '').replace(/\s+/g, ' ').trim().length > 140;
}

/**
 * Ответ модели: {"summary":"…","marks":[{"sec":…,"label":"баг","text":"…"}]}.
 * Кратко — не больше двух строк; метки — только на настоящие реплики (ближайшая), иначе
 * по метке пойдут смотреть пустое место.
 */
export function parseInsight(raw: string, segments: Segment[]): { summary: string | null; marks: Mark[] } {
  const m = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!m) return { summary: null, marks: [] };
  let data: any;
  try { data = JSON.parse(m[0]); } catch { return { summary: null, marks: [] }; }
  const summaryRaw = typeof data?.summary === 'string' ? data.summary.trim() : '';
  const summary = summaryRaw ? cutAt(summaryRaw.split('\n').slice(0, 2).join(' '), 220) : null;
  const marks: Mark[] = [];
  if (segments.length && Array.isArray(data?.marks)) {
    for (const x of data.marks.slice(0, 8)) {
      const want = Number(x?.sec);
      const text = cutAt(String(x?.text ?? ''), 90);
      if (!Number.isFinite(want) || !text) continue;
      const near = segments.reduce((a, b) => (Math.abs(b.start - want) < Math.abs(a.start - want) ? b : a), segments[0]);
      const label = cutAt(String(x?.label ?? 'баг').toLowerCase(), 20) || 'баг';
      const sec = Math.max(0, Math.round(near.start));
      if (!marks.some((k) => k.sec === sec)) marks.push({ sec, label, text });
    }
  }
  return { summary, marks: marks.sort((a, b) => a.sec - b.sec) };
}

/** Стенограмма для модели: «[42] текст» — секунды целыми, чтобы модель их и вернула. */
export function timedText(segments: Segment[], limit = 9000): string {
  return segments.map((s) => `[${Math.round(s.start)}] ${s.text}`).join('\n').slice(0, limit);
}

/** Задача-баг из записи экрана: название и описание из расшифровки. */
export function bugTaskText(i: {
  summary: string | null; marks: Mark[]; segments: Segment[]; text: string;
  chatTitle: string | null; author: string | null; at: Date;
}): { title: string; description: string } {
  const head = i.marks[0]?.text || i.summary || summaryFallback(i.text) || 'Проблема на записи экрана';
  const title = cutAt(`Баг: ${head.replace(/^баг[:\s—-]*/i, '')}`, 120);
  const when = i.at.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  const lines: string[] = [];
  lines.push(`Из записи экрана${i.chatTitle ? ` в чате «${i.chatTitle}»` : ''}${i.author ? `, автор — ${i.author}` : ''}, ${when}. Видео приложено к задаче.`);
  if (i.summary) lines.push('', `Кратко: ${i.summary}`);
  if (i.marks.length) {
    lines.push('', 'Метки на видео:');
    for (const k of i.marks) lines.push(`• ${stamp(k.sec)} ${k.label}: ${k.text}`);
  }
  const body = i.segments.length
    ? i.segments.map((s) => `[${stamp(s.start)}] ${s.text}`).join('\n')
    : i.text;
  if (body) lines.push('', 'Расшифровка:', body);
  return { title, description: lines.join('\n').slice(0, 9000) };
}

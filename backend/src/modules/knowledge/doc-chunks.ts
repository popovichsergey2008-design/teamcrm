/**
 * Нарезка документа (регламент, справочник QEVO) по разделам, а не по символам.
 *
 * Ровная нарезка по 1200 знаков рвала инструкцию посреди шага, а кусок «3. Нажмите
 * «Отложить»…» не знал, к какому разделу он относится: на вопрос «как отложить
 * строку во Входящих» поиск находил кусок без слова «Входящие» — или не находил.
 * Поэтому кусок = раздел второго уровня (или его часть по абзацам), и в начале
 * каждого куска — путь «Документ › Раздел»: его видят и полнотекстовый поиск, и
 * эмбеддинги, и модель, которая потом называет человеку раздел справочника.
 */
export function chunkDoc(text: string, size: number, overlap: number): string[] {
  const lines = text.trim().split('\n');
  if (!lines.length || !lines[0].trim()) return [];
  // Корень пути — название документа: первая строка (у регламента это его заголовок).
  const first = lines[0].trim();
  const root = first.replace(/^#\s+/, '');
  const rest = lines.slice(1);
  // Заголовок «# …» внутри дублирует название — в путь он не идёт.
  if (rest.length && /^#\s/.test(rest.find((l) => l.trim()) ?? '')) {
    rest.splice(rest.findIndex((l) => l.trim()), 1);
  }

  const groups: { head: string | null; lines: string[] }[] = [{ head: null, lines: [] }];
  for (const l of rest) {
    const m = /^##\s+(.+)/.exec(l);
    if (m) groups.push({ head: m[1].trim(), lines: [l] });
    else groups[groups.length - 1].lines.push(l);
  }

  const out: string[] = [];
  for (const g of groups) {
    const body = g.lines.join('\n').trim();
    if (!body) continue;
    const prefix = (g.head ? `${root} › ${g.head}` : root) + '\n';
    const room = Math.max(size - prefix.length, 200);
    for (const piece of pack(body, room, overlap)) out.push(prefix + piece);
  }
  return out;
}

/** Абзацы подряд, пока помещаются; абзац длиннее куска режем по символам с нахлёстом. */
function pack(body: string, room: number, overlap: number): string[] {
  if (body.length <= room) return [body];
  const out: string[] = [];
  let cur = '';
  for (const para of body.split(/\n{2,}/)) {
    const next = cur ? `${cur}\n\n${para}` : para;
    if (next.length <= room) { cur = next; continue; }
    if (cur) out.push(cur);
    if (para.length <= room) { cur = para; continue; }
    for (let i = 0; i < para.length; i += room - overlap) out.push(para.slice(i, i + room));
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

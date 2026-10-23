/**
 * Действия панели выделения (#4640): права на удаление и текст для буфера. Отдельно
 * от chat-select.ts, потому что нужны только лениво загружаемой панели — первый экран
 * их не тянет. Проверки — в scripts/logic-check.mjs.
 */
import type { SelMsg } from './chat-select';

/** «Удалить» в панели — только если каждое выбранное можно удалить по одному (своё). */
export function canDeleteAll(selected: SelMsg[], userId: string | number | null | undefined): boolean {
  return !!selected.length && userId != null && selected.every((m) => String(m.author_id ?? '') === String(userId));
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Текст для буфера, как у Telegram: «Автор, [дд.мм.гггг чч:мм]», под ним текст;
 * сообщения через пустую строку. Без текста — имена вложений.
 */
export function selCopyText(selected: SelMsg[]): string {
  return selected.map((m) => {
    const d = new Date(m.created_at);
    const at = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const who = m.is_ai ? 'QEVO Bot' : (m.author_name ?? m.guest_name ?? 'Собеседник');
    const files = (m.files?.length ? m.files.map((f) => f.name) : [m.file_name]).filter(Boolean);
    const text = String(m.body ?? '').trim() || (files.length ? `[${files.join(', ')}]` : '[вложение]');
    return `${who}, [${at}]\n${m.forwarded_author ? `[Переслано от ${m.forwarded_author}]\n` : ''}${text}`;
  }).join('\n\n');
}

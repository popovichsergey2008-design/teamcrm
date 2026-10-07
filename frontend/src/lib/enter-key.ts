/**
 * Что значит Enter в поле сообщения.
 *
 * Enter — отправить; Shift+Enter и Ctrl+Enter (на Mac — Cmd+Enter) — новая строка.
 * Так в мессенджерах, и так просил заказчик.
 *
 * Отдельный случай — голосовой ввод системы (Win+H в Windows, голосовая клавиатура на
 * телефоне) и любые IME. Пока продиктованный текст не «принят», браузер отдаёт нажатие
 * не как `Enter`, а как служебное `Process` (keyCode 229). Раньше поле его не узнавало,
 * срабатывал обычный перенос строки, и сообщение после диктовки не уходило (жалоба
 * заказчика). Физическую клавишу всё равно видно по `code` — по нему и узнаём.
 */
export type EnterKeyEvent = {
  key: string;
  code?: string;
  keyCode?: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

export function isEnterKey(e: EnterKeyEvent): boolean {
  if (e.key === 'Enter') return true;
  const service = e.key === 'Process' || e.keyCode === 229;
  return service && (e.code === 'Enter' || e.code === 'NumpadEnter');
}

export function enterAction(e: EnterKeyEvent): 'send' | 'newline' | null {
  if (!isEnterKey(e)) return null;
  if (e.altKey) return null;
  if (e.shiftKey || e.ctrlKey || e.metaKey) return 'newline';
  return 'send';
}

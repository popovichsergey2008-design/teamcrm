/**
 * #4902 п. 2 (#4894): куда вернуть курсор после правки сообщения — в поле ветки, если
 * правили сообщение открытой ветки, иначе в поле ленты. Раньше фокус терялся совсем.
 */
export function editFocusTarget(threadIds: readonly string[] | null | undefined, messageId: string | null): 'thread' | 'feed' {
  return messageId && threadIds?.includes(String(messageId)) ? 'thread' : 'feed';
}

/**
 * Служебный мусор из буфера обмена (#1559): Google Таблицы кладут в текст стиль ячейки
 * «<!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}-->». Экран
 * его уже вычищает при вставке; здесь — страховка на сохранении (старые приложения,
 * вставка из других мест). HTML-комментарии и <style> человек сам не печатает.
 */
export function stripPasteJunk<T extends string | null | undefined>(text: T): T {
  if (typeof text !== 'string' || (!text.includes('<!--') && !/<style/i.test(text))) return text;
  return text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '') as T;
}

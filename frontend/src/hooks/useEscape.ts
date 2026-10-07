import { useEffect, useRef } from 'react';

/**
 * Закрытие по Escape.
 *
 * Шторки и модальные окна закрывались только мышью — крестиком или щелчком по
 * подложке. Для того, кто работает с клавиатуры, это тупик: до крестика ещё надо
 * дотабать. Esc — то, что человек жмёт не думая, и он обязан работать везде.
 *
 * Окна складываются в стопку: Esc закрывает только ВЕРХНЕЕ (ТЗ-15). Раньше каждое
 * окно слушало клавишу само, и окно группы внутри плавающего чата закрывалось вместе
 * с чатом — человек терял заполненную форму. Поэтому хук вешали только на окна без
 * вложенных; теперь вложенность не страшна.
 *
 * Место в стопке занимается один раз — при открытии (или при enabled → true), а не
 * при каждой перерисовке: иначе нижнее окно, перерисовавшись, перескакивало бы наверх.
 * Свежий onClose берётся по ссылке.
 *
 * Свои перехватчики Escape (календарь в поле срока, просмотр картинки) по-прежнему
 * слушают клавишу сами: хук их не знает, поэтому внутри таких мест его не вешаем.
 */
const stack: Array<{ close: () => void }> = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !stack.length) return;
  // Командная строка и подсказка по клавишам лежат ПОВЕРХ шторки и закрываются сами.
  // Без этой проверки один Esc убирал бы оба слоя сразу.
  if ((e.target as HTMLElement | null)?.closest?.('.palette')) return;
  // Окно Base UI (подтверждение, список, меню) закрывается само и останавливает событие
  // не всегда — не трогаем шторку под ним.
  if (document.querySelector('.ui-dialog[data-open], .ui-popup[data-open]')) return;
  stack[stack.length - 1].close();
}

export function useEscape(onClose: () => void, enabled = true) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const entry = { close: () => latest.current() };
    stack.push(entry);
    if (!listening) { window.addEventListener('keydown', onKey); listening = true; }
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}

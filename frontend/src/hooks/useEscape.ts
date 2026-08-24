import { useEffect } from 'react';

/**
 * Закрытие по Escape.
 *
 * Шторки и модальные окна закрывались только мышью — крестиком или щелчком по
 * подложке. Для того, кто работает с клавиатуры, это тупик: до крестика ещё надо
 * дотабать. Esc — то, что человек жмёт не думая, и он обязан работать везде.
 *
 * Вешается только на самостоятельные шторки без вложенных окон. Там, где внутри
 * живёт свой перехватчик Escape — календарь в карточке задачи, просмотр картинки, —
 * этот хук не используется: один Esc закрывал бы сразу два уровня, и человек терял
 * бы заполненную форму вместо того, чтобы просто свернуть календарь.
 */
export function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Командная строка и подсказка по клавишам лежат ПОВЕРХ шторки и закрываются сами.
      // Без этой проверки один Esc убирал бы оба слоя сразу.
      if ((e.target as HTMLElement | null)?.closest?.('.palette')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);
}

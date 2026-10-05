/** Склейка классов без внешней библиотеки: Tailwind у нас нет, сливать конфликты незачем. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

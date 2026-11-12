/** «20 ноября» — даты пробного и бонусов в «Тариф и ИИ». */
export const dayMonth = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

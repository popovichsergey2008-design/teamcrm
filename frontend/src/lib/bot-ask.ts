import { navigate } from './router';

/**
 * Открыть QEVO Bot с готовым вопросом (#4620): «Спросить подробнее у Qevo-бота» из
 * подсказки обучения и вопросы из Qevo-бота первого запуска.
 *
 * Бот может быть ещё не нарисован — вопрос ждёт в window.qevoAsk, пока его не заберёт
 * AnthillPanel (событие `qevo:bot-ask`, если он уже на экране). Через window, а не
 * общим модулем: панель бота — в стартовой сборке, а этот модуль нужен только
 * ленивым кускам, и первый экран от него не тяжелеет.
 */
export function askBot(question: string): void {
  (window as { qevoAsk?: string }).qevoAsk = question;
  navigate({ section: 'chat', chatId: 'anthill' });
  window.dispatchEvent(new Event('qevo:bot-ask'));
}

/**
 * Повестка встречи: какие факты в неё попадают, в каком порядке и что из них видит человек.
 *
 * Правила отдельно от модели намеренно. Факты собирает база — их можно проверить;
 * модель только формулирует. Если модель недоступна или отвечает мусором, повестка
 * всё равно уходит — фактами. Встреча через пять минут не станет ждать, пока
 * починят ключ OpenAI.
 */

export type FactKind = 'description' | 'previous' | 'review' | 'overdue' | 'approval';

export interface AgendaFact {
  kind: FactKind;
  /** Готовая строка для человека — она же уходит в фолбэк-повестку. */
  text: string;
}

export interface AgendaSource {
  title: string;
  /** Описание, которое написал организатор. */
  description: string | null;
  /** Имена участников — для приветственной строки и для модели. */
  participants: string[];
  /** Решения прошлой встречи этой же серии. */
  previousDecisions: string[];
  /** Сдано на проверку кому-то из участников кем-то из участников. */
  awaitingReview: { title: string; assignee: string | null; reviewer: string | null }[];
  /** Просроченное у участников — то, о чём всё равно спросят. */
  overdue: { title: string; assignee: string | null; days: number }[];
  /** Нерешённые согласования между участниками. */
  approvals: { subject: string; author: string | null; approver: string | null }[];
}

/** Сколько пунктов одного вида берём: повестка длиннее экрана не читается вовсе. */
const PER_KIND = 4;

/**
 * Факты в порядке важности.
 *
 * Первым — то, ради чего собрались (описание), потом прошлые договорённости: встреча,
 * которая начинается с «а о чём мы договорились в прошлый раз?», уже потеряла пять минут.
 * Дальше — то, что висит МЕЖДУ участниками: именно это на встречах и решается,
 * а на переписку не выносится.
 */
export function collectFacts(s: AgendaSource): AgendaFact[] {
  const facts: AgendaFact[] = [];

  if (s.description?.trim()) {
    facts.push({ kind: 'description', text: s.description.trim().slice(0, 500) });
  }
  for (const d of s.previousDecisions.slice(0, PER_KIND)) {
    facts.push({ kind: 'previous', text: `В прошлый раз решили: ${d}` });
  }
  for (const t of s.awaitingReview.slice(0, PER_KIND)) {
    const who = t.assignee ? ` (сдал ${t.assignee})` : '';
    facts.push({ kind: 'review', text: `Ждёт проверки: «${t.title}»${who}` });
  }
  for (const t of s.overdue.slice(0, PER_KIND)) {
    const who = t.assignee ? `, ${t.assignee}` : '';
    facts.push({ kind: 'overdue', text: `Просрочено ${t.days} дн.: «${t.title}»${who}` });
  }
  for (const a of s.approvals.slice(0, PER_KIND)) {
    const who = a.approver ? ` — ждёт решения: ${a.approver}` : '';
    facts.push({ kind: 'approval', text: `Нерешённый вопрос: «${a.subject}»${who}` });
  }
  return facts;
}

/**
 * Повестка без модели: те же факты списком.
 *
 * Это не «запасной вариант на крайний случай», а нормальный результат: список фактов
 * читается за десять секунд и ничего не выдумывает.
 */
export function factsToText(facts: AgendaFact[]): string {
  return facts.map((f) => `• ${f.text}`).join('\n');
}

/** Материал для модели: те же факты плюс состав — без них она напишет общие слова. */
export function agendaPrompt(s: AgendaSource, facts: AgendaFact[]): string {
  const who = s.participants.length ? `Участники: ${s.participants.join(', ')}.\n` : '';
  return `Встреча: «${s.title}».\n${who}\nФакты:\n${factsToText(facts)}`;
}

/**
 * Ответ модели годится, только если он остался повесткой.
 *
 * Проверяем ровно то, что ломается на практике: пустой ответ, ответ-простыня
 * и ответ, в котором модель пересказала задание вместо повестки. Всё остальное
 * — вкусовщина, и запрещать её не наше дело.
 */
export function usableAgenda(answer: string | null | undefined, factCount: number): boolean {
  const text = (answer ?? '').trim();
  // короткая повестка — нормальная повестка: два пункта по три слова лучше абзаца воды
  if (text.length < 10) return false;
  if (text.length > 4000) return false;
  // повестка без единого пункта — это не повестка, а вступление
  if (factCount > 0 && !/[-•\d]/.test(text)) return false;
  return true;
}

/** Строка для журнала ассистента: коротко и по делу. */
export function agendaSummary(title: string, factCount: number): string {
  return `Повестка встречи «${title}»: пунктов ${factCount}`;
}

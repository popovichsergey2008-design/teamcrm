import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskActivityRepository } from './task-activity.repository';
import { MergeTaskRow, TaskMergeRepository } from './task-merge.repository';
import { joinDescriptions, mergeChecklists, percent, scoreTask } from './merge-similarity';

/** Столько кандидатов имеет смысл показать: дальше человек не читает, а гадает. */
const TOP = 6;
/** Из скольких открытых задач ищем похожие без модели. */
const SCAN_LIMIT = 400;
/**
 * С какого совпадения предупреждаем при создании задачи.
 *
 * Порог высокий намеренно: в карточке человек сам нажал «Объединить» и готов
 * смотреть список, а при создании предупреждение приходит незваным. Ошибиться
 * здесь значит приучить его закрывать подсказку не читая.
 */
const DUPLICATE_MIN = 0.45;

/**
 * Объединение похожих задач.
 *
 * Дубли — обычное дело: один просит «добавить чат в карточку», другой через неделю
 * «сделать обсуждение внутри задачи». Обе живут, обе кто-то делает, и выясняется
 * это в лучшем случае на разборе.
 *
 * Три правила, на которых всё держится:
 * 1. Ничего не пропадает. Вторая задача не удаляется, а помечается объединённой и
 *    ссылается на основную: на её номер уже сослались в переписке.
 * 2. Ничего не делается само. ИИ предлагает — название, описание, чек-лист, — а
 *    применяет человек, и только то, что подтвердил.
 * 3. Поиск похожих работает всегда. Есть эмбеддинги — ищем по смыслу, нет — по
 *    словам. Пустое окно вместо списка было бы отказом самой возможности.
 */
@Injectable()
export class TaskMergeService {
  private readonly log = new Logger('TaskMerge');

  constructor(
    private readonly repo: TaskMergeRepository,
    private readonly activity: TaskActivityRepository,
    private readonly realtime: RealtimeService,
    private readonly notify: NotificationsService,
    private readonly ai: AiService,
    private readonly knowledge: KnowledgeService,
  ) {}

  private async task(tenantId: string, id: string): Promise<MergeTaskRow> {
    const t = await this.repo.byId(tenantId, id);
    if (!t) throw AppException.notFound('Задача не найдена');
    return t;
  }

  /**
   * Кандидаты на объединение: сначала похожие по смыслу, затем по словам.
   *
   * `q` — ручной поиск. Когда он задан, порядок задаёт не похожесть, а сам запрос:
   * человек уже знает, что ищет, и подсовывать ему «а вот эти похожее» вредно.
   */
  async candidates(tenantId: string, taskId: string, q?: string) {
    const base = await this.task(tenantId, taskId);
    return this.rank(tenantId, { id: String(base.id), title: base.title, description: base.description }, q);
  }

  /**
   * Возможные дубли ЕЩЁ НЕ созданной задачи.
   *
   * Ловить дубль до его появления дешевле, чем объединять после: человек ещё
   * ничего не завёл и может просто открыть существующую задачу. Порог здесь выше,
   * чем в списке кандидатов: непрошеное предупреждение раздражает сильнее, чем
   * отсутствующее, и показывать «возможно, дубль» на каждое общее слово нельзя.
   */
  async duplicatesOf(tenantId: string, input: { title: string; description?: string }) {
    const title = (input.title ?? '').trim();
    // Двух слов мало для вывода: по ним похоже всё подряд.
    if (title.length < 8) return { items: [] };
    const ranked = await this.rank(
      tenantId,
      { id: '0', title, description: input.description ?? null },
      undefined,
      DUPLICATE_MIN,
    );
    return { items: ranked.items.slice(0, 3) };
  }

  /** Общее ранжирование: и для карточки задачи, и для проверки при создании. */
  private async rank(
    tenantId: string,
    base: { id: string; title: string; description: string | null },
    q?: string,
    minScore = 0.12,
  ) {
    const query = (q ?? '').trim();
    const rows = await this.repo.candidates(tenantId, base.id, query || null, query ? 30 : SCAN_LIMIT);

    const semantic = query ? new Map<string, number>() : await this.semantic(tenantId, base);

    const scored = rows.map((r) => {
      const byWords = scoreTask(base, { id: String(r.id), title: r.title, description: r.description });
      const bySense = semantic.get(String(r.id)) ?? 0;
      // Берём лучшее из двух: смысл ловит синонимы, слова — точные совпадения.
      const score = Math.max(byWords.score, bySense);
      return {
        id: String(r.id),
        title: r.title,
        projectId: String(r.project_id),
        projectName: r.project_name,
        assigneeName: r.assignee_name,
        managerName: r.manager_name,
        match: percent(score),
        reason: bySense > byWords.score ? 'близко по смыслу' : byWords.reason,
        score,
      };
    });

    const items = query
      ? scored.slice(0, 20)
      : scored.filter((x) => x.score > minScore).sort((a, b) => b.score - a.score).slice(0, TOP);

    // score наружу не отдаём: человек видит проценты, а сырая мера — дело сервера
    return {
      items: items.map((x) => ({
        id: x.id,
        title: x.title,
        projectId: x.projectId,
        projectName: x.projectName,
        assigneeName: x.assigneeName,
        managerName: x.managerName,
        match: x.match,
        reason: x.reason,
      })),
      searched: !!query,
    };
  }

  /**
   * Похожесть по смыслу — через базу знаний, куда задачи и так индексируются.
   *
   * Молча возвращаем пустоту, если модели нет: без ключа ИИ поиск обязан
   * продолжать работать словами, а не падать вместе с окном.
   */
  private async semantic(
    tenantId: string, base: { id: string; title: string; description: string | null },
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const hits = await this.knowledge.search(
        tenantId, `${base.title}\n${base.description ?? ''}`.slice(0, 2000), 20,
      );
      for (const h of hits) {
        if (h.sourceType !== 'task' || String(h.sourceId) === String(base.id)) continue;
        const prev = out.get(String(h.sourceId)) ?? 0;
        out.set(String(h.sourceId), Math.max(prev, h.score));
      }
    } catch (e) {
      this.log.debug?.(`поиск по смыслу недоступен: ${(e as Error).message}`);
    }
    return out;
  }

  /**
   * Что получится при объединении — до того, как что-то произошло.
   *
   * Здесь же живёт предложение ИИ: название, описание и чек-лист без дублей.
   * Человек может принять его, поправить или не брать вовсе.
   */
  async preview(tenantId: string, primaryId: string, secondaryId: string) {
    if (String(primaryId) === String(secondaryId)) {
      throw AppException.validation('Задачу нельзя объединить саму с собой');
    }
    const [primary, secondary] = await Promise.all([
      this.task(tenantId, primaryId),
      this.task(tenantId, secondaryId),
    ]);
    if (secondary.merged_into_id) {
      throw AppException.conflict(`Задача #${secondaryId} уже объединена с #${secondary.merged_into_id}`);
    }
    if (primary.merged_into_id) {
      throw AppException.conflict(`Задача #${primaryId} уже объединена с #${primary.merged_into_id}`);
    }

    const [moves, listA, listB] = await Promise.all([
      this.repo.contents(tenantId, secondaryId),
      this.repo.checklist(tenantId, primaryId),
      this.repo.checklist(tenantId, secondaryId),
    ]);

    const checklist = mergeChecklists(listA.map((i) => i.text), listB.map((i) => i.text));
    const description = joinDescriptions(primary.description ?? '', secondary.description ?? '', String(secondaryId));
    const suggestion = await this.suggest(tenantId, primary, secondary, checklist, description);

    return {
      primary: this.view(primary),
      secondary: this.view(secondary),
      /** Что переедет из второй задачи в основную. */
      moves,
      /** Разные проекты — не запрет, но повод предупредить. */
      differentProjects: String(primary.project_id) !== String(secondary.project_id),
      suggestion,
    };
  }

  /**
   * Предложение ИИ.
   *
   * Просим строгий JSON и всё равно готовимся получить мусор: модель отвечает
   * текстом, а не обещаниями. Не разобрали — отдаём склейку по правилам, она уже
   * посчитана и всегда осмысленна.
   */
  private async suggest(
    tenantId: string, primary: MergeTaskRow, secondary: MergeTaskRow,
    checklist: string[], description: string,
  ): Promise<{ title: string; description: string; checklist: string[]; byAi: boolean }> {
    const fallback = { title: primary.title, description, checklist, byAi: false };
    try {
      const system = 'Ты помогаешь объединить две дублирующиеся задачи в одну. '
        + 'Верни СТРОГО JSON {"title":string,"description":string,"checklist":string[]} без пояснений. '
        + 'Название — короткое и общее для обеих. Описание — объединённое, без повторов, по-русски. '
        + 'Чек-лист — общий список шагов: одинаковые по смыслу пункты («Добавить чат» и «Реализовать чат») '
        + 'оставь одним, ничего не выдумывай сверх исходных.';
      const user = JSON.stringify({
        task1: { title: primary.title, description: primary.description ?? '' },
        task2: { title: secondary.title, description: secondary.description ?? '' },
        checklist,
      });
      const raw = await this.ai.generate(tenantId, system, user, 'task_merge');
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as { title?: string; description?: string; checklist?: unknown[] };
      const items = Array.isArray(parsed.checklist)
        ? parsed.checklist.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50)
        : [];
      return {
        title: String(parsed.title ?? primary.title).trim().slice(0, 255) || primary.title,
        description: String(parsed.description ?? description).trim().slice(0, 8000) || description,
        // Пустой список от модели не принимаем: чек-лист исчезнуть не должен.
        checklist: items.length ? items : checklist,
        byAi: true,
      };
    } catch (e) {
      this.log.debug?.(`подсказка объединения недоступна: ${(e as Error).message}`);
      return fallback;
    }
  }

  /**
   * Объединить.
   *
   * `primaryId` — та задача, что остаётся; выбор основной делает человек, поэтому
   * сторона приходит с клиента уже разобранной.
   */
  async merge(tenantId: string, actorId: string, input: {
    primaryId: string; secondaryId: string;
    title?: string | null; description?: string | null; checklist?: string[] | null;
  }) {
    const { primaryId, secondaryId } = input;
    if (String(primaryId) === String(secondaryId)) {
      throw AppException.validation('Задачу нельзя объединить саму с собой');
    }
    const [primary, secondary] = await Promise.all([
      this.task(tenantId, primaryId),
      this.task(tenantId, secondaryId),
    ]);
    if (secondary.merged_into_id || primary.merged_into_id) {
      throw AppException.conflict('Одна из задач уже объединена — обновите карточку');
    }

    // Кого предупредить, считаем ДО переноса: после него участники второй задачи
    // окажутся участниками первой, и «кого это касалось» уже не восстановить.
    const people = await this.repo.peopleOf(tenantId, [primaryId, secondaryId]);

    await this.repo.apply({
      tenantId,
      primaryId,
      secondaryId,
      actorId,
      title: input.title?.trim() ? input.title.trim().slice(0, 255) : null,
      description: typeof input.description === 'string' ? input.description.slice(0, 8000) : null,
      checklist: input.checklist ?? null,
    });

    // История остаётся у обеих задач: по каждой видно, что с ней случилось.
    await this.activity.log(tenantId, primaryId, actorId, 'merged_in', {
      taskId: String(secondaryId), title: secondary.title,
    });
    await this.activity.log(tenantId, secondaryId, actorId, 'merged_into', {
      taskId: String(primaryId), title: primary.title,
    });

    // Доски обеих задач должны перерисоваться: одна получила содержимое, вторая — пометку.
    this.realtime.emit(tenantId, primary.project_id, 'task.updated', { id: primaryId } as any);
    this.realtime.emit(tenantId, secondary.project_id, 'task.updated', {
      id: secondaryId, merged_into_id: String(primaryId),
    } as any);
    this.realtime.emitToUsers(tenantId, people.filter((id) => id !== String(actorId)), 'task.merged', {
      primaryId: String(primaryId),
      secondaryId: String(secondaryId),
      projectId: String(primary.project_id),
      title: primary.title,
    });
    void this.notify.taskMerged(tenantId, primaryId, secondaryId, actorId, people);

    return {
      taskId: String(primaryId),
      projectId: String(primary.project_id),
      mergedId: String(secondaryId),
    };
  }

  private view(t: MergeTaskRow) {
    return {
      id: String(t.id),
      title: t.title,
      description: t.description,
      projectId: String(t.project_id),
      projectName: t.project_name,
      assigneeName: t.assignee_name,
      managerName: t.manager_name,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TagsRepository } from './tags.repository';
import { canCreateTag, confidenceBand, findSimilarTag, TagCreatePolicy, tagsGatePassed } from './tag-rules';

/**
 * Базовый набор тегов организации (ТЗ, п. 3).
 *
 * Пять штук намеренно: набор, который человек охватывает взглядом и в котором не
 * приходится выбирать между похожими. Всё остальное компания добавляет сама под свою
 * работу. Описание рядом — не для людей, а для модели: по одному названию
 * «Клиент-менеджер» она не поймёт, когда его ставить.
 */
export const DEFAULT_TAGS = [
  { name: 'Контентная задача', color: '#2f7d5d', hint: 'Тексты и наполнение: статьи, SEO-тексты, meta, карточки товаров, переводы, правка контента.' },
  { name: 'Программная задача', color: '#2f5fbf', hint: 'Разработка: бэкенд, фронтенд, API, база данных, интеграции, исправление ошибок, доработка интерфейса.' },
  { name: 'Дизайнерская задача', color: '#7c4dbf', hint: 'Визуальное: макеты, баннеры, UI, прототипы, изображения, графика.' },
  { name: 'Клиент-менеджер', color: '#a35a10', hint: 'Работа с клиентом: согласовать, уточнить требования, получить информацию или подтверждение, передать результат.' },
  { name: 'Отложенная задача', color: '#55606f', hint: 'Сохранить, но пока не брать в работу: зависит от будущего события, вернуться позже, не потерять.' },
];

const SUGGEST_SYSTEM = `Ты классифицируешь задачи компании по её СОБСТВЕННЫМ тегам.
Тебе дают название задачи, описание, шаги и список доступных тегов с описаниями.
Выбери подходящие теги ТОЛЬКО из списка. Новые теги не придумывай.
Одной задаче может подойти несколько тегов (например «Программная задача» и «Клиент-менеджер»).
Если ничего не подходит — верни пустой список и, если уместно, предложи название нового тега.
Ответ строго JSON: {"tags":[{"id":"<id тега>","confidence":0.0-1.0}],"proposed":"<название или null>"}`;

/**
 * Теги задач и разметка их через ИИ.
 *
 * Главное правило всего механизма: ИИ делает черновую работу, решение остаётся за
 * постановщиком. Молча закреплённый тег разъедает классификацию быстрее, чем её
 * отсутствие: через месяц в фильтре стоят теги, которых никто не ставил, и доверия к
 * ним нет — а значит, и фильтром не пользуются.
 */
@Injectable()
export class TagsService {
  private readonly log = new Logger('Tags');

  constructor(
    private readonly repo: TagsRepository,
    private readonly ai: AiService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Базовый набор новой организации. Зовётся при регистрации. */
  async seedDefaults(tenantId: string): Promise<void> {
    await this.repo.ensureDefaults(tenantId, DEFAULT_TAGS).catch((e) => {
      this.log.warn(`базовые теги не завелись: ${(e as Error).message}`);
    });
  }

  async list(tenantId: string, withArchived = false) {
    const [items, settings] = await Promise.all([
      this.repo.list(tenantId, withArchived),
      this.repo.settings(tenantId),
    ]);
    return { items, settings: this.settingsView(settings) };
  }

  private settingsView(s: { ai_tagging: boolean; require_confirmation: boolean; who_can_create: TagCreatePolicy }) {
    return {
      aiTagging: s.ai_tagging,
      requireConfirmation: s.require_confirmation,
      whoCanCreate: s.who_can_create,
    };
  }

  async settings(tenantId: string) {
    return this.settingsView(await this.repo.settings(tenantId));
  }

  /** Политику компании меняет только владелец: это правило для всех, а не личная настройка. */
  async saveSettings(
    tenantId: string, user: { userId: string; role: string },
    dto: { aiTagging?: boolean; requireConfirmation?: boolean; whoCanCreate?: TagCreatePolicy },
  ) {
    if (user.role !== 'owner') throw AppException.forbidden('Настройки тегов меняет владелец организации');
    const current = await this.repo.settings(tenantId);
    const next = await this.repo.saveSettings(tenantId, {
      ai_tagging: dto.aiTagging ?? current.ai_tagging,
      /*
        Подтверждение нельзя выключить отдельно, пока включена сама разметка: это
        превратило бы ИИ в того, кто ставит теги за людей, а весь смысл механизма — в
        обратном. Выключают его вместе с разметкой (ТЗ, п. 40).
      */
      require_confirmation: (dto.aiTagging ?? current.ai_tagging) ? true : (dto.requireConfirmation ?? current.require_confirmation),
      who_can_create: dto.whoCanCreate ?? current.who_can_create,
    });
    return this.settingsView(next);
  }

  /**
   * Новый тег.
   *
   * Похожий ищем ДО создания: «SEO», «seo» и «СЕО» в одном списке — это не богатство
   * классификации, а её конец. Настоять на своём можно (`force`), но только тому, кто
   * и так вправе управлять списком: иначе предупреждение обходится не глядя.
   */
  async create(
    tenantId: string, user: { userId: string; role: string },
    dto: { name: string; color?: string; aiDescription?: string; force?: boolean },
  ) {
    const settings = await this.repo.settings(tenantId);
    if (!canCreateTag(settings.who_can_create, user.role)) {
      throw AppException.forbidden('В этой компании новые теги заводят руководители');
    }
    const name = String(dto.name ?? '').trim().slice(0, 48);
    if (name.length < 2) throw AppException.validation('Слишком короткое название тега');

    const existing = await this.repo.list(tenantId, true);
    const similar = findSimilarTag(name, existing);
    if (similar && !dto.force) {
      throw AppException.conflict(`Похожий тег уже есть: «${similar.name}»`, { similar });
    }
    if (similar && dto.force && !['owner', 'manager'].includes(user.role)) {
      throw AppException.forbidden('Создать второй похожий тег может руководитель');
    }
    const tag = await this.repo.create({
      tenantId, name, color: dto.color || '#5b8cff',
      aiDescription: dto.aiDescription ?? null, createdBy: user.userId,
    });
    return tag;
  }

  async update(
    tenantId: string, user: { userId: string; role: string }, id: string,
    dto: { name?: string; color?: string; aiDescription?: string },
  ) {
    if (!['owner', 'manager'].includes(user.role)) throw AppException.forbidden('Теги компании правят руководители');
    const tag = await this.repo.byId(tenantId, id);
    if (!tag) throw AppException.notFound('Тег не найден');
    const name = dto.name !== undefined ? String(dto.name).trim().slice(0, 48) : undefined;
    if (name !== undefined && name.length < 2) throw AppException.validation('Слишком короткое название тега');
    return this.repo.update(tenantId, id, { name, color: dto.color, aiDescription: dto.aiDescription });
  }

  /**
   * Архивация вместо удаления.
   *
   * Тег, которым размечены сто задач, нельзя стереть: вместе с ним исчезнет смысл
   * этих ста задач. Архивный остаётся там, где стоял, но не предлагается в новых и не
   * идёт в подсказки ИИ. Вернуть можно в любой момент.
   */
  async archive(tenantId: string, user: { userId: string; role: string }, id: string, archived: boolean) {
    if (!['owner', 'manager'].includes(user.role)) throw AppException.forbidden('Теги компании правят руководители');
    const tag = await this.repo.byId(tenantId, id);
    if (!tag) throw AppException.notFound('Тег не найден');
    await this.repo.setArchived(tenantId, id, archived);
    return { ok: true };
  }

  tagsOfTask(tenantId: string, taskId: string) {
    return this.repo.ofTask(tenantId, taskId);
  }

  /**
   * Проставить задаче теги.
   *
   * Набор задаётся целиком, а не по одному: «сняли один, добавили два» — это одно
   * решение человека, и разбирать его на три запроса значит получить задачу в
   * промежуточном состоянии, если связь оборвалась посередине.
   */
  async setForTask(
    tenantId: string, user: { userId: string }, taskId: string, projectId: string | null,
    tags: { tagId: string; source?: string; confidence?: number | null }[],
  ) {
    await this.repo.setForTask({ tenantId, taskId, tags, confirmedBy: user.userId });
    const items = await this.repo.ofTask(tenantId, taskId);
    // Списки и карточки, открытые у коллег, должны показать новые теги без перезагрузки.
    if (projectId) this.realtime.emitScoped(tenantId, String(projectId), 'task.tags.updated', { taskId, tags: items }, true);
    return { items };
  }

  /**
   * Теги задачи целиком — из карточки.
   *
   * Отдельно от `applyToNewTask`: там задача только что родилась и подсказки ИИ ещё
   * свежи, здесь человек правит уже живую задачу.
   */
  async setTaskTags(
    tenantId: string, user: { userId: string; role: string }, taskId: string,
    tagIds: string[], suggestedTagIds: string[] = [],
  ) {
    const projectId = await this.repo.projectOfTask(tenantId, taskId);
    if (!projectId) throw AppException.notFound('Задача не найдена');
    const chosen = tagIds.map(String).filter(Boolean).slice(0, 20);
    const suggested = suggestedTagIds.map(String).filter(Boolean);
    const res = await this.setForTask(tenantId, user, taskId, projectId, chosen.map((tagId) => ({
      tagId,
      source: suggested.includes(tagId) ? 'ai' : 'manual',
    })));
    if (suggested.length) {
      await this.repo.recordFeedback({ tenantId, taskId, userId: user.userId, suggested, confirmed: chosen });
    }
    return res;
  }

  /**
   * Что предложить в теги для этой задачи.
   *
   * Модель получает ТОЛЬКО активные теги компании с описаниями — придумывать свои она
   * не должна: иначе в списке компании через неделю полтораста тегов, и фильтровать
   * по ним нельзя. Если подходящего нет, она вправе предложить НАЗВАНИЕ нового, но
   * заводит его человек.
   */
  async suggest(
    tenantId: string,
    input: { title: string; description?: string | null; checklist?: string[]; projectName?: string | null },
  ) {
    const settings = await this.repo.settings(tenantId);
    const tags = await this.repo.list(tenantId, false);
    if (!settings.ai_tagging || !tags.length) return { suggestions: [], maybe: [], proposed: null, aiTagging: settings.ai_tagging };

    const payload = {
      task: {
        title: String(input.title ?? '').slice(0, 300),
        description: String(input.description ?? '').slice(0, 1500),
        checklist: (input.checklist ?? []).slice(0, 12),
        project: input.projectName ?? null,
      },
      tags: tags.map((t) => ({ id: String(t.id), name: t.name, when: t.ai_description ?? '' })),
    };

    let parsed: any = null;
    try {
      const raw = await this.ai.generate(tenantId, SUGGEST_SYSTEM, JSON.stringify(payload), 'nl_command');
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    } catch (e) {
      // Модель молчит — человек просто выберет теги сам. Отказывать в создании задачи
      // из-за недоступности ИИ нельзя: работа встанет из-за чужого сбоя.
      this.log.warn(`подсказки тегов без модели: ${(e as Error).message}`);
      return { suggestions: [], maybe: [], proposed: null, aiTagging: true, offline: true };
    }

    const known = new Map(tags.map((t) => [String(t.id), t]));
    const sure: any[] = [];
    const maybe: any[] = [];
    for (const item of Array.isArray(parsed?.tags) ? parsed.tags : []) {
      const tag = known.get(String(item?.id));
      if (!tag) continue; // выдуманный тег молча отбрасываем
      const band = confidenceBand(item?.confidence);
      if (band === 'drop') continue;
      const view = { tagId: String(tag.id), name: tag.name, color: tag.color, confidence: Number(item.confidence) };
      (band === 'sure' ? sure : maybe).push(view);
    }
    const proposed = String(parsed?.proposed ?? '').trim().slice(0, 48) || null;
    return {
      suggestions: sure,
      maybe,
      // Предложение назвать новый тег — только подсказка человеку, сама себя она не создаёт.
      proposed: proposed && !findSimilarTag(proposed, tags) ? proposed : null,
      aiTagging: true,
    };
  }

  /**
   * Пропускать ли создание задачи.
   *
   * Проверка живёт на сервере, а не только в окне: правило компании нельзя обходить
   * старым клиентом, мобильным приложением или чужим скриптом.
   */
  async assertGate(
    tenantId: string,
    input: { tagIds?: unknown[]; tagsConfirmed?: boolean; confirmedWithoutTags?: boolean },
  ): Promise<void> {
    const s = await this.repo.settings(tenantId);
    const ok = tagsGatePassed(
      { aiTagging: s.ai_tagging, requireConfirmation: s.require_confirmation },
      { tagIds: input.tagIds, confirmed: input.tagsConfirmed, confirmedWithoutTags: input.confirmedWithoutTags },
    );
    if (!ok) throw AppException.validation('Подтвердите теги задачи или выберите «Без тегов»', { code: 'TASK_TAGS_NOT_CONFIRMED' });
  }

  /** Теги задачи после создания + журнал того, что человек поправил в подсказках ИИ. */
  async applyToNewTask(
    tenantId: string, user: { userId: string }, taskId: string, projectId: string | null,
    input: { tagIds?: string[]; suggestedTagIds?: string[]; aiConfidence?: Record<string, number> },
  ): Promise<void> {
    const chosen = (input.tagIds ?? []).map(String).filter(Boolean);
    const suggested = (input.suggestedTagIds ?? []).map(String).filter(Boolean);
    if (chosen.length) {
      await this.setForTask(tenantId, user, taskId, projectId, chosen.map((tagId) => ({
        tagId,
        source: suggested.includes(tagId) ? 'ai' : 'manual',
        confidence: input.aiConfidence?.[tagId] ?? null,
      })));
    }
    if (suggested.length || chosen.length) {
      await this.repo.recordFeedback({ tenantId, taskId, userId: user.userId, suggested, confirmed: chosen });
    }
  }

  /** Теги пачки задач — для списков и реестра. */
  ofTasks(tenantId: string, taskIds: string[]) {
    return this.repo.ofTasks(tenantId, taskIds);
  }
}

import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { TemplateInput, TemplateRow, TemplatesRepository } from './templates.repository';

/**
 * Шаблоны задач: «сохранить как шаблон» и постановка по образцу.
 *
 * Зачем. Одни и те же задачи ставятся заново каждую неделю и каждому новому клиенту.
 * Их набирают руками, по-разному, и половина шагов чек-листа теряется. Шаблон
 * закрепляет договорённость: вот как у нас ставят эту работу.
 *
 * Чего в шаблоне НЕТ намеренно:
 *   — проекта и колонки. Задача по шаблону заводится там, где человек её заводит;
 *     привязка к проекту сделала бы шаблон одноразовым;
 *   — срока датой. У шаблона нет «15 сентября», у него есть «через неделю»;
 *   — файлов. Вложение — это про конкретный случай, а не про способ работы.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly repo: TemplatesRepository) {}

  list(tenantId: string): Promise<TemplateRow[]> {
    return this.repo.list(tenantId);
  }

  /**
   * Сохранить открытую задачу как шаблон.
   *
   * Имя обязательно и отличается от названия задачи: в списке шаблонов «Сверстать
   * лендинг для Ромашки» бесполезно, там нужно «Лендинг под клиента».
   *
   * Срок переводим в «через N дней» — по тому, сколько оставалось у задачи. Если срока
   * не было или он уже прошёл, шаблон ставится без срока: подставлять вчерашний день
   * в новую задачу хуже, чем не подставлять ничего.
   */
  async saveFromTask(
    tenantId: string, taskId: string, name: string,
    actor: { userId: string; role: string }, deadlineDays?: number | null,
  ): Promise<TemplateRow> {
    const task = await this.repo.taskForTemplate(tenantId, taskId, actor);
    if (!task) throw AppException.notFound('Задача не найдена');

    const clean = name.trim();
    if (!clean) throw AppException.validation('Назовите шаблон — по имени его будут искать');
    const same = await this.repo.byName(tenantId, clean);
    if (same) {
      throw AppException.conflict(
        `Шаблон «${same.name}» уже есть. Выберите другое имя или удалите прежний в списке шаблонов.`,
      );
    }

    const input: TemplateInput = {
      name: clean,
      title: task.title,
      description: task.description ?? '',
      priority: task.priority ?? 'normal',
      assigneeId: task.assignee_id,
      estimateHours: task.estimate_hours === null ? null : Number(task.estimate_hours),
      requiresApproval: task.requires_approval,
      deadlineDays: deadlineDays === undefined ? daysLeft(task.deadline_at) : normalizeDays(deadlineDays),
      checklist: task.checklist,
      labelIds: task.labelIds,
    };
    return this.repo.create(tenantId, input, actor.userId);
  }

  /**
   * Удалить шаблон.
   *
   * Может автор или владелец: шаблон общий для организации, и чужой способ работы не
   * должен исчезать по нажатию соседа.
   */
  async remove(tenantId: string, id: string, actor: { userId: string; role: string }): Promise<void> {
    const tpl = await this.repo.byId(tenantId, id);
    if (!tpl) throw AppException.notFound('Шаблон не найден');
    const mine = String(tpl.created_by ?? '') === String(actor.userId);
    if (!mine && actor.role !== 'owner') {
      throw AppException.forbidden('Удалить шаблон может тот, кто его создал, или владелец');
    }
    await this.repo.remove(tenantId, id);
  }

  /** По шаблону завели задачу: счётчик поднимает частые наверх списка. */
  async markUsed(tenantId: string, id: string): Promise<{ used: boolean }> {
    const tpl = await this.repo.byId(tenantId, id);
    if (!tpl) return { used: false };
    await this.repo.markUsed(tenantId, id);
    return { used: true };
  }
}

/** Сколько дней осталось до срока: отрицательное и нулевое — значит срока у шаблона нет. */
function daysLeft(deadlineAt: string | null): number | null {
  if (!deadlineAt) return null;
  const days = Math.round((new Date(deadlineAt).getTime() - Date.now()) / 86_400_000);
  return days > 0 ? Math.min(days, 365) : null;
}

/** Границы «через N дней»: год вперёд — уже не шаблон, а напоминание о пенсии. */
function normalizeDays(days: number | null): number | null {
  if (days === null || !Number.isFinite(days)) return null;
  const n = Math.round(days);
  return n > 0 ? Math.min(n, 365) : null;
}

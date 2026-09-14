import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectRow, ProjectsRepository } from './projects.repository';
import { CreateProjectDto } from './projects.dto';
import { IntegrationOutboxService } from '../integrations/outbox/integration-outbox.service';
import { TaskReadsRepository } from '../tasks/task-reads.repository';

/** client-представление проекта — без budget (фича №9). */
function toClientProject(row: ProjectRow) {
  const { budget, ...rest } = row;
  void budget;
  return rest;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly repo: ProjectsRepository,
    private readonly realtime: RealtimeService,
    private readonly outbox: IntegrationOutboxService,
    private readonly reads: TaskReadsRepository,
  ) {}

  /**
   * Список проектов с числом новых событий в МОИХ задачах.
   *
   * Цифра рядом с проектом отвечает на вопрос «где искать»: не открывая доски,
   * видно, в каком проекте что-то произошло. Клиенту её не считаем — у него свой
   * портал и чужие задачи он не ведёт.
   */
  async list(tenantId: string, role: string, includeArchived = false, userId?: string) {
    const rows = await this.repo.list(tenantId, includeArchived);
    if (role === 'client') return rows.map(toClientProject);
    if (!userId) return rows;
    const unread = new Map<string, number>();
    for (const u of await this.reads.byProjects(tenantId, userId)) {
      unread.set(String(u.project_id), Number(u.n));
    }
    return rows.map((r) => ({ ...r, unread: unread.get(String(r.id)) ?? 0 }));
  }

  /**
   * Архивация: проект уходит из сайдбара и списков, но данные и доска сохраняются.
   * Realtime-события не шлём: список проектов у других вкладок обновится при перезагрузке,
   * а плодить событие, которое никто не слушает, смысла нет.
   */
  async setArchived(tenantId: string, id: string, archived: boolean) {
    await this.getOrThrow(tenantId, id);
    await this.repo.setArchived(tenantId, id, archived);
    return { archived };
  }

  /**
   * Порядок досок — общий для компании.
   *
   * Перетаскиванием его задаёт руководитель: доски — общая рабочая поверхность,
   * и «у меня свой порядок» здесь только мешает договариваться о том, где что лежит.
   */
  async saveOrder(tenantId: string, ids: string[]) {
    await this.repo.saveOrder(tenantId, ids.map(String));
    return { saved: ids.length };
  }

  /** Ответственный за проект: пусто — снять. Сотрудник должен быть из этой же организации. */
  async setOwner(tenantId: string, id: string, userId: string | null) {
    await this.getOrThrow(tenantId, id);
    if (userId && !(await this.repo.userInTenant(tenantId, userId))) throw AppException.notFound('Сотрудник не найден');
    await this.repo.setOwner(tenantId, id, userId);
    return { ownerUserId: userId };
  }

  /** Пометить доску основной: такие всегда идут первыми, что бы ни принёс импорт. */
  async setDefault(tenantId: string, id: string, isDefault: boolean) {
    await this.getOrThrow(tenantId, id);
    await this.repo.setDefault(tenantId, id, isDefault);
    return { isDefault };
  }

  /**
   * «Порядок по умолчанию».
   *
   * После импорта из YouGile и Битрикса список превращается в кашу: чужие доски
   * вперемешку со своими. Одно нажатие возвращает понятный вид — основные доски
   * наверх, остальные по алфавиту. Ни задачи, ни сами доски при этом не трогаются.
   */
  async resetOrder(tenantId: string, role: string, userId: string) {
    await this.repo.resetOrder(tenantId);
    return this.list(tenantId, role, false, userId);
  }

  async create(tenantId: string, dto: CreateProjectDto) {
    return this.repo.create({
      tenantId,
      name: dto.name,
      clientId: dto.clientId ?? null,
      budget: dto.budget ?? null,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.getOrThrow(tenantId, id); // 404, если проект не из этой организации
    await this.repo.deleteCascade(tenantId, id);
    return { deleted: true };
  }

  // ───── управление колонками доски ─────
  private notifyColumns(tenantId: string, projectId: string) {
    this.realtime.emit(tenantId, projectId, 'column.updated', { projectId });
  }

  async addColumn(tenantId: string, projectId: string, name: string) {
    await this.getOrThrow(tenantId, projectId);
    const col = await this.repo.addColumn(tenantId, projectId, name.trim());
    this.notifyColumns(tenantId, projectId);
    if (col) await this.outbox.enqueue(tenantId, projectId, 'column.create', col.id);
    return col;
  }

  /**
   * Привести доску к набору по умолчанию: недостающие колонки — в начало.
   *
   * Возвращаем и то, что добавили, и полный список: доска у человека должна
   * перестроиться сразу, а не после перезагрузки страницы. Остальным участникам
   * о перестановке говорит `column.updated` — они смотрят на ту же доску.
   */
  async ensureDefaultColumns(tenantId: string, projectId: string) {
    await this.getOrThrow(tenantId, projectId);
    const { added } = await this.repo.ensureDefaultColumns(tenantId, projectId);
    // Во внешние системы уходят только НОВЫЕ колонки: перестановка своих — наше дело.
    for (const col of added) await this.outbox.enqueue(tenantId, projectId, 'column.create', col.id);
    this.notifyColumns(tenantId, projectId);
    return {
      added: added.map((c) => c.name),
      columns: await this.repo.listColumns(tenantId, projectId),
    };
  }

  async renameColumn(tenantId: string, projectId: string, columnId: string, name: string) {
    await this.getOrThrow(tenantId, projectId);
    const col = await this.repo.renameColumn(tenantId, projectId, columnId, name.trim());
    if (!col) throw AppException.notFound('Колонка не найдена');
    this.notifyColumns(tenantId, projectId);
    await this.outbox.enqueue(tenantId, projectId, 'column.rename', col.id);
    return col;
  }

  async deleteColumn(tenantId: string, projectId: string, columnId: string) {
    await this.getOrThrow(tenantId, projectId);
    const column = await this.repo.findColumn(tenantId, projectId, columnId);
    if (!column) throw AppException.notFound('Колонка не найдена');
    if ((await this.repo.countColumns(tenantId, projectId)) <= 1) {
      throw AppException.conflict('Нельзя удалить последнюю колонку доски');
    }
    // Задачи колонки переезжают в соседнюю — сначала ставим в очередь их перенос,
    // и только потом удаление колонки: воркер идёт по очереди по порядку и не удалит
    // колонку во внешней системе раньше, чем вынесет из неё задачи.
    const affected = await this.repo.columnTaskIds(tenantId, columnId);
    await this.repo.deleteColumn(tenantId, projectId, columnId);
    for (const taskId of affected) await this.outbox.enqueue(tenantId, projectId, 'task.move', taskId);
    await this.outbox.enqueue(tenantId, projectId, 'column.delete', columnId);
    this.notifyColumns(tenantId, projectId);
    return { deleted: true };
  }

  async moveColumn(tenantId: string, projectId: string, columnId: string, direction: 'left' | 'right') {
    await this.getOrThrow(tenantId, projectId);
    const column = await this.repo.findColumn(tenantId, projectId, columnId);
    if (!column) throw AppException.notFound('Колонка не найдена');
    await this.repo.moveColumn(tenantId, projectId, columnId, direction);
    this.notifyColumns(tenantId, projectId);
    return { moved: true };
  }

  async reorderColumns(tenantId: string, projectId: string, orderedIds: string[]) {
    await this.getOrThrow(tenantId, projectId);
    const cols = await this.repo.listColumns(tenantId, projectId);
    const existing = new Set(cols.map((c) => String(c.id)));
    const given = orderedIds.map(String);
    const unique = new Set(given);
    if (given.length !== existing.size || unique.size !== given.length || !given.every((id) => existing.has(id))) {
      throw AppException.validation('Некорректный порядок колонок (набор не совпадает с текущим)');
    }
    await this.repo.reorderColumns(tenantId, projectId, given);
    this.notifyColumns(tenantId, projectId);
    return { reordered: true };
  }

  async getOrThrow(tenantId: string, id: string): Promise<ProjectRow> {
    const row = await this.repo.findById(tenantId, id);
    if (!row) throw AppException.notFound('Project not found');
    return row;
  }
}

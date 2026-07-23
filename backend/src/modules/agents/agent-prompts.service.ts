import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AgentPromptsRepository } from './agent-prompts.repository';

/** Библиотека промптов агента: CRUD + резолв пресета для запуска. Личные/общие, tenant-изоляция. */
@Injectable()
export class AgentPromptsService {
  constructor(private readonly repo: AgentPromptsRepository) {}

  list(tenantId: string, userId: string) {
    return this.repo.listVisible(tenantId, userId);
  }

  create(tenantId: string, userId: string, dto: { name: string; instruction: string; model?: string; isShared?: boolean }) {
    return this.repo.create({
      tenantId, createdBy: userId,
      name: dto.name.trim(), instruction: dto.instruction.trim(),
      model: dto.model?.trim() || null, isShared: !!dto.isShared,
    });
  }

  async update(tenantId: string, userId: string, role: string, id: string, patch: { name?: string; instruction?: string; model?: string | null; isShared?: boolean }) {
    await this.assertCanModify(tenantId, userId, role, id);
    return this.repo.update(tenantId, id, {
      name: patch.name?.trim(),
      instruction: patch.instruction?.trim(),
      model: patch.model === undefined ? undefined : (patch.model?.trim() || null),
      isShared: patch.isShared,
    });
  }

  async remove(tenantId: string, userId: string, role: string, id: string) {
    await this.assertCanModify(tenantId, userId, role, id);
    await this.repo.remove(tenantId, id);
    return { deleted: true };
  }

  /** Применить пресет: вернуть инструкцию+модель, засчитать использование. */
  async resolve(tenantId: string, userId: string, id: string): Promise<{ instruction: string; model: string | null }> {
    const p = await this.repo.getVisible(tenantId, userId, id);
    if (!p) throw AppException.notFound('Промпт не найден');
    await this.repo.incrementUsage(id).catch(() => undefined);
    return { instruction: p.instruction, model: p.model };
  }

  /** Свой промпт может править автор; общий — ещё и owner/manager (модерация). */
  private async assertCanModify(tenantId: string, userId: string, role: string, id: string) {
    const p = await this.repo.getById(tenantId, id);
    if (!p) throw AppException.notFound('Промпт не найден');
    const isManager = role === 'owner' || role === 'manager';
    if (p.created_by !== userId && !isManager) throw AppException.forbidden('Можно менять только свои промпты');
  }
}

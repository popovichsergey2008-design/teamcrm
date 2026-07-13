import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { PromptRepository, PromptTemplateRow, PromptVersionRow } from './prompt.repository';

export interface ResolvedPrompt {
  body: string;
  model: string | null;
  params: Record<string, unknown>;
  versionId: string;
  version: number;
  variant: 'active' | 'testing';
}

/** Подставляет {{var}} из variables. Недостающие → пусто, лишние игнорируются. */
export function interpolate(body: string, variables: Record<string, unknown> = {}): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    const v = variables[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Детерминированный бакет 0..99 из строки (стабильная маршрутизация A/B по пользователю). */
export function abBucket(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) % 100;
}

/**
 * PromptOps: разрешение и управление версиями промптов.
 * resolve() — «горячий путь» ИИ-слоя; управление (create/activate/deprecate) — owner/manager.
 */
@Injectable()
export class PromptsService {
  private readonly log = new Logger('Prompts');

  constructor(private readonly repo: PromptRepository) {}

  /**
   * Разрешить действующий промпт для арендатора: tenant-override > глобальный дефолт, активная версия,
   * интерполяция {{var}}. Если есть B-вариант (testing+ab_split) и передан routingKey (обычно userId) —
   * детерминированно направляем долю трафика на B (стабильно для одного пользователя). null — если ключ
   * не заведён (вызывающий берёт хардкод-фолбэк).
   */
  async resolve(
    tenantId: string, key: string, variables: Record<string, unknown> = {}, routingKey?: string,
  ): Promise<ResolvedPrompt | null> {
    try {
      const tpl = await this.repo.effectiveTemplate(tenantId, key);
      if (!tpl) return null;
      const active = await this.repo.activeVersion(tpl.id);
      if (!active) return null;

      let chosen = active;
      let variant: ResolvedPrompt['variant'] = 'active';
      if (routingKey) {
        const testing = await this.repo.testingVersion(tpl.id);
        if (testing && testing.ab_split && abBucket(`${routingKey}:${tpl.id}`) < testing.ab_split) {
          chosen = testing;
          variant = 'testing';
        }
      }
      return {
        body: interpolate(chosen.body, variables),
        model: chosen.model,
        params: chosen.params ?? {},
        versionId: chosen.id,
        version: chosen.version,
        variant,
      };
    } catch (e) {
      // ИИ-слой не должен падать из-за PromptOps — деградируем к хардкод-дефолту у вызывающего.
      this.log.warn(`resolve(${key}) failed: ${(e as Error).message}`);
      return null;
    }
  }

  // ── Управление (owner/manager) ──

  /** Список фич-шаблонов с действующей активной версией и признаком кастомизации. */
  async listTemplates(tenantId: string) {
    const keys = await this.repo.listGlobalKeys();
    const out = [];
    for (const g of keys) {
      const override = await this.repo.findTenantTemplate(tenantId, g.key);
      const tpl = override ?? g;
      const active = await this.repo.activeVersion(tpl.id);
      out.push({
        key: g.key,
        title: g.title,
        description: g.description,
        customized: !!override,
        activeVersion: active?.version ?? null,
        model: active?.model ?? null,
        updatedAt: active?.created_at ?? null,
      });
    }
    return out;
  }

  /** Действующий шаблон арендатора + все его версии (override, иначе глобальный). */
  async versions(tenantId: string, key: string) {
    const tpl = await this.repo.effectiveTemplate(tenantId, key);
    if (!tpl) throw AppException.notFound('Промпт не найден');
    const versions = await this.repo.listVersions(tpl.id);
    return { key, title: tpl.title, customized: tpl.tenant_id !== null, versions: versions.map(view) };
  }

  /**
   * Новая версия (draft). Клон-он-райт: если арендатор ещё не кастомизировал —
   * клонируем глобальный дефолт в его override, затем добавляем версию. Системный дефолт не трогаем.
   */
  async createVersion(
    tenantId: string, userId: string, key: string,
    dto: { body: string; model?: string | null; params?: Record<string, unknown>; variables?: unknown[]; note?: string },
  ) {
    const tpl = await this.ensureTenantTemplate(tenantId, key);
    const version = await this.repo.nextVersion(tpl.id);
    const created = await this.repo.insertVersion({
      templateId: tpl.id,
      version,
      body: dto.body,
      model: dto.model ?? null,
      params: dto.params ?? {},
      variables: dto.variables ?? [],
      status: 'draft',
      note: dto.note ?? null,
      createdBy: userId,
    });
    return view(created!);
  }

  async activate(tenantId: string, key: string, version: number) {
    const tpl = await this.ensureTenantTemplate(tenantId, key);
    const v = await this.repo.getVersion(tpl.id, version);
    if (!v) throw AppException.notFound('Версия не найдена');
    await this.repo.activateVersion(tpl.id, version);
    return this.versions(tenantId, key);
  }

  /**
   * Запустить A/B: пометить версию B-вариантом со сплитом split% трафика (1..99).
   * Требует активный контроль (A); нельзя A/B-ить саму активную версию. Клон-он-райт (правка арендатора).
   */
  async setAbTest(tenantId: string, key: string, version: number, split: number) {
    if (!Number.isInteger(split) || split < 1 || split > 99) {
      throw AppException.validation('split должен быть целым 1..99');
    }
    const tpl = await this.ensureTenantTemplate(tenantId, key);
    const active = await this.repo.activeVersion(tpl.id);
    if (!active) throw AppException.validation('Нет активной версии — сначала активируйте контрольную (A)');
    if (active.version === version) throw AppException.validation('Нельзя запустить A/B на активной версии — выберите другую как B');
    const v = await this.repo.getVersion(tpl.id, version);
    if (!v) throw AppException.notFound('Версия не найдена');
    await this.repo.setTesting(tpl.id, version, split);
    return this.versions(tenantId, key);
  }

  async deprecate(tenantId: string, key: string, version: number) {
    const tpl = await this.repo.findTenantTemplate(tenantId, key);
    if (!tpl) throw AppException.notFound('Промпт ещё не кастомизирован');
    const v = await this.repo.getVersion(tpl.id, version);
    if (!v) throw AppException.notFound('Версия не найдена');
    if (v.status === 'active') throw AppException.validation('Нельзя вывести активную версию — сначала активируйте другую');
    await this.repo.setStatus(tpl.id, version, 'deprecated');
    return this.versions(tenantId, key);
  }

  async metrics(tenantId: string, key: string, days: number) {
    const tpl = await this.repo.effectiveTemplate(tenantId, key);
    if (!tpl) throw AppException.notFound('Промпт не найден');
    const rows = await this.repo.metricsByVersion(tpl.id, days, tenantId);
    return { key, periodDays: days, byVersion: rows };
  }

  /**
   * Обратная связь по результату версии промпта (аудит качества, P2).
   * Оценивать можно только версию своего арендатора или глобального дефолта (иначе 404 — чужая).
   */
  async submitFeedback(
    tenantId: string, userId: string,
    dto: { promptVersionId: string; rating: number; reworked?: boolean },
  ) {
    const rating = dto.rating > 0 ? 1 : -1;
    const owner = await this.repo.versionOwner(dto.promptVersionId);
    if (!owner) throw AppException.notFound('Версия промпта не найдена');
    if (owner.tenant_id !== null && String(owner.tenant_id) !== String(tenantId)) {
      throw AppException.notFound('Версия промпта не найдена');
    }
    await this.repo.insertFeedback({
      tenantId, promptVersionId: dto.promptVersionId, rating, reworked: !!dto.reworked, userId,
    });
    return { ok: true };
  }

  /** Гарантирует override арендатора (клон глобального при первой правке). */
  private async ensureTenantTemplate(tenantId: string, key: string): Promise<PromptTemplateRow> {
    const existing = await this.repo.findTenantTemplate(tenantId, key);
    if (existing) return existing;
    const global = await this.repo.findGlobalTemplate(key);
    if (!global) throw AppException.notFound('Неизвестный промпт');
    return this.repo.cloneToTenant(tenantId, global);
  }
}

/** Публичное представление версии (без внутренних id-полей БД, кроме id для feedback). */
function view(v: PromptVersionRow) {
  return {
    id: v.id,
    version: v.version,
    body: v.body,
    model: v.model,
    params: v.params,
    variables: v.variables,
    status: v.status,
    abSplit: v.ab_split,
    note: v.note,
    createdBy: v.created_by,
    createdAt: v.created_at,
  };
}

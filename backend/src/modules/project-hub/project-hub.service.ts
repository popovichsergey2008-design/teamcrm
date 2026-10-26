import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { BrainService } from '../brain/brain.service';
import { ClientsService } from '../clients/clients.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { memoryLink } from '../knowledge/memory-rules';
import { ProjectsService } from '../projects/projects.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CATEGORIES, HubSection, normalizeUrl, validCategory } from './hub-rules';
import { CreateItemDto, PassportDto, UpdateItemDto } from './project-hub.dto';
import { HubDecisionRow, HubItemRow, HubMemberRow, HubProjectRow, HubRunRow, ProjectHubRepository } from './project-hub.repository';

export interface HubUser { tenantId: string; userId: string; role: string }

/** Запись Инфоцентра наружу — форма из контракта для интерфейса (разбор ТЗ-39, «API»). */
export function itemOut(r: HubItemRow) {
  return {
    id: String(r.id), section: r.section, kind: r.kind, category: r.category, title: r.title, url: r.url,
    fileId: r.file_id, fileName: r.file_name, body: r.body, contact: r.contact ?? null, pinned: !!r.pinned,
    source: r.source as 'manual' | 'ai', origin: r.origin ?? null, createdAt: r.created_at,
    createdBy: r.created_by ? { id: String(r.created_by), name: r.created_by_name ?? '' } : null,
  };
}

export function decisionOut(d: HubDecisionRow) {
  const sec = d.source_sec != null ? Number(d.source_sec) : null;
  const source: 'meeting' | 'chat' = d.meeting_id ? 'meeting' : 'chat';
  return {
    id: String(d.id), text: d.text, decidedAt: d.decided_at, source,
    meetingId: d.meeting_id, chatId: d.chat_id, sourceSec: sec, speaker: d.speaker,
    link: memoryLink('decision', String(d.id), null, d.meeting_id
      ? { meetingId: d.meeting_id, ...(sec != null ? { sec } : {}) }
      : { chatId: d.chat_id ?? undefined, messageId: d.source_message_id ?? undefined }),
  };
}

export function runOut(r: HubRunRow) {
  const a = r.added ?? {};
  return {
    id: String(r.id), runDate: r.run_date, finishedAt: r.finished_at,
    added: { links: a.links ?? 0, files: a.files ?? 0, contacts: a.contacts ?? 0, notes: a.notes ?? 0, decisions: a.decisions ?? 0 },
    usedModel: !!r.used_model,
  };
}

function memberOut(m: HubMemberRow) {
  return {
    userId: String(m.user_id), name: m.name, avatarUrl: m.avatar_file_id ? `/api/files/${m.avatar_file_id}` : null,
    roleTitle: m.role_title, responsibility: m.responsibility, isOwner: !!m.is_owner,
  };
}

const clean = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
};

/** Ссылка, которую человек вписал руками: только http(s), «www.» дополняем. */
function manualUrl(raw: string | null | undefined): string | null {
  const t = clean(raw);
  if (!t) return null;
  const withProto = /^www\./i.test(t) ? `https://${t}` : t;
  if (!/^https?:\/\//i.test(withProto) || !normalizeUrl(withProto)) throw AppException.validation('Ссылка должна начинаться с http:// или https://');
  return withProto;
}

function contactOf(c: { name?: string; role?: string; phone?: string; email?: string; telegram?: string } | null | undefined) {
  if (!c) return null;
  const out: Record<string, string> = {};
  for (const k of ['name', 'role', 'phone', 'email', 'telegram'] as const) {
    const v = clean(c[k]);
    if (v) out[k] = v;
  }
  return out.name ? out : null;
}

/**
 * Инфоцентр проекта (#4659): паспорт, команда, база знаний, хроника решений, поиск.
 *
 * Права — одно правило: видит Инфоцентр тот, кто видит проект (иначе «не найдено» —
 * существование закрытого проекта не выдаём); клиенту Инфоцентр не показываем (403
 * ещё на уровне ролей). Править может каждый, кто видит, — каждое изменение помнит
 * автора, а ИИ-записи снимаются одним нажатием.
 */
@Injectable()
export class ProjectHubService {
  private readonly log = new Logger('ProjectHub');

  constructor(
    private readonly repo: ProjectHubRepository,
    private readonly projects: ProjectsService,
    private readonly clients: ClientsService,
    private readonly knowledge: KnowledgeService,
    private readonly brain: BrainService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Проект, если человек его видит. Иначе — 404, клиенту — 403. */
  async access(u: HubUser, projectId: string): Promise<HubProjectRow> {
    if (u.role === 'client') throw AppException.forbidden('Инфоцентр проекта доступен только команде');
    if (!/^\d+$/.test(String(projectId))) throw AppException.notFound('Проект не найден');
    const p = await this.repo.project(u.tenantId, projectId);
    if (!p || !(await this.projects.canSee(u.tenantId, projectId, u))) throw AppException.notFound('Проект не найден');
    return p;
  }

  /** Руководство и ответственный за проект — для выключателя библиотекаря и «Собрать сейчас». */
  isBoss(u: HubUser, p: HubProjectRow): boolean {
    return u.role === 'owner' || u.role === 'manager' || String(p.owner_user_id ?? '') === String(u.userId);
  }

  changed(tenantId: string, projectId: string) {
    this.realtime.emitScoped(tenantId, projectId, 'hub.changed', { projectId: String(projectId) }, false);
  }

  async get(u: HubUser, projectId: string) {
    const p = await this.access(u, projectId);
    const [items, members, decisions, lastRun, unseen, clientContacts] = await Promise.all([
      this.repo.items(u.tenantId, projectId),
      this.repo.members(u.tenantId, projectId),
      this.repo.decisions(u.tenantId, u, projectId, { limit: 5 }),
      this.repo.lastRun(u.tenantId, projectId),
      this.repo.unseenRun(u.tenantId, projectId, u.userId),
      this.clientContacts(u, p.client_id),
    ]);
    const by = (s: HubSection) => items.filter((i) => i.section === s).map(itemOut);
    const owner = members.find((m) => m.is_owner);
    return {
      project: {
        id: String(p.id), name: p.name, mission: p.mission, audience: p.audience, description: p.description ?? '',
        aliases: p.aliases ?? [], targetDate: p.target_date, clientId: p.client_id, clientName: p.client_name,
        hubLibrarian: !!p.hub_librarian,
      },
      passport: by('passport'),
      knowledge: by('knowledge'),
      team: {
        // Person: {id, name, avatarUrl} — уточнение фронта к контракту
        owner: owner ? { id: String(owner.user_id), name: owner.name, avatarUrl: memberOut(owner).avatarUrl } : null,
        members: members.map(memberOut),
        contacts: by('team'),
        clientContacts: clientContacts.items,
        // раскрытие маски — существующей ручкой клиентов (POST /client-contacts/:id/reveal)
        clientContactsCanReveal: clientContacts.canReveal,
      },
      decisions: { items: decisions.items.map(decisionOut), total: decisions.total },
      librarian: { lastRun: lastRun ? runOut(lastRun) : null, unseen: unseen ? runOut(unseen) : null },
      canEdit: u.role !== 'client',
      canRunLibrarian: this.isBoss(u, p),
    };
  }

  /**
   * Контакты заказчика — как их отдаёт раздел «Клиенты»: маскированные, если так велит
   * политика, и только тем, кому клиенты открыты. Нет прав или клиента — пусто, а не ошибка:
   * Инфоцентр не должен падать из-за соседнего раздела.
   */
  private async clientContacts(u: HubUser, clientId: string | null): Promise<{ items: any[]; canReveal: boolean }> {
    if (!clientId) return { items: [], canReveal: false };
    try {
      const v = await this.clients.contacts(u, clientId);
      return { items: v.hidden ? [] : v.items, canReveal: !!v.canReveal };
    } catch {
      return { items: [], canReveal: false };
    }
  }

  async patchPassport(u: HubUser, projectId: string, dto: PassportDto) {
    const p = await this.access(u, projectId);
    if (dto.hubLibrarian !== undefined && !this.isBoss(u, p)) {
      throw AppException.forbidden('Библиотекаря включает и выключает руководство или ответственный за проект');
    }
    await this.repo.patchPassport(u.tenantId, projectId, {
      mission: dto.mission !== undefined ? clean(dto.mission) : undefined,
      audience: dto.audience !== undefined ? clean(dto.audience) : undefined,
      description: dto.description !== undefined ? dto.description.trim() : undefined,
      hubLibrarian: dto.hubLibrarian,
    });
    // паспорт — в память заново: ответ «для кого мы делаем X» должен знать новую аудиторию
    if (dto.mission !== undefined || dto.audience !== undefined || dto.description !== undefined) {
      this.projects.reindex(u.tenantId, projectId);
    }
    this.changed(u.tenantId, projectId);
    const fresh = (await this.repo.project(u.tenantId, projectId))!;
    return {
      id: String(fresh.id), name: fresh.name, mission: fresh.mission, audience: fresh.audience, description: fresh.description ?? '',
      aliases: fresh.aliases ?? [], targetDate: fresh.target_date, clientId: fresh.client_id, clientName: fresh.client_name,
      hubLibrarian: !!fresh.hub_librarian,
    };
  }

  /** Проверка записи: раздел, вид и категория сходятся; у ссылки — ссылка, у файла — файл. */
  private checkShape(section: string, kind: string, category: string | null | undefined) {
    if (!validCategory(section, category ?? null)) {
      throw AppException.validation(`Категория для раздела: ${CATEGORIES[section as HubSection]?.join(', ') ?? '—'}`);
    }
    if (kind === 'contact' && section !== 'team') throw AppException.validation('Контакт кладётся в раздел «Команда»');
  }

  async createItem(u: HubUser, projectId: string, dto: CreateItemDto) {
    await this.access(u, projectId);
    this.checkShape(dto.section, dto.kind, dto.category);
    const url = manualUrl(dto.url);
    const contact = contactOf(dto.contact);
    let fileId: string | null = null;
    if (dto.kind === 'link' && !url) throw AppException.validation('Укажите ссылку');
    if (dto.kind === 'contact' && !contact) throw AppException.validation('Укажите имя контакта');
    if (dto.kind === 'note' && !clean(dto.body) && !clean(dto.title)) throw AppException.validation('Пустая заметка');
    if (dto.fileId) {
      // файл — только загруженный для Инфоцентра этого проекта: чужой номер не прицепить
      const f = await this.repo.hubFile(u.tenantId, projectId, String(dto.fileId));
      if (!f) throw AppException.validation('Файл не найден — загрузите его в Инфоцентр проекта');
      fileId = f.id;
    }
    if (dto.kind === 'file' && !fileId) throw AppException.validation('Приложите файл');
    if (url && await this.repo.urlTaken(u.tenantId, projectId, url)) throw AppException.conflict('Эта ссылка уже есть в Инфоцентре');
    const id = await this.repo.insertItem({
      tenantId: u.tenantId, projectId, section: dto.section, kind: dto.kind, category: clean(dto.category),
      title: dto.title.trim().slice(0, 200), url, fileId, body: clean(dto.body), contact,
      source: 'manual', origin: null, runId: null, createdBy: u.userId,
    });
    if (!id) throw AppException.conflict('Эта ссылка уже есть в Инфоцентре');
    void this.knowledge.enqueue(u.tenantId, 'hub', id);
    this.changed(u.tenantId, projectId);
    return itemOut((await this.repo.item(u.tenantId, projectId, id))!);
  }

  async updateItem(u: HubUser, projectId: string, itemId: string, dto: UpdateItemDto) {
    await this.access(u, projectId);
    const cur = await this.repo.item(u.tenantId, projectId, itemId);
    if (!cur || cur.removed_at) throw AppException.notFound('Запись не найдена');
    const section = dto.section ?? cur.section;
    const category = dto.category !== undefined ? clean(dto.category) : (dto.section && dto.section !== cur.section ? null : cur.category);
    this.checkShape(section, cur.kind, category);
    const url = dto.url !== undefined ? manualUrl(dto.url) : undefined;
    if (cur.kind === 'link' && url === null) throw AppException.validation('У ссылки должен быть адрес');
    if (url && await this.repo.urlTaken(u.tenantId, projectId, url, itemId)) throw AppException.conflict('Эта ссылка уже есть в Инфоцентре');
    const contact = dto.contact !== undefined ? contactOf(dto.contact) : undefined;
    if (cur.kind === 'contact' && dto.contact !== undefined && !contact) throw AppException.validation('Укажите имя контакта');
    const ok = await this.repo.updateItem(u.tenantId, projectId, itemId, u.userId, {
      title: dto.title !== undefined ? dto.title.trim().slice(0, 200) : undefined,
      category: dto.category !== undefined || (dto.section && dto.section !== cur.section) ? category : undefined,
      url, body: dto.body !== undefined ? clean(dto.body) : undefined, contact, pinned: dto.pinned, section: dto.section,
    }).catch((e) => {
      if ((e as { code?: string }).code === '23505') throw AppException.conflict('Эта ссылка уже есть в Инфоцентре');
      throw e;
    });
    if (!ok) throw AppException.notFound('Запись не найдена');
    void this.knowledge.enqueue(u.tenantId, 'hub', itemId);
    this.changed(u.tenantId, projectId);
    return itemOut((await this.repo.item(u.tenantId, projectId, itemId))!);
  }

  /** «Убрать» — мягко: ИИ-запись, убранную человеком, библиотекарь не вернёт. */
  async removeItem(u: HubUser, projectId: string, itemId: string) {
    await this.access(u, projectId);
    if (!(await this.repo.removeItem(u.tenantId, projectId, itemId, u.userId))) throw AppException.notFound('Запись не найдена');
    void this.knowledge.enqueue(u.tenantId, 'hub', itemId); // из памяти — тоже
    this.changed(u.tenantId, projectId);
    return { id: String(itemId), removed: true };
  }

  async setMember(u: HubUser, projectId: string, userId: string, dto: { roleTitle?: string | null; responsibility?: string | null }) {
    await this.access(u, projectId);
    const ok = await this.repo.setMember(u.tenantId, projectId, userId, {
      roleTitle: dto.roleTitle !== undefined ? clean(dto.roleTitle) : undefined,
      responsibility: dto.responsibility !== undefined ? clean(dto.responsibility) : undefined,
    });
    if (!ok) throw AppException.notFound('Человек не участвует в проекте');
    this.changed(u.tenantId, projectId);
    const m = (await this.repo.members(u.tenantId, projectId)).find((x) => String(x.user_id) === String(userId));
    return m ? memberOut(m) : null;
  }

  async decisions(u: HubUser, projectId: string, q: { before?: string; limit?: number }) {
    await this.access(u, projectId);
    const before = q.before && /^\d+$/.test(q.before) ? q.before : null;
    const r = await this.repo.decisions(u.tenantId, u, projectId, { before, limit: q.limit ?? 20 });
    return { items: r.items.map(decisionOut), total: r.total };
  }

  /** Что добавил прогон: записи (и убранные — с пометкой) и решения его окна, видимые зрителю. */
  async runDetail(u: HubUser, projectId: string, runId: string) {
    await this.access(u, projectId);
    if (!/^\d+$/.test(String(runId))) throw AppException.notFound('Прогон не найден');
    const run = await this.repo.run(u.tenantId, projectId, runId);
    if (!run) throw AppException.notFound('Прогон не найден');
    const [items, decisions] = await Promise.all([
      this.repo.runItems(u.tenantId, runId),
      this.repo.decisions(u.tenantId, u, projectId, { from: run.window_start, to: run.window_end, limit: 100 }),
    ]);
    return {
      run: runOut(run),
      items: items.map((i) => ({ ...itemOut(i), removed: !!i.removed_at })),
      decisions: decisions.items.map(decisionOut),
    };
  }

  async seen(u: HubUser, projectId: string, runId: string) {
    await this.access(u, projectId);
    if (!/^\d+$/.test(String(runId))) throw AppException.notFound('Прогон не найден');
    const run = await this.repo.run(u.tenantId, projectId, runId);
    if (!run) throw AppException.notFound('Прогон не найден');
    await this.repo.markSeen(u.tenantId, u.userId, projectId, runId);
    return { runId: String(runId), seen: true };
  }

  /** Поиск по проекту — тот же мозг, что «Спросить ИИ», в рамках проекта и с правами зрителя. */
  async ask(u: HubUser, projectId: string, q: string) {
    await this.access(u, projectId);
    const r = await this.brain.answer(u.tenantId, u.userId, q, projectId, u.role);
    return { answer: r.answer, citations: r.citations, cached: r.cached, play: r.play ?? null };
  }
}

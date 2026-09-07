import { Injectable, Logger } from '@nestjs/common';
import { ImportRepository } from '../common/import.repository';
import { NotionClient, NoDatabase } from './notion.client';
import {
  blocksToChecklist, blocksToMarkdown, databaseName, pageDate, pageHash, pageLabels, pagePeople,
  pagePriority, pageStatus, pageTitle, pickProperty, pickStatusProperty, pickTitleProperty, statusOptions,
} from './notion.map';

export interface NotionImportMsg {
  tenantId: string;
  connectionId: string;
  token: string;
  databaseIds: string[];
  runId: string;
  actorId: string | null;
}

interface Stats {
  databases: number; columns: number; tasks: number; updated: number;
  checklists: number; warnings: string[];
}

/** Цвет меток Notion → наш HEX. Незнакомый — серый, а не случайный. */
const LABEL_COLORS: Record<string, string> = {
  red: '#d64545', orange: '#e0791a', yellow: '#d6a417', green: '#2e9e5b',
  blue: '#3b82f6', purple: '#8b5cf6', pink: '#ec4899', brown: '#92400e', gray: '#6b7280',
};

/**
 * Импорт баз данных Notion.
 *
 * База → проект, варианты статуса → колонки, страницы → задачи, содержимое страницы →
 * описание (Markdown), пункты списка дел → чек-лист.
 *
 * Главное отличие от Trello и YouGile: у Notion нет доски как понятия. Колонками
 * становится то свойство, которое команда выбрала статусом, — и если его нет, все
 * задачи честно приезжают в одну колонку. Разложить их по случайному свойству было бы
 * хуже: человек увидел бы «доску», в которой колонки называются именами заказчиков.
 */
@Injectable()
export class NotionImportService {
  private readonly log = new Logger('NotionImport');

  constructor(private readonly repo: ImportRepository) {}

  async run(msg: NotionImportMsg): Promise<void> {
    const stats: Stats = { databases: 0, columns: 0, tasks: 0, updated: 0, checklists: 0, warnings: [] };
    await this.repo.setRunRunning(msg.runId);
    try {
      const client = new NotionClient(msg.token);
      const people = await this.peopleMap(msg, client);

      for (const dbId of msg.databaseIds) {
        try {
          await this.importDatabase(client, msg, dbId, people, stats);
        } catch (e) {
          stats.warnings.push(`База ${dbId}: ${(e as Error).message}`);
        }
        await this.repo.setRunStats(msg.runId, stats);
      }
      await this.repo.finishRun(msg.runId, 'done', stats);
      this.log.log(`Notion: баз ${stats.databases}, задач ${stats.tasks} (+${stats.updated} обновлено)`);
    } catch (e) {
      await this.repo.finishRun(msg.runId, 'error', stats, (e as Error).message);
      this.log.warn(`Notion import failed: ${(e as Error).message}`);
    }
  }

  private async importDatabase(
    client: NotionClient,
    msg: NotionImportMsg,
    databaseId: string,
    people: Map<string, string>,
    stats: Stats,
  ) {
    const { tenantId, connectionId } = msg;
    const db: NoDatabase = await client.database(databaseId);

    const project = await this.repo.upsertProject({
      tenantId, connectionId, externalId: String(db.id),
      name: databaseName(db), origin: 'notion',
    });
    stats.databases++;

    const statusProp = pickStatusProperty(db);
    const titleProp = pickTitleProperty(db);
    const dueProp = pickProperty(db, 'date', /(срок|дедлайн|дата|due|deadline|date)/i);
    const peopleProp = pickProperty(db, 'people', /(исполнител|ответствен|assignee|owner|person)/i);
    const labelsProp = pickProperty(db, 'multi_select', /(метк|тег|label|tag)/i);
    const prioProp = pickProperty(db, 'select', /(приоритет|важн|priority)/i);
    if (!statusProp) {
      stats.warnings.push(`База «${databaseName(db)}»: свойства статуса нет — все задачи в одной колонке`);
    }

    // Колонки: варианты статуса в их же порядке. Заводим ВСЕ сразу, а не по мере
    // появления задач, — иначе доска получится с дырами и в случайном порядке.
    const options = statusOptions(db, statusProp);
    const columnByStatus = new Map<string, string>();
    const doneStatuses = new Set<string>();
    for (let i = 0; i < options.length; i++) {
      const id = await this.repo.upsertColumn({
        tenantId, connectionId, projectId: project.id,
        externalId: `${db.id}:${options[i].name}`, name: options[i].name, position: i,
      });
      columnByStatus.set(options[i].name, id);
      if (options[i].done) doneStatuses.add(options[i].name);
      stats.columns++;
    }
    const fallbackColumn = await this.repo.ensureFallbackColumn(tenantId, project.id);

    const pages = await client.pages(databaseId);
    for (const page of pages) {
      try {
        const blocks = await client.blocks(page.id).catch(() => []);
        const title = pageTitle(page, titleProp);
        const description = blocksToMarkdown(blocks);
        const checklist = blocksToChecklist(blocks);
        const status = pageStatus(page, statusProp);
        const due = pageDate(page, dueProp);
        const labels = pageLabels(page, labelsProp);
        const assignee = pagePeople(page, peopleProp).map((id) => people.get(id)).find(Boolean) ?? null;
        const archived = !!page.archived;
        // «Готово» — либо статус из завершающей группы, либо страница в корзине Notion
        const done = archived || (status ? doneStatuses.has(status) : false);

        const hash = pageHash({ title, description, status, due, labels, assignee: assignee ?? null, checklist, archived });
        const task = await this.repo.upsertTask({
          tenantId, connectionId, externalId: String(page.id),
          projectId: project.id,
          columnId: (status && columnByStatus.get(status)) || fallbackColumn,
          title: title.slice(0, 255),
          description: description || null,
          assigneeId: assignee ?? null,
          createdBy: msg.actorId,
          priority: pagePriority(page, prioProp),
          deadlineAt: due,
          status: done ? 'done' : 'open',
          closed: done,
          hash,
        });
        if (task.created) stats.tasks++;
        else if (task.changed) stats.updated++;
        if (!task.changed) continue;

        if (labels.length) {
          const ids: string[] = [];
          for (const name of labels) {
            const color = this.labelColor(page, labelsProp, name);
            ids.push(await this.repo.ensureLabel(tenantId, name, color));
          }
          await this.repo.setTaskLabels(tenantId, task.id, ids);
        }
        if (checklist.length) {
          await this.repo.replaceChecklist(tenantId, task.id, checklist);
          stats.checklists++;
        }
      } catch (e) {
        stats.warnings.push(`Страница «${pageTitle(page, titleProp)}»: ${(e as Error).message}`);
      }
    }
  }

  private labelColor(page: any, labelsProp: string | null, name: string): string {
    if (!labelsProp) return LABEL_COLORS.gray;
    const arr = page.properties?.[labelsProp]?.multi_select ?? [];
    const hit = arr.find((o: any) => String(o?.name ?? '').trim() === name);
    return LABEL_COLORS[String(hit?.color ?? 'gray').toLowerCase()] ?? LABEL_COLORS.gray;
  }

  /**
   * Люди Notion → наши сотрудники: по почте, затем по имени.
   *
   * Почту Notion отдаёт только для настоящих людей рабочего пространства (не гостей и
   * не ботов), поэтому имя — полноправный второй путь, а не запасной.
   */
  private async peopleMap(msg: NotionImportMsg, client: NotionClient): Promise<Map<string, string>> {
    const [manual, byEmail, byName] = await Promise.all([
      this.repo.userRefs(msg.connectionId),
      this.repo.userEmailMap(msg.tenantId),
      this.repo.userNameMap(msg.tenantId),
    ]);
    const out = new Map<string, string>();
    const users = await client.users().catch(() => []);
    for (const u of users) {
      const ext = String(u.id);
      const manualHit = manual.get(ext);
      if (manualHit) { out.set(ext, manualHit); continue; }
      const email = (u.person?.email ?? '').toLowerCase();
      const emailHit = email ? byEmail.get(email) : undefined;
      if (emailHit) { out.set(ext, emailHit); continue; }
      const key = String(u.name ?? '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
      const nameHit = key ? byName.get(key) : undefined;
      if (nameHit) out.set(ext, nameHit);
    }
    return out;
  }
}

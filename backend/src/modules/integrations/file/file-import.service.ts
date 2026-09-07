import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../../../common/http/app-exception';
import { RedisService } from '../../../cache/redis.service';
import { DbService } from '../../../database/db.service';
import { ProjectsRepository } from '../../projects/projects.repository';
import { TasksService } from '../../tasks/tasks.service';
import {
  guessMapping, ImportField, parseBool, parseDate, parseHours, parsePriority, splitLabels,
} from './import-map';
import { MAX_ROWS, readTable, splitHeader } from './table-read';

/** Сопоставление: поле задачи → номер колонки файла. */
export type Mapping = Partial<Record<ImportField, number>>;

export interface ImportStats {
  created: number;
  updated: number;
  skipped: number;
  projects: string[];
  /** Что пошло не так, человеческим языком. Импорт без отчёта — это лотерея. */
  warnings: string[];
}

interface Parked {
  fileName: string;
  headers: string[];
  rows: string[][];
}

/** Разобранный файл живёт полчаса: столько хватает на сопоставление колонок. */
const PARK_TTL = 30 * 60;
const PARK_KEY = (tenantId: string, token: string) => `import:file:${tenantId}:${token}`;

/**
 * Импорт задач из файла (CSV/Excel).
 *
 * Первый и главный источник «переезда в один клик»: из таблицы грузится что угодно —
 * выгрузки Trello, Notion, Asana, Jira и любые самописные списки. Ключей и согласий
 * не требует, а значит работает всегда, в отличие от импорта по API.
 *
 * Путь человека: файл → мы угадали колонки → он поправил → предпросмотр → импорт.
 * Предпросмотр обязателен: молча записать 500 задач не туда — это работа на день
 * по разгребанию.
 *
 * Разобранная таблица между этими шагами лежит в Redis: гонять файл по сети дважды
 * незачем, а держать в памяти процесса нельзя — их несколько, и второй запрос
 * прилетит в соседний.
 */
@Injectable()
export class FileImportService {
  private readonly log = new Logger('FileImport');

  constructor(
    private readonly redis: RedisService,
    private readonly db: DbService,
    private readonly projects: ProjectsRepository,
    private readonly tasks: TasksService,
  ) {}

  /** Разобрать файл и показать, что в нём. Ничего не записываем. */
  async preview(tenantId: string, fileName: string, buf: Buffer) {
    let table: string[][];
    try {
      table = await readTable(fileName, buf);
    } catch (e) {
      throw AppException.validation((e as Error).message || 'Файл не читается');
    }
    const { headers, rows } = splitHeader(table);
    if (!headers.length || !rows.length) {
      throw AppException.validation('В файле нет строк с данными. Первая строка должна быть заголовком.');
    }

    const token = randomBytes(12).toString('hex');
    const parked: Parked = { fileName, headers, rows };
    await this.redis.setJson(PARK_KEY(tenantId, token), parked, PARK_TTL);

    return {
      token,
      fileName,
      headers,
      mapping: guessMapping(headers),
      totalRows: rows.length,
      // первые строки — глазами: по ним человек и поймёт, туда ли поехали колонки
      sample: rows.slice(0, 10),
      truncated: table.length - 1 > MAX_ROWS,
    };
  }

  /**
   * Записать задачи.
   *
   * Идемпотентность — по колонке с идентификатором старой системы, если человек её
   * указал: повторный прогон того же файла обновит задачи, а не создаст вторые.
   * Без такой колонки честно предупреждаем в отчёте.
   */
  async run(
    tenantId: string,
    userId: string,
    input: { token: string; mapping: Mapping; projectId?: string; newProjectName?: string },
  ): Promise<ImportStats> {
    const parked = await this.redis.getJson<Parked>(PARK_KEY(tenantId, input.token));
    if (!parked) throw AppException.notFound('Файл больше не в работе — загрузите его заново');

    const mapping = input.mapping ?? {};
    if (mapping.title === undefined) throw AppException.validation('Укажите, в какой колонке название задачи');

    const stats: ImportStats = { created: 0, updated: 0, skipped: 0, projects: [], warnings: [] };
    const people = await this.people(tenantId);
    const cell = (row: string[], field: ImportField): string => {
      const at = mapping[field];
      return at === undefined ? '' : (row[at] ?? '').trim();
    };

    // Проект: либо один на весь файл, либо из колонки. Проекты и колонки заводим по
    // мере надобности и запоминаем — иначе на каждую строку уходил бы запрос.
    const projectCache = new Map<string, { id: string; columns: { id: string; name: string }[] }>();
    const base = await this.baseProject(tenantId, userId, input, stats);

    const seenExternal = new Map<string, string>();
    if (mapping.externalId === undefined) {
      stats.warnings.push('Колонка с идентификатором не указана: повторный импорт этого файла создаст задачи заново.');
    }

    for (const row of parked.rows) {
      const title = cell(row, 'title');
      if (!title) { stats.skipped++; continue; } // строка без названия — не задача

      try {
        const projectName = cell(row, 'project');
        const project = projectName && mapping.project !== undefined
          ? await this.projectByName(tenantId, userId, projectName, projectCache, stats)
          : base;

        const columnName = cell(row, 'column');
        const columnId = this.pickColumn(project.columns, columnName);

        const externalId = cell(row, 'externalId');
        const key = externalId ? `${project.id}:${externalId}` : '';
        if (key && seenExternal.has(key)) { stats.skipped++; continue; } // дубль внутри файла

        const deadline = parseDate(cell(row, 'deadline'));
        const assignee = this.findPerson(people, cell(row, 'assignee'));
        const manager = this.findPerson(people, cell(row, 'manager'));
        if (mapping.assignee !== undefined && cell(row, 'assignee') && !assignee) {
          const who = cell(row, 'assignee');
          const note = `Не нашли сотрудника «${who}» — задача «${title}» создана без исполнителя`;
          if (stats.warnings.length < 50 && !stats.warnings.includes(note)) stats.warnings.push(note);
        }

        const existing = externalId
          ? await this.byExternal(tenantId, project.id, externalId)
          : null;

        if (existing) {
          await this.tasks.update(tenantId, existing, {
            title,
            description: cell(row, 'description') || undefined,
            assigneeId: assignee ?? undefined,
            priority: mapping.priority !== undefined ? parsePriority(cell(row, 'priority')) : undefined,
          } as never, userId);
          stats.updated++;
        } else {
          const created = await this.tasks.create(tenantId, {
            projectId: project.id,
            columnId,
            title: title.slice(0, 255),
            description: this.description(cell(row, 'description'), externalId, parked.fileName),
            assigneeId: assignee ?? undefined,
            managerId: manager ?? userId,
            priority: mapping.priority !== undefined ? parsePriority(cell(row, 'priority')) : undefined,
            deadlineAt: deadline ? deadline.toISOString() : undefined,
            estimateHours: parseHours(cell(row, 'estimate')) ?? undefined,
            // приёмка чужих задач никому не нужна: их не сдавали нам, их перевезли
            requiresApproval: false,
          } as never, userId);
          if (key) seenExternal.set(key, String(created.id));
          await this.attachLabels(tenantId, String(created.id), splitLabels(cell(row, 'labels')), stats);
          if (mapping.done !== undefined && parseBool(cell(row, 'done'))) {
            await this.closeTask(tenantId, userId, String(created.id), project.columns);
          }
          stats.created++;
        }
      } catch (e) {
        stats.skipped++;
        const note = `Строка «${title}»: ${(e as Error).message}`;
        if (stats.warnings.length < 50) stats.warnings.push(note);
      }
    }

    // Файл больше не нужен: держать чужую выгрузку в Redis дольше необходимого незачем.
    await this.redis.del(PARK_KEY(tenantId, input.token));
    this.log.log(`импорт из файла: создано ${stats.created}, обновлено ${stats.updated}, пропущено ${stats.skipped}`);
    return stats;
  }

  /** Куда грузить, если проект в файле не указан. */
  private async baseProject(
    tenantId: string,
    userId: string,
    input: { projectId?: string; newProjectName?: string },
    stats: ImportStats,
  ) {
    if (input.projectId) {
      const project = await this.projects.findById(tenantId, input.projectId);
      if (!project) throw AppException.notFound('Проект не найден');
      const columns = await this.projects.listColumns(tenantId, input.projectId);
      return { id: String(project.id), columns: columns.map((c) => ({ id: String(c.id), name: c.name })) };
    }
    const name = (input.newProjectName ?? '').trim() || 'Импорт из файла';
    const created = await this.projects.create({ tenantId, name });
    stats.projects.push(name);
    const columns = await this.projects.listColumns(tenantId, String(created.id));
    return { id: String(created.id), columns: columns.map((c) => ({ id: String(c.id), name: c.name })) };
  }

  /** Проект по имени из колонки файла: находим свой или заводим новый. */
  private async projectByName(
    tenantId: string,
    userId: string,
    name: string,
    cache: Map<string, { id: string; columns: { id: string; name: string }[] }>,
    stats: ImportStats,
  ) {
    const key = name.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;

    const found = await this.db.one<{ id: string }>(
      `SELECT id FROM projects WHERE tenant_id = $1 AND lower(name) = lower($2) AND status <> 'archived' LIMIT 1`,
      [tenantId, name],
    );
    const projectId = found?.id
      ? String(found.id)
      : String((await this.projects.create({ tenantId, name: name.slice(0, 120) })).id);
    if (!found?.id) stats.projects.push(name);

    const columns = await this.projects.listColumns(tenantId, projectId);
    const value = { id: projectId, columns: columns.map((c) => ({ id: String(c.id), name: c.name })) };
    cache.set(key, value);
    return value;
  }

  /**
   * Колонка по названию из файла.
   *
   * Новых колонок НЕ заводим: чужая выгрузка со свободным полем статуса способна
   * породить полсотни колонок и превратить доску в ленту. Не нашли — кладём в первую,
   * это всегда «входящие» по смыслу.
   */
  private pickColumn(columns: { id: string; name: string }[], name: string): string {
    const want = name.trim().toLowerCase();
    if (want) {
      const exact = columns.find((c) => c.name.trim().toLowerCase() === want);
      if (exact) return exact.id;
      const partial = columns.find((c) => c.name.trim().toLowerCase().includes(want) || want.includes(c.name.trim().toLowerCase()));
      if (partial) return partial.id;
    }
    return columns[0].id;
  }

  /** Люди организации: по ним ищем исполнителя из файла. */
  private async people(tenantId: string) {
    return this.db.many<{ id: string; full_name: string; email: string }>(
      `SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND is_active`,
      [tenantId],
    );
  }

  /**
   * Кто это. Сначала почта (однозначно), потом полное имя, потом фамилия+имя в любом
   * порядке. Не нашли — молчать нельзя: человек попадёт в отчёт, а задача создастся
   * без исполнителя, но создастся.
   */
  private findPerson(people: { id: string; full_name: string; email: string }[], raw: string): string | null {
    const v = raw.trim().toLowerCase();
    if (!v) return null;
    const byEmail = people.find((p) => (p.email ?? '').toLowerCase() === v);
    if (byEmail) return String(byEmail.id);
    const byName = people.find((p) => (p.full_name ?? '').trim().toLowerCase() === v);
    if (byName) return String(byName.id);
    // «Попович Сергей» против «Сергей Попович» — те же слова в другом порядке
    const words = v.split(/\s+/).filter(Boolean).sort().join(' ');
    const byWords = people.find((p) => (p.full_name ?? '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ') === words);
    return byWords ? String(byWords.id) : null;
  }

  /** Описание с пометкой, откуда задача приехала: через месяц это единственный след. */
  private description(text: string, externalId: string, fileName: string): string | undefined {
    const parts = [text.trim()].filter(Boolean);
    const mark = externalId
      ? `Импортировано из «${fileName}», исходный номер ${externalId}`
      : `Импортировано из «${fileName}»`;
    parts.push(`\n---\n${mark}`);
    return parts.join('\n');
  }

  /** Задача этого импорта по внешнему номеру — чтобы повтор не плодил дубли. */
  private async byExternal(tenantId: string, projectId: string, externalId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM tasks
        WHERE tenant_id = $1 AND project_id = $2
          AND description LIKE $3
        ORDER BY id DESC LIMIT 1`,
      [tenantId, projectId, `%исходный номер ${externalId}`],
    );
    return row?.id ? String(row.id) : null;
  }

  /** Метки: заводим недостающие и вешаем. Ошибка одной метки не роняет задачу. */
  private async attachLabels(tenantId: string, taskId: string, names: string[], stats: ImportStats) {
    for (const name of names) {
      try {
        const label = await this.db.one<{ id: string }>(
          `INSERT INTO labels (tenant_id, name) VALUES ($1, $2)
           ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [tenantId, name.slice(0, 48)],
        );
        if (label?.id) {
          await this.db.query(
            `INSERT INTO task_labels (tenant_id, task_id, label_id) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [tenantId, taskId, label.id],
          );
        }
      } catch {
        if (stats.warnings.length < 50) stats.warnings.push(`Метка «${name}» не перенеслась`);
      }
    }
  }

  /**
   * Уже сделанная задача переезжает сразу в финальную колонку — иначе доска врёт:
   * привезли сто закрытых задач, а они лежат в «Новых».
   *
   * Переносим через сервис, а не запросом: он проставит статус, закроет задачу и
   * разошлёт события — ровно как ручной перенос карточки. `confirmGate` обязателен:
   * приёмка работы законно спросила бы про незакрытый чек-лист, а спрашивать здесь
   * некого.
   */
  private async closeTask(tenantId: string, userId: string, taskId: string, columns: { id: string; name: string }[]) {
    const done = columns[columns.length - 1];
    if (!done) return;
    await this.tasks.move(tenantId, taskId, { columnId: done.id, position: 0, confirmGate: true } as never, userId)
      .catch(() => undefined);
  }
}

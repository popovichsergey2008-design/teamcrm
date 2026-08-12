import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { YougileRepository } from './yougile.repository';
import { YougileClient, YgTask } from './yougile.client';

export interface YougileImportMsg {
  tenantId: string; connectionId: string; apiKey: string; boardExternalIds: string[]; runId: string; actorId: string | null;
}

interface Stats { boards: number; columns: number; tasks: number; skipped: number; warnings: string[] }

@Injectable()
export class YougileImportService {
  private readonly log = new Logger('YougileImport');

  constructor(private readonly repo: YougileRepository) {}

  /** Фоновый импорт выбранных досок YouGile: доски→проекты, колонки, задачи (исполнители/сроки). Идемпотентно. */
  async run(msg: YougileImportMsg): Promise<void> {
    const { tenantId, connectionId, runId } = msg;
    const stats: Stats = { boards: 0, columns: 0, tasks: 0, skipped: 0, warnings: [] };
    await this.repo.setRunRunning(runId);
    try {
      const client = new YougileClient(msg.apiKey);

      // карта пользователей YouGile → локальные (по e-mail автоматически + ручные привязки)
      const [ygUsers, emailMap, manual] = await Promise.all([
        client.listUsers(), this.repo.userEmailMap(tenantId), this.repo.userRefs(connectionId),
      ]);
      const userMap = new Map<string, string>();
      for (const u of ygUsers) {
        const byManual = manual.get(String(u.id));
        const byEmail = u.email ? emailMap.get(u.email.toLowerCase()) : undefined;
        const local = byManual ?? byEmail;
        if (local) userMap.set(String(u.id), local);
      }

      // доски и колонки — одним махом, колонки группируем по доске
      const [boards, columns] = await Promise.all([client.listBoards(), client.listColumns()]);
      const colsByBoard = new Map<string, typeof columns>();
      for (const c of columns) {
        if (c.deleted) continue;
        const arr = colsByBoard.get(String(c.boardId)) ?? [];
        arr.push(c); colsByBoard.set(String(c.boardId), arr);
      }

      for (const boardId of msg.boardExternalIds) {
        const board = boards.find((b) => String(b.id) === String(boardId));
        if (!board || board.deleted) { stats.warnings.push(`Доска ${boardId} не найдена`); continue; }

        const project = await this.repo.upsertProject({ tenantId, connectionId, externalId: String(board.id), name: board.title || 'Без названия' });
        stats.boards++;

        const cols = colsByBoard.get(String(board.id)) ?? [];
        const localColByExt = new Map<string, string>();
        let pos = 0; // порядок колонок = порядок массива YouGile
        for (const col of cols) {
          const localColId = await this.repo.upsertColumn({ tenantId, connectionId, projectId: project.id, externalId: String(col.id), name: col.title || 'Колонка', position: pos++ });
          localColByExt.set(String(col.id), localColId);
          stats.columns++;
        }
        const fallbackCol = cols.length === 0 ? await this.repo.ensureFallbackColumn(tenantId, project.id) : null;

        for (const col of cols) {
          let tasks: YgTask[] = [];
          try { tasks = await client.listTasks(String(col.id)); }
          catch (e) { stats.warnings.push(`Колонка «${col.title}»: ${(e as Error).message}`); continue; }
          const localColId = localColByExt.get(String(col.id)) ?? fallbackCol!;
          for (const t of tasks) {
            if (t.deleted || t.archived) { stats.skipped++; continue; }
            await this.importTask(tenantId, connectionId, project.id, localColId, t, userMap);
            stats.tasks++;
          }
          await this.repo.setRunStats(runId, stats);
        }
        await this.repo.setRunStats(runId, stats);
      }

      await this.repo.finishRun(runId, 'done', stats);
    } catch (e) {
      this.log.warn(`import run ${runId} failed: ${(e as Error).message}`);
      await this.repo.finishRun(runId, 'error', stats, (e as Error).message);
    }
  }

  private async importTask(tenantId: string, connectionId: string, projectId: string, columnId: string, t: YgTask, userMap: Map<string, string>) {
    const assigneeId = (t.assigned ?? []).map((u) => userMap.get(String(u))).find(Boolean) ?? null;
    const createdBy = t.createdBy ? userMap.get(String(t.createdBy)) ?? null : null;
    const deadlineMs = t.deadline?.deadline;
    const deadlineAt = deadlineMs ? new Date(Number(deadlineMs)).toISOString() : null;
    const completed = !!t.completed;
    const description = t.description ? String(t.description).slice(0, 20000) : null;
    const hash = createHash('sha256')
      .update([t.title, description ?? '', columnId, (t.assigned ?? []).join(','), deadlineAt ?? '', completed ? '1' : '0'].join('|'))
      .digest('hex').slice(0, 64);
    await this.repo.upsertTask({
      tenantId, connectionId, externalId: String(t.id), projectId, columnId,
      title: (t.title || 'Без названия').slice(0, 255), description,
      assigneeId, createdBy, priority: 'normal', deadlineAt,
      status: completed ? 'done' : 'todo', closed: completed, hash,
    });
  }
}

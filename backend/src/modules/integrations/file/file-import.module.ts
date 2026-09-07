import { Module } from '@nestjs/common';
import { ProjectsModule } from '../../projects/projects.module';
import { TasksModule } from '../../tasks/tasks.module';
import { FileImportController } from './file-import.controller';
import { FileImportService } from './file-import.service';

/**
 * Импорт «в один клик» из файла (CSV/Excel) — слой 1 ТЗ-4.
 *
 * Универсальный вход: через таблицу переезжают выгрузки Trello, Notion, Asana, Jira и
 * любые самописные списки. Ключей и согласий не требует, поэтому и сделан первым.
 */
@Module({
  imports: [ProjectsModule, TasksModule],
  controllers: [FileImportController],
  providers: [FileImportService],
})
export class FileImportModule {}

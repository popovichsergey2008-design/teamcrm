import { Module } from '@nestjs/common';
import { TaskReadsRepository } from './task-reads.repository';

/**
 * Отметки «я это видел» — отдельным модулем.
 *
 * Непрочитанное нужно и задачам, и доске, и списку проектов, и счётчикам панели.
 * Проекты при этом не могут импортировать модуль задач: задачи сами зависят от
 * проектов, и получился бы круг. Общая зависимость выносится наружу — это дешевле
 * и честнее, чем forwardRef.
 */
@Module({
  providers: [TaskReadsRepository],
  exports: [TaskReadsRepository],
})
export class TaskReadsModule {}

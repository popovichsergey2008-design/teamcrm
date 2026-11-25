import { Module } from '@nestjs/common';
import { SecretaryDocsController } from './secretary-docs.controller';
import { SecretaryDocsRepository } from './secretary-docs.repository';
import { SecretaryDocsService } from './secretary-docs.service';

/**
 * Функции секретаря из таблицы #1476: сроки документов (F20), поздравления клиентам (F11),
 * проверка договора (F21), чеки → авансовый отчёт (F24). Ящик секретаря, ИИ и файлы —
 * глобальные модули, встречных импортов нет.
 */
@Module({
  controllers: [SecretaryDocsController],
  providers: [SecretaryDocsService, SecretaryDocsRepository],
})
export class SecretaryDocsModule {}

import { Module } from '@nestjs/common';
import { PulseIndexRepository } from './pulse-index.repository';
import { PulseIndexService } from './pulse-index.service';

/**
 * Индекс здоровья команды (#4890, п. 1) отдельным лёгким модулем: его считают и Пульс,
 * и разбор решений в Фокусе (плашка «индекс 47 → 48»), и «Пульс недели».
 */
@Module({
  providers: [PulseIndexService, PulseIndexRepository],
  exports: [PulseIndexService],
})
export class RadarIndexModule {}

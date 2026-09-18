import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MetricsController } from './metrics.controller';

/**
 * Метрики приложения для Prometheus.
 *
 * Отдельным модулем, а не частью поддержки: цифры отсюда нужны и про очередь, и про
 * обращения к модели, и завтра — про созвоны. Класть их в модуль, который случайно
 * оказался первым, значит однажды импортировать поддержку ради метрики о почте.
 */
@Module({
  imports: [AiModule],
  controllers: [MetricsController],
})
export class MetricsModule {}

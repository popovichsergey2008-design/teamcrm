import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { ProjectSecretsController } from './project-secrets.controller';
import { ProjectSecretsService } from './project-secrets.service';

/**
 * #4902, п. 13: «Секреты» проекта — куда переносится пароль из переписки.
 *
 * Отдельным модулем: чатам он нужен одной кнопкой, а шифрование и права на проект —
 * своя забота. Из чатов берём только репозиторий (адресаты события правки).
 */
@Module({
  imports: [ChatsModule, RealtimeModule],
  controllers: [ProjectSecretsController],
  providers: [ProjectSecretsService, IntegrationCryptoService],
})
export class ProjectSecretsModule {}

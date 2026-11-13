import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { ChatsModule } from '../chats/chats.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { MediaModule } from '../media/media.module';
import { ClientChatController, ClientChatPublicController } from './client-chat.controller';
import { ClientChatRepository } from './client-chat.repository';
import { ClientChatService } from './client-chat.service';

/**
 * Клиент в чате без регистрации (#4902, п. 15) — отдельным модулем: ему нужны и чаты
 * (сообщение гостя приходит сотрудникам обычным chat.message), и созвоны (гостевой вход
 * в звонок этого чата), и пределы частоты публичных ручек.
 */
@Module({
  imports: [AiModule, AuthModule, ChatsModule, MediaModule],
  controllers: [ClientChatController, ClientChatPublicController],
  providers: [ClientChatService, ClientChatRepository, IntegrationCryptoService],
})
export class ClientChatModule {}

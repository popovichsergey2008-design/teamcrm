import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { ClientsModule } from '../clients/clients.module';
import { FilesModule } from '../files/files.module';
import { MailboxModule } from '../mailbox/mailbox.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromptsModule } from '../prompts/prompts.module';
import { ClientFollowupService } from './client-followup.service';
import { MorningVoiceService } from './morning-voice.service';

/**
 * Навыки секретаря, которым нужны чужие модули (ТЗ-21, этапы 6–7): письмо клиенту
 * после встречи и утренний бриф голосом. Ящик и планировщик — из глобального модуля.
 */
@Module({
  imports: [AiModule, ChatsModule, ClientsModule, FilesModule, MailboxModule, NotificationsModule, PromptsModule],
  providers: [ClientFollowupService, MorningVoiceService],
  exports: [ClientFollowupService, MorningVoiceService],
})
export class SecretarySkillsModule {}

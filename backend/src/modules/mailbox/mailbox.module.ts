import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { MailOAuthService } from './mail-oauth.service';
import { MailboxController } from './mailbox.controller';
import { MailboxRepository } from './mailbox.repository';
import { MailboxScheduler } from './mailbox.scheduler';
import { MailboxService } from './mailbox.service';

/** Личная почта сотрудника (ТЗ-18): IMAP/SMTP паролем приложения или кнопкой почтовика (#4893), разбор правилами. */
@Module({
  controllers: [MailboxController],
  providers: [MailboxService, MailOAuthService, MailboxRepository, MailboxScheduler, IntegrationCryptoService],
  exports: [MailboxService],
})
export class MailboxModule {}

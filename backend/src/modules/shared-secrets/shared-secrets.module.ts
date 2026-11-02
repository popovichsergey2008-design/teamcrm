import { Global, Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { SharedSecretsService } from './shared-secrets.service';

/** Реестр общих ключей платформы (§5.6): консоль владельца управляет, остальные читают sharedSecret(). */
@Global()
@Module({
  providers: [SharedSecretsService, IntegrationCryptoService],
  exports: [SharedSecretsService],
})
export class SharedSecretsModule {}

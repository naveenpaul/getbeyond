import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { CredentialManager } from './credential-manager';
import { CsvImportController } from './csv-import.controller';
import { CsvImportWorker } from './csv-import.worker';
import { HubspotOauthController } from './hubspot-oauth.controller';

@Module({
  imports: [PrismaModule, QueueModule, StorageModule],
  controllers: [CsvImportController, HubspotOauthController],
  providers: [CsvImportWorker, CredentialManager],
  exports: [CredentialManager],
})
export class ConnectorsModule {}

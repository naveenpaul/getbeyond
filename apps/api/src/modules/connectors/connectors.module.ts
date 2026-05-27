import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { CredentialManager } from './credential-manager';
import { CsvImportController } from './csv-import.controller';
import { CsvImportWorker } from './csv-import.worker';
import { HubspotOauthController } from './hubspot-oauth.controller';
import { HubspotSyncController } from './hubspot-sync.controller';
import { HubspotSyncWorker } from './hubspot-sync.worker';

@Module({
  imports: [PrismaModule, QueueModule, StorageModule, AuthModule],
  controllers: [
    CsvImportController,
    HubspotOauthController,
    HubspotSyncController,
  ],
  providers: [CsvImportWorker, CredentialManager, HubspotSyncWorker],
  exports: [CredentialManager],
})
export class ConnectorsModule {}

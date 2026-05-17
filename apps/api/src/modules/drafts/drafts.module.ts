import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { DestinationRegistry } from './destination-registry';
import { DraftActionWorker } from './draft-action.worker';

@Module({
  imports: [PrismaModule, QueueModule],
  providers: [DestinationRegistry, DraftActionWorker],
  exports: [DestinationRegistry],
})
export class DraftsModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ContactsController } from './contacts.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ContactsController],
})
export class ContactsModule {}

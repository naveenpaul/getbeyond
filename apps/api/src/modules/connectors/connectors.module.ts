import { Module } from '@nestjs/common';
import { CsvImportController } from './csv-import.controller';

@Module({
  controllers: [CsvImportController],
})
export class ConnectorsModule {}

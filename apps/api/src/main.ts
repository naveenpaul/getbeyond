import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';

// CSV import file-size cap (T8-CSV.2c.3 + Issue 2D from the eng review).
// At ~150 bytes/row this allows ~330k rows per upload, comfortably above the
// "50k typical solo-founder lead list" target. Files at or below 1 MB ride
// inline in the pg-boss payload; files above 1 MB spill to MinIO/S3 and the
// payload carries the storage key instead of inline bytes.
const CSV_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: process.env.NODE_ENV !== 'production' }),
  );

  await app.register(multipart, {
    limits: {
      fileSize: CSV_UPLOAD_MAX_BYTES,
      files: 1,
      fields: 4, // metadata + a few buffer fields
    },
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();

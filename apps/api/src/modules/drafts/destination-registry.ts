import { Inject, Injectable } from '@nestjs/common';
import type { DestinationAdapter, DraftActionKind } from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ArchiveDestination } from './destinations/archive.destination';
import { EchoDestination } from './destinations/echo.destination';

/**
 * DraftActionKind → DestinationAdapter map.
 *
 * Each adapter declares which kinds it `supports`; the registry consults
 * `supports[]` at construction time and builds a lookup. Multiple adapters
 * can claim the same kind — only one wins (last registered). In v1 each
 * kind has exactly one production adapter, so the conflict question doesn't
 * actually arise.
 */
@Injectable()
export class DestinationRegistry {
  private readonly map = new Map<DraftActionKind, DestinationAdapter<unknown>>();
  private readonly prisma: PrismaService;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall".
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    this.installDefaults();
  }

  /**
   * Wire built-in destinations. Today: ArchiveDestination (real) +
   * EchoDestination (test-only stub for every other kind).
   *
   * Once real adapters land (Gmail, Resend, HubSpot dest, etc.), they
   * register here in place of EchoDestination's claim on their kind.
   */
  private installDefaults(): void {
    this.register(new ArchiveDestination(this.prisma));
    if (process.env.NODE_ENV !== 'production') {
      this.register(new EchoDestination());
    }
  }

  register<T>(adapter: DestinationAdapter<T>): void {
    for (const kind of adapter.supports) {
      this.map.set(kind, adapter as DestinationAdapter<unknown>);
    }
  }

  getForKind(kind: DraftActionKind): DestinationAdapter<unknown> | undefined {
    return this.map.get(kind);
  }

  /** Adapter is registered for this kind. */
  has(kind: DraftActionKind): boolean {
    return this.map.has(kind);
  }
}

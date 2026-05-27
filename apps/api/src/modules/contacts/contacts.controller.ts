import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { InvalidEmailError, normalizeEmail } from './identity';

/**
 * Read-only contacts surface (T9.8).
 *
 * For v1 the only endpoint is /contacts/lookup — the SDR Drafter form needs
 * to translate a user-entered email into a Contact.id. Full contacts list /
 * detail pages land later.
 */
export interface ContactLookupResponse {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
}

@Controller('contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Get('lookup')
  async lookup(
    @Query('email') email: string | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ContactLookupResponse> {
    if (!email || email.trim().length === 0) {
      throw new BadRequestException('email query parameter is required');
    }
    let normalized: string;
    try {
      normalized = normalizeEmail(email.trim());
    } catch (err) {
      if (err instanceof InvalidEmailError) {
        throw new BadRequestException(
          `email is not a valid address (${err.reason})`,
        );
      }
      throw err;
    }
    const contact = await this.prisma.contact.findFirst({
      where: { orgId: user.orgId, normalizedEmail: normalized },
    });
    if (!contact) {
      throw new NotFoundException(
        `No contact in your org matches ${email.trim()}`,
      );
    }
    return {
      id: contact.id,
      primaryEmail: contact.normalizedEmail,
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      company: contact.company,
    };
  }
}

import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';

/**
 * `get_contact` — load a Contact row for the SDR Drafter (and any future
 * teammate that needs prospect context).
 *
 * Internal data: the contact's fields came from the user's own CRM/CSV
 * imports. We do NOT create a Citation row for this — the trust positioning
 * is about external claims (research findings) needing sources. Contact
 * attributes (name, title, email) are rendered verbatim in drafts, not
 * cited.
 *
 * Tenant-scoped via ctx.orgId: the lookup is `findFirst where { id, orgId }`
 * so a model that hallucinates a contactId from another org cannot read
 * across the boundary.
 */
const GetContactArgsSchema = z.object({
  contactId: z.string().min(1),
});

interface GetContactResult {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
}

export const getContactTool: AgentTool = {
  name: 'get_contact',
  description:
    'Load contact details (name, title, company, primary email) for a ' +
    'specific contactId. Returns the structured profile so you can write a ' +
    "personalized email. Don't cite these fields — they're rendered verbatim.",
  inputSchema: {
    type: 'object',
    required: ['contactId'],
    properties: {
      contactId: {
        type: 'string',
        description: 'The Contact.id from your run input.',
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<GetContactResult> {
    const { contactId } = GetContactArgsSchema.parse(args);
    const contact = await ctx.prisma.contact.findFirst({
      where: { id: contactId, orgId: ctx.orgId },
    });
    if (!contact) {
      throw new Error(`Contact ${contactId} not found in this org`);
    }
    return {
      id: contact.id,
      primaryEmail: contact.normalizedEmail,
      firstName: contact.firstName,
      lastName: contact.lastName,
      displayName:
        [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
        contact.normalizedEmail ||
        contact.id,
      title: contact.title,
      company: contact.company,
      linkedinUrl: contact.linkedinUrl,
    };
  },
};

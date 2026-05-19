/**
 * Public env config (T5.3).
 *
 * Only NEXT_PUBLIC_* vars are accessible from browser code. They get baked
 * in at build time, so each value lives here once with explicit fallbacks.
 * Missing values throw at module load so we fail fast on misconfiguration
 * rather than at the first API call.
 */

function readPublic(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `${name} is not set. Copy apps/web/.env.example to .env.local and fill it in.`,
  );
}

export const env = {
  apiUrl: readPublic('NEXT_PUBLIC_API_URL', 'http://localhost:3000'),
  devOrgId: readPublic('NEXT_PUBLIC_DEV_ORG_ID'),
  devUserId: readPublic('NEXT_PUBLIC_DEV_USER_ID', 'usr_dev'),
};

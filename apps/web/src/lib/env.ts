/**
 * Public env config.
 *
 * Only NEXT_PUBLIC_* vars are accessible from browser code. They get baked
 * in at build time.
 */

function readPublic(name: string, fallback: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  return fallback;
}

export const env = {
  apiUrl: readPublic('NEXT_PUBLIC_API_URL', 'http://localhost:3000'),
};

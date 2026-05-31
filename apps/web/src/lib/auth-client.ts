'use client';

import { createAuthClient } from 'better-auth/react';
import { env } from './env';

/**
 * better-auth client (T6.3).
 *
 * Browser-side counterpart to the server `betterAuth` instance. Exposes:
 *   - signUp.email({ email, password, name }) — create an account
 *   - signIn.email({ email, password }) — sign in
 *   - signOut()
 *   - useSession() — React hook returning { data, isPending, error }
 *
 * Email + password is the default UI path: it has no email-transport
 * dependency, so it works on a bare self-host install. The magic-link
 * server plugin stays enabled (see auth.config.ts) for deployments that
 * have wired an email provider; the UI just doesn't surface it yet.
 *
 * The base URL must point at the API's better-auth mount (default
 * /api/auth on the same origin). Direct cross-origin auth requires
 * `credentials: 'include'` on every request — the client handles this.
 */
export const authClient = createAuthClient({
  baseURL: `${env.apiUrl}/api/auth`,
});

export const { signUp, signIn, signOut, useSession } = authClient;

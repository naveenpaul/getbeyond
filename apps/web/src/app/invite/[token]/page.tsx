'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  acceptInvite,
  ApiError,
  type InviteLookupResponse,
  lookupInvite,
  switchActiveOrg,
} from '@/lib/api-client';
import { signIn, signUp, useSession } from '@/lib/auth-client';

/**
 * Invite landing.
 *
 *   1. Fetch the invite metadata (public endpoint).
 *   2. If signed in with matching email → "Accept" button → POST accept
 *      → flip active org → land on /research/new.
 *   3. If signed in with a different email → tell the user to sign out
 *      and try again with the invited address.
 *   4. If signed out → email+password form, email locked to the invited
 *      address. New invitees create an account, returning users sign in.
 *      The user.create hook detours new accounts straight into the inviting
 *      org; autoSignIn refreshes the page into the signed-in branch so the
 *      user can click Accept (or lands already-attached).
 *
 * Expired / revoked / accepted invites show terminal messages with no CTA.
 */
export default function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): React.JSX.Element {
  const { token } = use(params);
  const session = useSession();

  const [invite, setInvite] = useState<InviteLookupResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await lookupInvite(token);
        if (!cancelled) setInvite(result);
      } catch (err) {
        if (cancelled) return;
        setLookupError(
          err instanceof ApiError
            ? err.status === 404
              ? 'This invite link is not valid.'
              : `${err.status} — ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="container flex min-h-screen items-center justify-center py-12">
      <Card className="w-full max-w-md">
        {lookupError ? (
          <Terminal title="Invite unavailable" message={lookupError} />
        ) : !invite || session.isPending ? (
          <Loading />
        ) : invite.status !== 'pending' ? (
          <Terminal
            title={
              invite.status === 'accepted'
                ? 'Already accepted'
                : invite.status === 'expired'
                  ? 'Invite expired'
                  : 'Invite revoked'
            }
            message={
              invite.status === 'accepted'
                ? 'This invite has already been accepted. Sign in to access the org.'
                : invite.status === 'expired'
                  ? 'This invite has expired. Ask the admin to send a new one.'
                  : 'This invite has been revoked.'
            }
          />
        ) : session.data ? (
          <AcceptPanel
            token={token}
            invite={invite}
            sessionEmail={
              (session.data.user as { email?: string }).email ?? ''
            }
          />
        ) : (
          <SignInToAcceptPanel invite={invite} token={token} />
        )}
      </Card>
    </main>
  );
}

function Loading(): React.JSX.Element {
  return (
    <CardContent className="flex items-center justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </CardContent>
  );
}

function Terminal({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.JSX.Element {
  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </>
  );
}

function AcceptPanel({
  token,
  invite,
  sessionEmail,
}: {
  token: string;
  invite: InviteLookupResponse;
  sessionEmail: string;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailMatches =
    sessionEmail.toLowerCase() === invite.invitedEmail.toLowerCase();

  async function onAccept(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { orgId } = await acceptInvite(token);
      await switchActiveOrg(orgId);
      router.replace('/research/new');
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof ApiError
          ? `${err.status} — ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : 'Unknown error',
      );
    }
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Join {invite.orgName ?? 'this organization'}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as <strong>{invite.role}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!emailMatches ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            This invite is for <strong>{invite.invitedEmail}</strong> but
            you&apos;re signed in as <strong>{sessionEmail}</strong>. Sign out
            and sign in with the invited address.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Button
          className="w-full"
          onClick={onAccept}
          disabled={submitting || !emailMatches}
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" /> Accepting…
            </>
          ) : (
            <>Accept invite</>
          )}
        </Button>
      </CardContent>
    </>
  );
}

function SignInToAcceptPanel({
  invite,
  token,
}: {
  invite: InviteLookupResponse;
  token: string;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-up');
  const [error, setError] = useState<string | null>(null);
  const isSignUp = mode === 'sign-up';

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || password.length < 8) return;
    setSubmitting(true);
    setError(null);
    try {
      // Email is locked to the invite. The user.create hook attaches new
      // accounts straight into the inviting org; autoSignIn then leaves us
      // authenticated, so we refresh into the signed-in (Accept) branch.
      const { error: authError } = isSignUp
        ? await signUp.email({
            email: invite.invitedEmail,
            password,
            name: invite.invitedEmail.split('@')[0] || invite.invitedEmail,
          })
        : await signIn.email({ email: invite.invitedEmail, password });
      if (authError) {
        setError(
          authError.message ??
            (isSignUp
              ? 'Could not create account'
              : 'Invalid email or password'),
        );
        setSubmitting(false);
        return;
      }
      void token;
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Join {invite.orgName ?? 'this organization'}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as <strong>{invite.role}</strong>.
          {isSignUp
            ? ' Set a password to create your account and join.'
            : ' Sign in to accept.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label htmlFor="invite-email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="invite-email"
              type="email"
              readOnly
              value={invite.invitedEmail}
              aria-readonly
              autoComplete="email"
            />
            <p className="text-xs text-muted-foreground">
              The invite is locked to this address.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="invite-password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="invite-password"
              type="password"
              required
              minLength={8}
              autoFocus
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              placeholder={
                isSignUp ? 'At least 8 characters' : 'Your password'
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || password.length < 8}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />{' '}
                {isSignUp ? 'Creating account…' : 'Signing in…'}
              </>
            ) : isSignUp ? (
              'Create account & join'
            ) : (
              'Sign in & join'
            )}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isSignUp ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === 'sign-up' ? 'sign-in' : 'sign-up'));
              setError(null);
            }}
            disabled={submitting}
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline disabled:opacity-50"
          >
            {isSignUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </CardContent>
    </>
  );
}

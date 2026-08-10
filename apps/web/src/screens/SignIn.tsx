/**
 * Sign-in screen (spec §5.2 Authentication). Form skeleton only — no
 * submission wiring beyond preventDefault; username-login flows land with
 * the auth work (spec §14.1).
 */
export function SignIn() {
  const { session, profile, loading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && session !== null) {
    return <Navigate to={profile?.mustChangePassword ? '/activate' : '/dashboard'} replace />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await signInWithUsername(
        String(form.get('username') ?? ''),
        String(form.get('password') ?? ''),
      );
      const from = (location.state as { from?: string } | null)?.from;
      navigate(result.mustChangePassword ? '/activate' : from ?? '/dashboard', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-screen">
      <div className="auth-mark" aria-hidden="true">GT</div>
      <div className="auth-copy">
        <h1>Ready for the first tee?</h1>
        <p>Use the username and temporary password from your league organizer.</p>
      </div>
      <form className="form-stack auth-form" onSubmit={(event) => void submit(event)}>
        {error && <p className="form-message form-message--error" role="alert">{error}</p>}
        <div className="field">
          <label htmlFor="sign-in-username">Username</label>
          <input
            id="sign-in-username"
            name="username"
            type="text"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="sign-in-password">Password</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button className="button button--primary button--full" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-help">No email address is required. Ask your organizer if you need access.</p>
    </section>
  );
}
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { signInWithUsername } from '../lib/auth.ts';
import { useSession } from '../lib/session.tsx';

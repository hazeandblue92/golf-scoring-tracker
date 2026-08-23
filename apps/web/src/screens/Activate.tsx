/**
 * Account activation screen (spec §5.2 Authentication, §14.1): forced
 * password change and privacy acknowledgment for newly provisioned accounts.
 */
export function Activate() {
  const { refreshProfile } = useSession();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');
    const privacyAccepted = form.get('privacyAccepted') === 'yes';
    if (password !== confirmation) {
      setError('The passphrases do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completeActivation(password, privacyAccepted);
      await refreshProfile();
      navigate('/dashboard', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Activation failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="narrow-screen">
      <header className="page-header">
        <h1>Secure this device</h1>
        <p>Replace your temporary password before viewing or entering scores.</p>
      </header>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {error && <p className="form-message form-message--error" role="alert">{error}</p>}
        <div className="field">
          <label htmlFor="new-password">New passphrase</label>
          <input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          <small>Use at least 12 characters.</small>
        </div>
        <div className="field">
          <label htmlFor="confirm-password">Confirm passphrase</label>
          <input id="confirm-password" name="confirmation" type="password" autoComplete="new-password" minLength={12} required />
        </div>
        <label className="check-row">
          <input type="checkbox" name="privacyAccepted" value="yes" required />
          <span>I have read the <Link to="/privacy" target="_blank">privacy notice</Link>.</span>
        </label>
        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Activating…' : 'Activate account'}
        </button>
      </form>
    </section>
  );
}
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { completeActivation } from '../lib/auth.ts';
import { useSession } from '../lib/session.tsx';

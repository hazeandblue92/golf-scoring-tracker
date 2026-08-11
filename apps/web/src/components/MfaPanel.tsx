import { useEffect, useState } from 'react';

import { getSupabaseClient } from '../lib/supabase.ts';

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

interface MfaStatus {
  currentLevel: string | null;
  factorId: string | null;
}

export function MfaPanel() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const supabase = getSupabaseClient();
    const [levels, factors] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    if (levels.error) throw levels.error;
    if (factors.error) throw factors.error;
    setStatus({
      currentLevel: levels.data.currentLevel,
      factorId: factors.data.totp[0]?.id ?? null,
    });
  }

  useEffect(() => {
    void refresh().catch(() => setError('Authenticator status is unavailable. Try again.'));
  }, []);

  async function beginEnrollment() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const { data, error: enrollError } = await getSupabaseClient().auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Golf Tracker authenticator',
      });
      if (enrollError) throw enrollError;
      setEnrollment({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setMessage('Scan the QR code, then enter the six-digit code to finish enrollment.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authenticator enrollment failed.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    const factorId = enrollment?.factorId ?? status?.factorId;
    if (!factorId || !/^\d{6}$/.test(code)) {
      setError('Enter the six-digit code from your authenticator app.');
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const { error: verifyError } = await getSupabaseClient().auth.mfa
        .challengeAndVerify({ factorId, code });
      if (verifyError) throw verifyError;
      setEnrollment(null);
      setCode('');
      await refresh();
      setMessage('Authenticator verified. Privileged actions are unlocked for this session.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  const verified = status?.currentLevel === 'aal2';
  const enrolled = status !== null && status.factorId !== null;

  return <section className="settings-section" aria-labelledby="account-security-heading">
    <div className="section-heading">
      <div>
        <h2 id="account-security-heading">Account security</h2>
        <p>Organizers must verify a time-based authenticator before sensitive setup, roster, publication, finalization, export, or account changes.</p>
      </div>
      <span className={verified ? 'state-success' : enrolled ? 'state-warning' : undefined}>
        {verified ? 'Verified' : enrolled ? 'Challenge required' : 'Not enrolled'}
      </span>
    </div>
    {error && <p className="form-message form-message--error" role="alert">{error}</p>}
    {message && <p className="form-message form-message--success" role="status">{message}</p>}
    {enrollment && <div className="mfa-enrollment">
      <img src={enrollment.qrCode} alt="QR code for Golf Tracker authenticator enrollment" width="192" height="192" />
      <div>
        <p>Cannot scan? Enter this setup key manually:</p>
        <code>{enrollment.secret}</code>
      </div>
    </div>}
    {!enrolled && !enrollment && <button className="button button--secondary" type="button" disabled={busy} onClick={() => void beginEnrollment()}>{busy ? 'Starting…' : 'Enroll authenticator'}</button>}
    {(enrolled || enrollment) && !verified && <div className="mfa-challenge">
      <label className="field" htmlFor="mfa-code"><span>Six-digit authenticator code</span><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(change) => setCode(change.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
      <button className="button button--primary" type="button" disabled={busy || code.length !== 6} onClick={() => void verify()}>{busy ? 'Verifying…' : enrollment ? 'Finish enrollment' : 'Verify this session'}</button>
    </div>}
    {verified && <p className="empty-inline">This session has completed multi-factor verification.</p>}
  </section>;
}

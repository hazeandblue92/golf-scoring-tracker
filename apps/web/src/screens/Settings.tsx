import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { signOut } from '../lib/auth.ts';
import { useSession } from '../lib/session.tsx';

export function Settings() {
  const { profile } = useSession(); const navigate = useNavigate(); const [message, setMessage] = useState<string | null>(null);
  async function leave(discardUnsynced = false) { const result = await signOut({ discardUnsynced }); if (result.status === 'blocked') { const confirm = window.confirm(`${result.unsyncedCount} score${result.unsyncedCount === 1 ? '' : 's'} have not synced. Sign out and discard local data?`); if (confirm) await leave(true); return; } navigate('/sign-in', { replace: true }); }
  return <div className="screen narrow-screen"><header className="page-header"><h1>More</h1><p>Account, league tools, and offline data.</p></header>{message && <p className="form-message">{message}</p>}<section className="settings-section"><h2>Account</h2><dl className="fact-list"><dt>Signed in as</dt><dd>{profile?.displayName ?? 'Player'}</dd><dt>Session</dt><dd>Stored on this device</dd></dl><button className="button button--secondary" type="button" onClick={() => void leave()}>Sign out</button></section><nav className="settings-links"><Link to="/offline"><strong>Offline and sync</strong><span>Local events and unsynced scores</span></Link><Link to="/admin/operations"><strong>Operations</strong><span>Health, export, and recovery</span></Link><Link to="/privacy"><strong>Privacy notice</strong><span>What is stored and why</span></Link></nav><section className="settings-section"><h2>App update</h2><p>Updates never reload during score entry. Finish the hole, then refresh when prompted.</p><button className="button button--quiet" type="button" onClick={() => { window.location.reload(); setMessage('Checking for an update…'); }}>Check now</button></section></div>;
}

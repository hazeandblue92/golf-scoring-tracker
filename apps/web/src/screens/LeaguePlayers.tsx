import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { invokePhase1, saveCatalogItem } from '../lib/phase1.ts';
import { initials } from '../lib/row-display.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function LeaguePlayers() {
  const { leagueId = '' } = useParams();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['players', leagueId], queryFn: async () => {
    const supabase = getSupabaseClient();
    const { data: players, error } = await supabase.from('participants').select('id,display_name,status,profile_id').eq('league_id', leagueId).order('sort_name');
    if (error) throw error;
    const ids = (players ?? []).map((player) => player.id);
    const { data: handicaps } = ids.length ? await supabase.from('participant_handicaps').select('participant_id,value,source,effective_from').in('participant_id', ids).order('effective_from', { ascending: false }) : { data: [] };
    const current = new Map<string, number>();
    for (const handicap of handicaps ?? []) if (!current.has(handicap.participant_id)) current.set(handicap.participant_id, handicap.value);
    return (players ?? []).map((player) => ({ ...player, handicap: current.get(player.id) }));
  }});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get('displayName'));
    const username = String(form.get('username') ?? '').trim();
    try {
      let profileId: string | null = null;
      let temporaryPassword: string | null = null;
      if (username) {
        const account = await invokePhase1<{ profileId: string; temporaryPassword: string }>('account-admin', { action: 'create', username, displayName });
        profileId = account.profileId; temporaryPassword = account.temporaryPassword;
      }
      await saveCatalogItem({ action: 'save-participant', leagueId, displayName, profileId, handicapValue: Number(form.get('handicapValue')) });
      setMessage(temporaryPassword ? `Player added. Temporary password (shown once): ${temporaryPassword}` : 'Guest player added to the roster.');
      event.currentTarget.reset(); await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add player.'); }
    finally { setBusy(false); }
  }

  return <div className="screen catalog-screen"><header className="page-header"><Link className="back-link" to={`/league/${leagueId}`}>Back to league</Link><h1>Players</h1><p>League roster and verified handicap values.</p></header>{error && <p className="form-message form-message--error" role="alert">{error}</p>}{message && <p className="form-message form-message--success" role="status">{message}</p>}<div className="catalog-layout"><section><div className="section-heading"><h2>Roster</h2><span>{query.data?.length ?? 0}</span></div><div className="directory-list">{query.isLoading ? <div className="skeleton skeleton--rows" /> : query.data?.map((player) => <div key={player.id}><span className="initials">{initials(player.display_name)}</span><div><strong>{player.display_name}</strong><small>{player.profile_id ? 'Account linked' : 'Guest player'}</small></div><span className="handicap-value">{formatHandicap(player.handicap)}</span></div>)}</div></section><section className="catalog-form"><h2>Add a player</h2><form className="form-stack" onSubmit={(event) => void submit(event)}><div className="field"><label htmlFor="player-name">Display name</label><input id="player-name" name="displayName" required /></div><div className="field"><label htmlFor="handicap">Verified handicap index</label><input id="handicap" name="handicapValue" type="number" min="-10" max="54" step="0.1" defaultValue="0" required /><small>Plus handicaps use a negative value, such as −1.2.</small></div><div className="field"><label htmlFor="username">Username (optional)</label><input id="username" name="username" pattern="[a-z0-9._-]{3,32}" autoCapitalize="none" /><small>Leave blank for a guest without sign-in access.</small></div><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add player'}</button></form></section></div></div>;
}

function formatHandicap(value?: number) { if (value === undefined) return '—'; return value < 0 ? `+${Math.abs(value).toFixed(1)}` : value.toFixed(1); }

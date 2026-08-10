import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { saveCatalogItem } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function LeagueSeasons() {
  const { leagueId = '' } = useParams();
  const [status, setStatus] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['seasons', leagueId], queryFn: async () => { const { data, error } = await getSupabaseClient().from('seasons').select('id,name,starts_on,ends_on,status').eq('league_id', leagueId).order('starts_on', { ascending: false }); if (error) throw error; return data ?? []; } });
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await saveCatalogItem({ action: 'save-season', leagueId, name: form.get('name'), startsOn: form.get('startsOn'), endsOn: form.get('endsOn') }); setStatus('Season added.'); event.currentTarget.reset(); await query.refetch(); } catch (cause) { setStatus(cause instanceof Error ? cause.message : 'Could not add season.'); } }
  return <div className="screen catalog-screen"><header className="page-header"><Link className="back-link" to={`/league/${leagueId}`}>Back to league</Link><h1>Seasons</h1><p>Organize events into dated league seasons.</p></header>{status && <p className="form-message" role="status">{status}</p>}<div className="catalog-layout"><section><div className="section-heading"><h2>All seasons</h2><span>{query.data?.length ?? 0}</span></div><div className="season-list">{query.data?.map((season) => <div key={season.id}><div><strong>{season.name}</strong><span className="status-badge">{season.status}</span></div><span>{formatDate(season.starts_on)} – {formatDate(season.ends_on)}</span></div>)}</div></section><section className="catalog-form"><h2>Add season</h2><form className="form-stack" onSubmit={(event) => void submit(event)}><div className="field"><label htmlFor="season-name">Name</label><input id="season-name" name="name" required /></div><div className="field"><label htmlFor="season-start">Starts</label><input id="season-start" name="startsOn" type="date" required /></div><div className="field"><label htmlFor="season-end">Ends</label><input id="season-end" name="endsOn" type="date" required /></div><button className="button button--primary" type="submit">Add season</button></form></section></div></div>;
}
function formatDate(date: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)); }

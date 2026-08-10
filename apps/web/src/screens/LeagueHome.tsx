import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';

export function LeagueHome() {
  const { leagueId = '' } = useParams();
  const query = useQuery({ queryKey: ['league', leagueId], queryFn: async () => { const supabase = getSupabaseClient(); const [{ data: league, error }, { count: players }, { count: courses }, { count: seasons }] = await Promise.all([supabase.from('leagues').select('id,name,timezone').eq('id', leagueId).single(), supabase.from('participants').select('id', { count: 'exact', head: true }).eq('league_id', leagueId).eq('status', 'active'), supabase.from('courses').select('id', { count: 'exact', head: true }).eq('league_id', leagueId).eq('status', 'active'), supabase.from('seasons').select('id', { count: 'exact', head: true }).eq('league_id', leagueId)]); if (error) throw error; return { league, players, courses, seasons }; } });
  if (!query.data) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  return <div className="screen league-screen"><header className="page-header"><Link className="back-link" to="/dashboard">Back to dashboard</Link><h1>{query.data.league.name}</h1><p>{query.data.league.timezone} · League administration</p></header><nav className="league-directory" aria-label="League sections"><Link to={`/league/${leagueId}/players`}><div><strong>Players</strong><span>Roster, accounts, and handicaps</span></div><b>{query.data.players ?? 0}</b></Link><Link to={`/league/${leagueId}/courses`}><div><strong>Courses</strong><span>Layouts, tees, ratings, and hole data</span></div><b>{query.data.courses ?? 0}</b></Link><Link to={`/league/${leagueId}/seasons`}><div><strong>Seasons</strong><span>Dated event groupings</span></div><b>{query.data.seasons ?? 0}</b></Link></nav><div className="action-row"><Link className="button button--primary" to="/admin/events/new/setup">Create event</Link><Link className="button button--quiet" to="/admin/operations">Operations</Link></div></div>;
}

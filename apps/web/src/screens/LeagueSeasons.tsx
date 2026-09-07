/**
 * League seasons (spec §4.2: "Create seasons with start/end dates and status
 * (draft, active, closed, archived)").
 *
 * A season could be created but never moved, so every season stayed 'planned'
 * for ever and the status badge was decoration. The lifecycle is the point:
 * it is how an organizer says which season the league is actually playing, and
 * archiving one is how last year stops appearing in this year's pickers.
 *
 * Renaming a season leaves its status alone. The save path used to send
 * `status: 'planned'` unconditionally, so correcting a typo in an active
 * season's name silently reset it.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { saveCatalogItem } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

interface Season {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: string;
}

/** planned -> active -> completed -> archived, plus a way back from a slip. */
const NEXT_STATUS: Record<string, { status: string; label: string; note: string } | undefined> = {
  planned: {
    status: 'active',
    label: 'Start season',
    note: 'Events in this season become the league’s current play.',
  },
  active: {
    status: 'completed',
    label: 'Close season',
    note: 'Results stand as they are; new events should go to the next season.',
  },
  completed: {
    status: 'archived',
    label: 'Archive season',
    note: 'It stays readable and exportable, out of the way of the current season.',
  },
};

export function LeagueSeasons() {
  const { leagueId = '' } = useParams();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: async (): Promise<Season[]> => {
      const { data, error: queryError } = await getSupabaseClient()
        .from('seasons')
        .select('id,name,starts_on,ends_on,status')
        .eq('league_id', leagueId)
        .order('starts_on', { ascending: false });
      if (queryError) throw queryError;
      return data ?? [];
    },
  });

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await work());
      await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The season could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function addSeason(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const element = event.currentTarget;
    await run(async () => {
      await saveCatalogItem({
        action: 'save-season',
        leagueId,
        name: form.get('name'),
        startsOn: form.get('startsOn'),
        endsOn: form.get('endsOn'),
      });
      element.reset();
      return 'Season added.';
    });
  }

  async function advance(season: Season): Promise<void> {
    const next = NEXT_STATUS[season.status];
    if (!next) return;
    setConfirmingId(null);
    await run(async () => {
      await saveCatalogItem({
        action: 'save-season',
        leagueId,
        id: season.id,
        name: season.name,
        startsOn: season.starts_on,
        endsOn: season.ends_on,
        status: next.status,
      });
      return `${season.name} is now ${next.status}.`;
    });
  }

  return (
    <div className="screen catalog-screen">
      <header className="page-header">
        <Link className="back-link" to={`/league/${leagueId}`}>Back to league</Link>
        <h1>Seasons</h1>
        <p>Organize events into dated league seasons.</p>
      </header>

      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {status && <p className="form-message form-message--success" role="status">{status}</p>}

      <div className="catalog-layout">
        <section>
          <div className="section-heading">
            <h2>All seasons</h2>
            <span>{query.data?.length ?? 0}</span>
          </div>
          <div className="season-list">
            {query.data?.map((season) => {
              const next = NEXT_STATUS[season.status];
              return (
                <div key={season.id}>
                  <div>
                    <strong>{season.name}</strong>
                    <span className="status-badge">{season.status}</span>
                  </div>
                  <span>{formatDate(season.starts_on)} – {formatDate(season.ends_on)}</span>
                  {next && (
                    confirmingId === season.id ? (
                      <div className="action-row" role="group" aria-label={`Confirm status change for ${season.name}`}>
                        <p className="form-message" role="status">
                          {next.label} for {season.name}? {next.note}
                        </p>
                        <button className="button button--quiet" type="button" onClick={() => setConfirmingId(null)}>
                          Cancel
                        </button>
                        <button
                          className="button button--primary"
                          type="button"
                          disabled={busy}
                          onClick={() => void advance(season)}
                        >
                          {busy ? 'Working…' : next.label}
                        </button>
                      </div>
                    ) : (
                      <div className="action-row">
                        <button
                          className="button button--quiet button--small"
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingId(season.id)}
                        >
                          {next.label}
                        </button>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="catalog-form">
          <h2>Add season</h2>
          <form className="form-stack" onSubmit={(event) => void addSeason(event)}>
            <div className="field">
              <label htmlFor="season-name">Name</label>
              <input id="season-name" name="name" required />
            </div>
            <div className="field">
              <label htmlFor="season-start">Starts</label>
              <input id="season-start" name="startsOn" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="season-end">Ends</label>
              <input id="season-end" name="endsOn" type="date" required />
            </div>
            <button className="button button--primary" type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add season'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

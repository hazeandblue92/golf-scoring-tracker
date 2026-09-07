/**
 * League roster (spec §4.2).
 *
 * Everything an organizer needs to run a season without a developer: add and
 * edit players, revise handicaps with an effective date and source, take a
 * player out of the rotation without deleting their history, administer sign-in
 * accounts, and move a whole roster in or out as CSV.
 *
 * Two rules shape the screen:
 *
 * - **A handicap is history, not a field.** Saving a new value never edits the
 *   old one; it closes that interval and opens the next (migration 39), because
 *   a frozen event snapshot cites the value effective on its own date (§6.2).
 *   The form therefore asks for an effective date and a source, not just a
 *   number.
 *
 * - **An import is previewed before it is applied.** The organizer sees the
 *   row-by-row report §4.2 requires — what will be created, what updated, and
 *   every problem with its row and column — and only then confirms. Both passes
 *   run the same server-side validation over the same text, so the preview and
 *   the write cannot disagree.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import {
  HANDICAP_SOURCES,
  PARTICIPANT_CSV_TEMPLATE,
  toCsv,
  type CsvIssue,
  type HandicapSource,
} from '@gtt/contracts';

import { invokePhase1, saveCatalogItem } from '../lib/phase1.ts';
import { initials } from '../lib/row-display.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

interface RosterPlayer {
  id: string;
  display_name: string;
  status: string;
  profile_id: string | null;
  handicap?: number;
  handicapFrom?: string;
  handicapSource?: string;
  username?: string;
  accountStatus?: string;
}

interface ImportPlanRow {
  displayName: string;
  action: 'create' | 'update';
  handicap: number | null;
  status: string;
  account: string;
}

interface ImportResponse {
  status: string;
  applied: number;
  rowsRead: number;
  ok: boolean;
  issues: CsvIssue[];
  plan: ImportPlanRow[];
}

const SOURCE_LABELS: Record<HandicapSource, string> = {
  manual_verified: 'Manual, verified',
  authorized_import: 'Authorized import',
  league_value: 'League value',
  scratch_fallback: 'Scratch',
  none: 'None',
};

const ACCOUNT_NOTES: Record<string, string> = {
  linked: 'Account linked',
  no_account: 'Guest, no account',
  unknown_username: 'Username not found — imported as a guest',
};

function formatHandicap(value?: number): string {
  if (value === undefined) return '—';
  return value < 0 ? `+${Math.abs(value).toFixed(1)}` : value.toFixed(1);
}

export function LeaguePlayers() {
  const { leagueId = '' } = useParams();
  const [message, setMessage] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: 'disable' | 'reset' } | null>(null);
  const [csvText, setCsvText] = useState('');
  const [report, setReport] = useState<ImportResponse | null>(null);

  const query = useQuery({
    queryKey: ['players', leagueId],
    queryFn: async (): Promise<RosterPlayer[]> => {
      const supabase = getSupabaseClient();
      const { data: players, error: rosterError } = await supabase
        .from('participants')
        .select('id,display_name,status,profile_id')
        .eq('league_id', leagueId)
        .order('sort_name');
      if (rosterError) throw rosterError;
      const ids = (players ?? []).map((player) => player.id);
      const profileIds = (players ?? [])
        .map((player) => player.profile_id)
        .filter((id): id is string => id !== null);

      const [{ data: handicaps }, { data: profiles }] = await Promise.all([
        ids.length
          ? supabase
              .from('participant_handicaps')
              .select('participant_id,value,source,effective_from,effective_to')
              .in('participant_id', ids)
              .order('effective_from', { ascending: false })
          : Promise.resolve({ data: [] }),
        profileIds.length
          ? supabase.from('profiles').select('id,username,status').in('id', profileIds)
          : Promise.resolve({ data: [] }),
      ]);

      // The current value is the interval covering today: the newest row whose
      // effective_to is still open. A future-dated revision is not yet in play.
      const today = new Date().toISOString().slice(0, 10);
      const current = new Map<string, { value: number; from: string; source: string }>();
      for (const row of handicaps ?? []) {
        if (row.effective_from > today) continue;
        if (row.effective_to !== null && row.effective_to <= today) continue;
        if (!current.has(row.participant_id)) {
          current.set(row.participant_id, {
            value: Number(row.value),
            from: row.effective_from,
            source: row.source,
          });
        }
      }
      const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

      return (players ?? []).map((player) => {
        const handicap = current.get(player.id);
        const profile = player.profile_id ? profileById.get(player.profile_id) : undefined;
        return {
          ...player,
          ...(handicap ? { handicap: handicap.value, handicapFrom: handicap.from, handicapSource: handicap.source } : {}),
          ...(profile ? { username: profile.username as string, accountStatus: profile.status as string } : {}),
        };
      });
    },
  });

  function announce(text: string): void {
    setError(null);
    setMessage(text);
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
      await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function addPlayer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const element = event.currentTarget;
    const displayName = String(form.get('displayName'));
    const username = String(form.get('username') ?? '').trim();
    const handicapValue = String(form.get('handicapValue') ?? '').trim();
    await run(async () => {
      let profileId: string | null = null;
      let temporaryPassword: string | null = null;
      if (username) {
        const account = await invokePhase1<{ profileId: string; temporaryPassword: string }>(
          'account-admin',
          { action: 'create', username, displayName },
        );
        profileId = account.profileId;
        temporaryPassword = account.temporaryPassword;
      }
      await saveCatalogItem({
        action: 'save-participant',
        leagueId,
        displayName,
        profileId,
        handicapValue: handicapValue === '' ? null : Number(handicapValue),
      });
      if (temporaryPassword) setSecret({ name: displayName, password: temporaryPassword });
      announce(temporaryPassword ? `${displayName} added.` : `${displayName} added as a guest player.`);
      element.reset();
    });
  }

  async function savePlayer(player: RosterPlayer, event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get('displayName')).trim();
    const status = String(form.get('status'));
    const handicapValue = String(form.get('handicapValue') ?? '').trim();
    const handicapSource = String(form.get('handicapSource') ?? 'manual_verified');
    const effectiveFrom = String(form.get('effectiveFrom') ?? '').trim();
    await run(async () => {
      await saveCatalogItem({
        action: 'save-participant',
        leagueId,
        id: player.id,
        displayName,
        status,
        handicapValue: handicapValue === '' ? null : Number(handicapValue),
        handicapSource,
        handicapEffectiveFrom: effectiveFrom === '' ? null : effectiveFrom,
      });
      announce(
        handicapValue === ''
          ? `${displayName} updated.`
          : `${displayName} updated, handicap ${formatHandicap(Number(handicapValue))} effective ${effectiveFrom || 'today'}.`,
      );
      // Close on success. A handicap value left sitting in the form is an
      // accidental second revision waiting for the next save, and the row
      // above already shows the result.
      setOpenPlayerId(null);
    });
  }

  async function accountAction(
    player: RosterPlayer,
    action: 'disable' | 'reactivate' | 'reset',
  ): Promise<void> {
    setConfirming(null);
    await run(async () => {
      const result = await invokePhase1<{ status: string; temporaryPassword?: string }>(
        'account-admin',
        { action, profileId: player.profile_id },
      );
      if (result.temporaryPassword) {
        setSecret({ name: player.display_name, password: result.temporaryPassword });
      }
      announce(
        action === 'disable'
          ? `${player.display_name} can no longer sign in. Their scores and history are unchanged.`
          : action === 'reactivate'
            ? `${player.display_name} can sign in again.`
            : `${player.display_name} must set a new password at their next sign-in.`,
      );
    });
  }

  async function createAccountFor(player: RosterPlayer, username: string): Promise<void> {
    await run(async () => {
      const account = await invokePhase1<{ profileId: string; temporaryPassword: string }>(
        'account-admin',
        { action: 'create', username, displayName: player.display_name },
      );
      await saveCatalogItem({
        action: 'save-participant',
        leagueId,
        id: player.id,
        displayName: player.display_name,
        profileId: account.profileId,
      });
      setSecret({ name: player.display_name, password: account.temporaryPassword });
      announce(`Account created for ${player.display_name}.`);
    });
  }

  async function reviewCsv(mode: 'preview' | 'apply'): Promise<void> {
    await run(async () => {
      const result = await saveCatalogItem({
        action: 'import-participants',
        leagueId,
        csv: csvText,
        mode,
      }) as unknown as ImportResponse;
      setReport(result);
      if (result.status === 'imported') {
        setCsvText('');
        announce(`${result.applied} player${result.applied === 1 ? '' : 's'} imported.`);
      } else {
        announce(
          result.ok
            ? `${result.plan.length} row${result.plan.length === 1 ? '' : 's'} ready to import.`
            : 'The file has problems that must be fixed before importing.',
        );
      }
    });
  }

  function exportRoster(): void {
    const rows = (query.data ?? []).map((player) => [
      player.display_name,
      player.username ?? '',
      player.handicap ?? '',
      player.handicapSource ?? '',
      player.handicapFrom ?? '',
      player.status,
    ]);
    const csv = toCsv(
      ['display_name', 'username', 'handicap_index', 'handicap_source', 'effective_from', 'status'],
      rows,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `roster-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    announce(`${rows.length} player${rows.length === 1 ? '' : 's'} exported.`);
  }

  const blocking = (report?.issues ?? []).filter((issue) => !issue.warning);
  const warnings = (report?.issues ?? []).filter((issue) => issue.warning);

  return (
    <div className="screen catalog-screen">
      <header className="page-header">
        <Link className="back-link" to={`/league/${leagueId}`}>Back to league</Link>
        <h1>Players</h1>
        <p>League roster, handicap history, and sign-in accounts.</p>
      </header>

      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      {secret && (
        <div className="form-message form-message--warning" role="status">
          <p>
            <strong>Temporary password for {secret.name}:</strong> <code>{secret.password}</code>
          </p>
          <p>Give it to them directly. It is shown once and is never stored or sent.</p>
          <button className="button button--quiet" type="button" onClick={() => setSecret(null)}>
            I have written it down
          </button>
        </div>
      )}

      <div className="catalog-layout">
        <section>
          <div className="section-heading">
            <h2>Roster</h2>
            <span>{query.data?.length ?? 0}</span>
          </div>
          <div className="directory-list">
            {query.isLoading ? (
              <div className="skeleton skeleton--rows" />
            ) : (
              query.data?.map((player) => (
                <div key={player.id}>
                  <span className="initials" aria-hidden="true">{initials(player.display_name)}</span>
                  <div>
                    <strong>{player.display_name}</strong>
                    <small>
                      {player.username
                        ? `@${player.username}${player.accountStatus === 'disabled' ? ' · sign-in disabled' : ''}`
                        : 'Guest player'}
                      {player.status !== 'active' ? ` · ${player.status}` : ''}
                      {player.handicapFrom ? ` · since ${player.handicapFrom}` : ''}
                    </small>
                  </div>
                  <span className="handicap-value">{formatHandicap(player.handicap)}</span>
                  <button
                    className="button button--quiet button--small"
                    type="button"
                    aria-expanded={openPlayerId === player.id}
                    onClick={() => {
                      setConfirming(null);
                      setOpenPlayerId(openPlayerId === player.id ? null : player.id);
                    }}
                  >
                    {openPlayerId === player.id ? 'Close' : 'Manage'}
                  </button>

                  {openPlayerId === player.id && (
                    <form className="player-editor" onSubmit={(event) => void savePlayer(player, event)}>
                      <div className="field">
                        <label htmlFor={`name-${player.id}`}>Display name</label>
                        <input id={`name-${player.id}`} name="displayName" defaultValue={player.display_name} required />
                      </div>
                      <div className="field">
                        <label htmlFor={`status-${player.id}`}>Roster status</label>
                        <select id={`status-${player.id}`} name="status" defaultValue={player.status}>
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                          <option value="archived">Archived</option>
                        </select>
                        <small>Inactive players keep every past score and result.</small>
                      </div>

                      <fieldset className="handicap-revision">
                        <legend>New handicap value</legend>
                        <p className="muted">
                          Current: {formatHandicap(player.handicap)}
                          {player.handicapSource ? ` · ${SOURCE_LABELS[player.handicapSource as HandicapSource] ?? player.handicapSource}` : ''}.
                          Saving a value here keeps the old one in history; published events keep the value frozen at their own date.
                        </p>
                        <div className="field">
                          <label htmlFor={`handicap-${player.id}`}>Handicap index</label>
                          <input
                            id={`handicap-${player.id}`}
                            name="handicapValue"
                            type="number"
                            min="-10"
                            max="54"
                            step="0.1"
                            placeholder="Leave blank to keep the current value"
                          />
                          <small>Plus handicaps use a negative value, such as −1.2.</small>
                        </div>
                        <div className="field">
                          <label htmlFor={`source-${player.id}`}>Source</label>
                          <select id={`source-${player.id}`} name="handicapSource" defaultValue="manual_verified">
                            {HANDICAP_SOURCES.map((source) => (
                              <option key={source} value={source}>{SOURCE_LABELS[source]}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`effective-${player.id}`}>Effective from</label>
                          <input id={`effective-${player.id}`} name="effectiveFrom" type="date" />
                          <small>Defaults to today.</small>
                        </div>
                      </fieldset>

                      <div className="action-row">
                        <button className="button button--primary" type="submit" disabled={busy}>
                          {busy ? 'Saving…' : 'Save player'}
                        </button>
                      </div>

                      <div className="account-actions">
                        <h3>Sign-in account</h3>
                        {player.profile_id === null ? (
                          <div className="action-row">
                            <div className="field">
                              <label htmlFor={`username-${player.id}`}>New username</label>
                              <input
                                id={`username-${player.id}`}
                                pattern="[a-z0-9._-]{3,32}"
                                autoCapitalize="none"
                                onChange={(change) => change.currentTarget.setCustomValidity('')}
                              />
                            </div>
                            <button
                              className="button button--secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const input = document.getElementById(`username-${player.id}`) as HTMLInputElement | null;
                                const username = input?.value.trim().toLowerCase() ?? '';
                                if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
                                  setError('A username is 3-32 characters: a-z, 0-9, period, underscore, hyphen.');
                                  return;
                                }
                                void createAccountFor(player, username);
                              }}
                            >
                              Create account
                            </button>
                          </div>
                        ) : confirming?.id === player.id ? (
                          <div className="action-row" role="group" aria-label={`Confirm account change for ${player.display_name}`}>
                            <p className="form-message" role="status">
                              {confirming.action === 'disable'
                                ? `Disable sign-in for ${player.display_name}? They lose access immediately and every session ends. Their scores, attestations, and history stay exactly as they are.`
                                : `Reset the password for ${player.display_name}? Their current password stops working, every session ends, and you must give them a new temporary password.`}
                            </p>
                            <button className="button button--quiet" type="button" onClick={() => setConfirming(null)}>
                              Cancel
                            </button>
                            <button
                              className="button button--primary"
                              type="button"
                              disabled={busy}
                              onClick={() => void accountAction(player, confirming.action)}
                            >
                              {busy ? 'Working…' : confirming.action === 'disable' ? 'Disable sign-in' : 'Reset password'}
                            </button>
                          </div>
                        ) : (
                          <div className="action-row">
                            {player.accountStatus === 'disabled' ? (
                              <button
                                className="button button--secondary"
                                type="button"
                                disabled={busy}
                                onClick={() => void accountAction(player, 'reactivate')}
                              >
                                Restore sign-in
                              </button>
                            ) : (
                              <button
                                className="button button--quiet"
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirming({ id: player.id, action: 'disable' })}
                              >
                                Disable sign-in
                              </button>
                            )}
                            <button
                              className="button button--quiet"
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirming({ id: player.id, action: 'reset' })}
                            >
                              Reset password
                            </button>
                          </div>
                        )}
                        <small>Account changes need your authenticator; enrol it in Settings if you are asked for one.</small>
                      </div>
                    </form>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="action-row">
            <button
              className="button button--quiet"
              type="button"
              onClick={exportRoster}
              disabled={(query.data?.length ?? 0) === 0}
            >
              Export roster as CSV
            </button>
          </div>
        </section>

        <section className="catalog-form">
          <h2>Add a player</h2>
          <form className="form-stack" onSubmit={(event) => void addPlayer(event)}>
            <div className="field">
              <label htmlFor="player-name">Display name</label>
              <input id="player-name" name="displayName" required />
            </div>
            <div className="field">
              <label htmlFor="handicap">Verified handicap index</label>
              <input id="handicap" name="handicapValue" type="number" min="-10" max="54" step="0.1" defaultValue="0" />
              <small>Plus handicaps use a negative value, such as −1.2.</small>
            </div>
            <div className="field">
              <label htmlFor="username">Username (optional)</label>
              <input id="username" name="username" pattern="[a-z0-9._-]{3,32}" autoCapitalize="none" />
              <small>Leave blank for a guest without sign-in access.</small>
            </div>
            <button className="button button--primary" type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add player'}
            </button>
          </form>
        </section>

        <section className="catalog-form catalog-form--wide">
          <h2>Import players from a spreadsheet</h2>
          <p className="muted">
            Columns: <code>display_name</code>, <code>username</code>, <code>handicap_index</code>,{' '}
            <code>handicap_source</code>, <code>effective_from</code>, <code>status</code>. Only{' '}
            <code>display_name</code> is required. Players already on the roster are matched by name and updated.
            Nothing is written until you confirm the check below.
          </p>
          <div className="form-stack">
            <div className="field field--wide">
              <label htmlFor="csv-file">Choose a CSV file</label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(change) => {
                  const file = change.target.files?.[0];
                  if (!file) return;
                  void file.text().then((text) => {
                    setCsvText(text);
                    setReport(null);
                  });
                }}
              />
            </div>
            <div className="field field--wide">
              <label htmlFor="csv-text">…or paste the rows</label>
              <textarea
                id="csv-text"
                rows={6}
                spellCheck={false}
                value={csvText}
                placeholder={PARTICIPANT_CSV_TEMPLATE}
                onChange={(change) => {
                  setCsvText(change.target.value);
                  setReport(null);
                }}
              />
            </div>
            <div className="action-row">
              <button
                className="button button--secondary"
                type="button"
                disabled={busy || csvText.trim() === ''}
                onClick={() => void reviewCsv('preview')}
              >
                {busy ? 'Checking…' : 'Check the file'}
              </button>
              {report?.ok && report.status !== 'imported' && (
                <button
                  className="button button--primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void reviewCsv('apply')}
                >
                  Import {report.plan.length} player{report.plan.length === 1 ? '' : 's'}
                </button>
              )}
              <button
                className="button button--quiet"
                type="button"
                onClick={() => {
                  setCsvText(PARTICIPANT_CSV_TEMPLATE);
                  setReport(null);
                }}
              >
                Use the template
              </button>
            </div>
          </div>

          {report && (
            <div className="import-report">
              <h3>
                {report.status === 'imported' ? 'Imported' : 'Dry run'} — {report.rowsRead} row
                {report.rowsRead === 1 ? '' : 's'} read, {report.plan.length} ready
                {blocking.length > 0 ? `, ${blocking.length} blocked` : ''}
              </h3>
              {blocking.length > 0 && (
                <ul className="issue-list issue-list--error">
                  {blocking.map((issue, index) => (
                    <li key={`b${index}`}>
                      <strong>{issue.row === 0 ? 'File' : `Row ${issue.row}`}{issue.column ? ` · ${issue.column}` : ''}:</strong>{' '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {warnings.length > 0 && (
                <ul className="issue-list">
                  {warnings.map((issue, index) => (
                    <li key={`w${index}`}>
                      <strong>{issue.row === 0 ? 'File' : `Row ${issue.row}`}{issue.column ? ` · ${issue.column}` : ''}:</strong>{' '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {/* The plan table scrolls sideways on a phone, so it carries a tab
                  stop and a name: without one, a keyboard user cannot reach the
                  columns past the right edge (WCAG 2.1.1). */}
              {report.plan.length > 0 && (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Import plan, scroll horizontally for all columns"
                >
                  <table className="import-plan">
                    <thead>
                      <tr>
                        <th scope="col">Player</th>
                        <th scope="col">Change</th>
                        <th scope="col">Handicap</th>
                        <th scope="col">Roster status</th>
                        <th scope="col">Account</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.plan.map((row) => (
                        <tr key={`${row.displayName}-${row.action}`}>
                          <td>{row.displayName}</td>
                          <td>{row.action === 'create' ? 'Add' : 'Update'}</td>
                          <td>{row.handicap === null ? 'unchanged' : formatHandicap(row.handicap)}</td>
                          <td>{row.status}</td>
                          <td>{ACCOUNT_NOTES[row.account] ?? row.account}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

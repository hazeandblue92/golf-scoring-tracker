-- Deterministic development fixtures for the Golf Tournament Tracker.
-- Applied by `supabase db reset` after migrations. Runs as the postgres role
-- (table owner), so RLS does not block inserts.
--
-- All rows use fixed uuids so seeds are reproducible and referenceable from
-- tests. NO real PII: every name is synthetic. No auth.users/profiles rows
-- are seeded; participants intentionally have profile_id = NULL (guest
-- participants before account activation, section 11.3). Account fixtures
-- arrive with the auth Edge Function phase.
--
-- Fixed uuid map:
--   league                    00000000-0000-4000-8000-000000000001
--   seasons                   ...101, ...102
--   participants              ...201 .. ...208
--   participant_handicaps     ...221 .. ...228
--   course                    ...301
--   course_layout             ...311
--   tee_sets                  ...321 (Blue), ...322 (White)
--   event (draft)             ...401
--   round                     ...411

-- ---------------------------------------------------------------------------
-- League
-- ---------------------------------------------------------------------------
insert into public.leagues (id, name, slug, timezone, locale, privacy_notice_version, settings_json, status)
values (
  '00000000-0000-4000-8000-000000000001',
  'Golf Tournament Tracker Dev League',
  'gtt-dev',
  'America/Detroit',
  'en-US',
  1,
  '{}'::jsonb,
  'active'
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Seasons
-- ---------------------------------------------------------------------------
insert into public.seasons (id, league_id, name, starts_on, ends_on, status)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   '2026 Spring', '2026-04-01', '2026-06-30', 'completed'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   '2026 Fall', '2026-08-01', '2026-10-31', 'active')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Participants (synthetic names, no PII, no linked auth profiles)
-- ---------------------------------------------------------------------------
insert into public.participants (id, league_id, display_name, sort_name, status)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'Dev Player One',   'One, Dev Player',   'active'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', 'Dev Player Two',   'Two, Dev Player',   'active'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001', 'Dev Player Three', 'Three, Dev Player', 'active'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000001', 'Dev Player Four',  'Four, Dev Player',  'active'),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000001', 'Dev Player Five',  'Five, Dev Player',  'active'),
  ('00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-000000000001', 'Dev Player Six',   'Six, Dev Player',   'active'),
  ('00000000-0000-4000-8000-000000000207', '00000000-0000-4000-8000-000000000001', 'Dev Player Seven', 'Seven, Dev Player', 'active'),
  ('00000000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-000000000001', 'Dev Player Eight', 'Eight, Dev Player', 'active')
on conflict (id) do nothing;

-- Handicap values in signed internal convention: Dev Player Four is a plus
-- handicap, stored negative (section 7.3).
insert into public.participant_handicaps (id, participant_id, value, source, effective_from)
values
  ('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000201',  5.4, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000222', '00000000-0000-4000-8000-000000000202', 12.3, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000223', '00000000-0000-4000-8000-000000000203', 18.7, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000224', '00000000-0000-4000-8000-000000000204', -1.2, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000225', '00000000-0000-4000-8000-000000000205',  8.0, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000226', '00000000-0000-4000-8000-000000000206', 22.5, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000227', '00000000-0000-4000-8000-000000000207', 15.1, 'league_value', '2026-01-01'),
  ('00000000-0000-4000-8000-000000000228', '00000000-0000-4000-8000-000000000208',  3.6, 'league_value', '2026-01-01')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Course: one 18-hole layout with two rated tee sets.
-- ---------------------------------------------------------------------------
insert into public.courses (id, league_id, name, location_text, timezone, status)
values (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000001',
  'Dev Links Golf Club',
  'Synthetic Township, MI',
  'America/Detroit',
  'active'
)
on conflict (id) do nothing;

insert into public.course_layouts (id, course_id, name, hole_count, version, effective_from)
values (
  '00000000-0000-4000-8000-000000000311',
  '00000000-0000-4000-8000-000000000301',
  'Championship 18',
  18,
  1,
  '2026-01-01'
)
on conflict (id) do nothing;

insert into public.tee_sets (id, course_layout_id, name, rating_category, course_rating, slope_rating, par, version, status)
values
  ('00000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-000000000311',
   'Blue', 'standard', 72.4, 133, 72, 1, 'active'),
  ('00000000-0000-4000-8000-000000000322', '00000000-0000-4000-8000-000000000311',
   'White', 'standard', 70.1, 125, 72, 1, 'active')
on conflict (id) do nothing;

-- Blue tee holes. Stroke indexes form a permutation of 1..18; pars sum to 72.
insert into public.tee_holes (tee_set_id, hole_ordinal, course_hole_label, par, yardage, stroke_index)
values
  ('00000000-0000-4000-8000-000000000321',  1, '1',  4, 402,  7),
  ('00000000-0000-4000-8000-000000000321',  2, '2',  4, 415,  3),
  ('00000000-0000-4000-8000-000000000321',  3, '3',  3, 178, 15),
  ('00000000-0000-4000-8000-000000000321',  4, '4',  5, 540,  1),
  ('00000000-0000-4000-8000-000000000321',  5, '5',  4, 385, 11),
  ('00000000-0000-4000-8000-000000000321',  6, '6',  4, 428,  5),
  ('00000000-0000-4000-8000-000000000321',  7, '7',  3, 165, 17),
  ('00000000-0000-4000-8000-000000000321',  8, '8',  4, 395,  9),
  ('00000000-0000-4000-8000-000000000321',  9, '9',  5, 520, 13),
  ('00000000-0000-4000-8000-000000000321', 10, '10', 4, 410,  4),
  ('00000000-0000-4000-8000-000000000321', 11, '11', 5, 555,  2),
  ('00000000-0000-4000-8000-000000000321', 12, '12', 3, 190, 16),
  ('00000000-0000-4000-8000-000000000321', 13, '13', 4, 380, 12),
  ('00000000-0000-4000-8000-000000000321', 14, '14', 4, 440,  6),
  ('00000000-0000-4000-8000-000000000321', 15, '15', 4, 372, 14),
  ('00000000-0000-4000-8000-000000000321', 16, '16', 3, 155, 18),
  ('00000000-0000-4000-8000-000000000321', 17, '17', 5, 512, 10),
  ('00000000-0000-4000-8000-000000000321', 18, '18', 4, 405,  8)
on conflict (tee_set_id, hole_ordinal) do nothing;

-- White tee holes. A different stroke-index permutation of 1..18.
insert into public.tee_holes (tee_set_id, hole_ordinal, course_hole_label, par, yardage, stroke_index)
values
  ('00000000-0000-4000-8000-000000000322',  1, '1',  4, 380,  9),
  ('00000000-0000-4000-8000-000000000322',  2, '2',  4, 390,  3),
  ('00000000-0000-4000-8000-000000000322',  3, '3',  3, 160, 17),
  ('00000000-0000-4000-8000-000000000322',  4, '4',  5, 515,  1),
  ('00000000-0000-4000-8000-000000000322',  5, '5',  4, 365,  7),
  ('00000000-0000-4000-8000-000000000322',  6, '6',  4, 405,  5),
  ('00000000-0000-4000-8000-000000000322',  7, '7',  3, 148, 15),
  ('00000000-0000-4000-8000-000000000322',  8, '8',  4, 372, 11),
  ('00000000-0000-4000-8000-000000000322',  9, '9',  5, 498, 13),
  ('00000000-0000-4000-8000-000000000322', 10, '10', 4, 388,  6),
  ('00000000-0000-4000-8000-000000000322', 11, '11', 5, 530,  2),
  ('00000000-0000-4000-8000-000000000322', 12, '12', 3, 172, 18),
  ('00000000-0000-4000-8000-000000000322', 13, '13', 4, 360, 10),
  ('00000000-0000-4000-8000-000000000322', 14, '14', 4, 415,  4),
  ('00000000-0000-4000-8000-000000000322', 15, '15', 4, 350, 12),
  ('00000000-0000-4000-8000-000000000322', 16, '16', 3, 140, 16),
  ('00000000-0000-4000-8000-000000000322', 17, '17', 5, 490, 14),
  ('00000000-0000-4000-8000-000000000322', 18, '18', 4, 382,  8)
on conflict (tee_set_id, hole_ordinal) do nothing;

-- ---------------------------------------------------------------------------
-- One draft event in the active season (created_by NULL: no seeded profiles).
-- Snapshots, entries, and competitions are created through the app so the
-- publish pipeline stays the only snapshot writer.
-- ---------------------------------------------------------------------------
insert into public.events (id, league_id, season_id, name, slug, timezone, starts_at, ends_at, status, visibility)
values (
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000102',
  'Fall Kickoff',
  'fall-kickoff',
  'America/Detroit',
  '2026-09-12T13:00:00Z',
  '2026-09-12T22:00:00Z',
  'draft',
  'league'
)
on conflict (id) do nothing;

insert into public.rounds (id, event_id, round_number, name, starts_at, status, hole_count)
values (
  '00000000-0000-4000-8000-000000000411',
  '00000000-0000-4000-8000-000000000401',
  1,
  'Round 1',
  '2026-09-12T13:00:00Z',
  'scheduled',
  18
)
on conflict (id) do nothing;

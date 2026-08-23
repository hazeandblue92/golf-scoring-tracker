-- Flight replacement owns entry/team flight assignments and the top-level
-- flighting mode, but it must not destroy an explicitly frozen group/team
-- skins population. Detect the exact mechanical rewrite performed by
-- set_event_flights and retain the prior explicit population; unrelated draft
-- rules edits continue through unchanged.

create or replace function app.preserve_explicit_skins_population()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_population text := old.rules_json #>> '{skins,population}';
  v_new_population text := new.rules_json #>> '{skins,population}';
  v_expected_with_old_population jsonb;
  v_old_with_new_flighting jsonb;
begin
  if old.format <> 'skins'
    or old.status <> 'draft'
    or v_old_population not in ('group', 'teams')
    or v_new_population not in ('field', 'flight')
  then
    return new;
  end if;

  v_expected_with_old_population := jsonb_set(
    new.rules_json,
    '{skins,population}',
    to_jsonb(v_old_population),
    true
  );
  v_old_with_new_flighting := jsonb_set(
    old.rules_json,
    '{flighting}',
    coalesce(new.rules_json -> 'flighting', 'null'::jsonb),
    true
  );
  if v_expected_with_old_population = v_old_with_new_flighting then
    new.rules_json := v_expected_with_old_population;
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_preserve_explicit_skins_population
  on public.competitions;
create trigger competitions_preserve_explicit_skins_population
  before update of rules_json on public.competitions
  for each row execute function app.preserve_explicit_skins_population();

revoke all on function app.preserve_explicit_skins_population()
  from public, anon, authenticated;

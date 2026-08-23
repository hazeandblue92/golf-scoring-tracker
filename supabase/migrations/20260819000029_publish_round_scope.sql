-- Every frozen competition must declare the round(s) it consumes. The
-- projector previously treated a missing competition_rounds relationship as
-- event-wide, which could silently freeze malformed draft input. Reject the
-- draft -> published transition inside the same transaction as snapshotting.

create or replace function app.enforce_competition_round_scope_on_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'draft'
    and new.status in ('published', 'scoring_open')
    and new.format = 'skins'
    and new.rules_json #>> '{skins,finalCarry}' = 'sudden_death'
  then
    raise exception 'sudden-death skins require an adjudication fact that is not yet supported; choose a resolvable final-carry policy'
      using errcode = '23514';
  end if;
  if old.status = 'draft'
    and new.status in ('published', 'scoring_open')
    and not exists (
      select 1
      from public.competition_rounds scope
      join public.rounds round_row on round_row.id = scope.round_id
      where scope.competition_id = new.id
        and round_row.event_id = new.event_id
    )
  then
    raise exception 'every competition requires an authoritative event round before publish'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_publish_round_scope on public.competitions;
create trigger competitions_publish_round_scope
  before update of status on public.competitions
  for each row execute function app.enforce_competition_round_scope_on_publish();

revoke all on function app.enforce_competition_round_scope_on_publish()
  from public, anon, authenticated;

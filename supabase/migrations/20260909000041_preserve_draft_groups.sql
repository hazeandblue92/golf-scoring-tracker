-- Save the draft and its explicitly approved tee groups in one transaction.
create or replace function public.save_event_draft_with_groups(p_actor uuid, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_event uuid;
  v_round uuid;
  v_group jsonb;
  v_group_id uuid;
  v_order integer := 0;
  v_ids uuid[];
  v_all_ids uuid[] := '{}';
  v_expected uuid[];
begin
  select array_agg(x::uuid order by x::uuid) into v_expected
    from jsonb_array_elements_text(p_body->'participantIds') x;
  if p_body->>'competitionPreset' in ('three_player_scramble', 'four_player_scramble') then
    v_result := public.save_phase3_scramble_event_draft(
      p_actor, (p_body->>'eventId')::uuid, (p_body->>'leagueId')::uuid,
      (p_body->>'seasonId')::uuid, p_body->>'name', p_body->>'timezone',
      (p_body->>'startsAt')::timestamptz, (p_body->>'endsAt')::timestamptz,
      (p_body->>'visibility')::public.event_visibility, (p_body->>'teeSetId')::uuid,
      array(select x::uuid from jsonb_array_elements_text(p_body->'participantIds') x),
      array(select x::uuid from jsonb_array_elements_text(p_body->'scorerProfileIds') x),
      p_body->>'competitionPreset', p_body->'teams');
  else
    v_result := public.save_phase2_event_draft(
      p_actor, (p_body->>'eventId')::uuid, (p_body->>'leagueId')::uuid,
      (p_body->>'seasonId')::uuid, p_body->>'name', p_body->>'timezone',
      (p_body->>'startsAt')::timestamptz, (p_body->>'endsAt')::timestamptz,
      (p_body->>'visibility')::public.event_visibility, (p_body->>'teeSetId')::uuid,
      array(select x::uuid from jsonb_array_elements_text(p_body->'participantIds') x),
      array(select x::uuid from jsonb_array_elements_text(p_body->'scorerProfileIds') x),
      p_body->>'competitionPreset', p_body->'teams');
  end if;
  if not (p_body ? 'groups') then return v_result; end if;
  v_event := (v_result->>'eventId')::uuid;
  v_round := (v_result->>'roundId')::uuid;
  delete from public.groups where round_id = v_round;
  delete from public.scoring_permissions where event_id = v_event and grant_origin = 'group_auto';
  for v_group in select * from jsonb_array_elements(p_body->'groups') loop
    v_order := v_order + 1;
    v_ids := array(select x::uuid from jsonb_array_elements_text(v_group->'participantIds') x);
    if cardinality(v_ids) = 0 then raise exception 'A tee group cannot be empty'; end if;
    v_all_ids := v_all_ids || v_ids;
    insert into public.groups(round_id, label, start_hole_ordinal, sort_order)
      values(v_round, v_group->>'label', (v_group->>'startHoleOrdinal')::smallint, v_order)
      returning id into v_group_id;
    if p_body->>'competitionPreset' = 'individual_gross' then
      insert into public.group_members(group_id,event_entry_id,sort_order)
        select v_group_id,e.id,array_position(v_ids,e.participant_id)
        from public.event_entries e where e.event_id=v_event and e.participant_id=any(v_ids);
    else
      if exists(select 1 from public.event_teams t
        join public.event_team_members m on m.event_team_id=t.id
        join public.event_entries e on e.id=m.event_entry_id
        where t.event_id=v_event group by t.id
        having bool_or(e.participant_id=any(v_ids)) and not bool_and(e.participant_id=any(v_ids))) then
        raise exception 'A team cannot be split across tee groups';
      end if;
      insert into public.group_members(group_id,event_team_id,sort_order)
        select v_group_id,t.id,min(array_position(v_ids,e.participant_id))
        from public.event_teams t join public.event_team_members m on m.event_team_id=t.id
        join public.event_entries e on e.id=m.event_entry_id
        where t.event_id=v_event and e.participant_id=any(v_ids) group by t.id;
      -- Throwdown scorers are restricted to their actual copied tee group.
      if p_body->>'competitionPreset' = 'two_person_throwdown' then
        if cardinality(v_ids) <> 4 then raise exception 'Throwdown groups require four players'; end if;
        insert into public.scoring_permissions(event_id,round_id,scorer_profile_id,participant_id,permission_type,grant_origin)
          select v_event,v_round,p.profile_id,target,'marker','group_auto'
          from public.participants p cross join unnest(v_ids) target
          where p.id=any(v_ids) and p.profile_id is not null;
      end if;
    end if;
  end loop;
  if (select array_agg(x order by x) from unnest(v_all_ids) x) is distinct from v_expected then
    raise exception 'Tee groups must contain each selected participant exactly once';
  end if;
  return v_result;
end;
$$;
revoke all on function public.save_event_draft_with_groups(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_event_draft_with_groups(uuid,jsonb) to service_role;

import type { Json } from '@gtt/contracts';

export type CompetitionPreset = 'individual_gross' | 'two_person_throwdown' | 'three_player_scramble' | 'four_player_scramble';

/** Read persisted competitions; team count is not evidence of a format. */
export function templatePreset(competitions: Array<{ format: string; metric: string; rules_json: Json }>): CompetitionPreset {
  const formats = competitions.map((c) => `${c.format}:${c.metric}`).sort().join(',');
  if (formats === 'individual_stroke:gross') return 'individual_gross';
  if (formats === 'best_k:gross,best_k:net,individual_stroke:gross,individual_stroke:net,skins:gross,skins:net') return 'two_person_throwdown';
  if (formats === 'scramble:gross,scramble:net') {
    const sizes = competitions.map(({ rules_json: rules }) => {
      const team = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules['team'] : null;
      return team && typeof team === 'object' && !Array.isArray(team) ? team['teamSize'] : null;
    });
    if (sizes.every((size) => size === 3)) return 'three_player_scramble';
    if (sizes.every((size) => size === 4)) return 'four_player_scramble';
  }
  throw new Error('This event uses competitions that the setup builder cannot copy faithfully.');
}

type Grouping = {
  preset: CompetitionPreset | null;
  participantIds: string[];
  teams: Array<{ participantIds: string[] }>;
};

/** Renaming or reordering a team does not change its tee-group membership. */
export function hasSameGrouping(source: Grouping, current: Grouping): boolean {
  const ids = (values: string[]) => JSON.stringify(values.toSorted());
  const teams = (value: Grouping) => ids(value.teams.map((team) => ids(team.participantIds)));
  return source.preset === current.preset
    && ids(source.participantIds) === ids(current.participantIds)
    && teams(source) === teams(current);
}

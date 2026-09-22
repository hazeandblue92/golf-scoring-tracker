import { expect, it } from 'vitest';
import { hasSameGrouping, templatePreset } from '../src/lib/event-template.ts';

it('copies an individual format without guessing from empty teams', () => {
  expect(templatePreset([{ format: 'individual_stroke', metric: 'gross', rules_json: {} }])).toBe('individual_gross');
});

it.each([3, 4])('reads the %i-player scramble size from saved rules', (teamSize) => {
  expect(templatePreset(['gross', 'net'].map((metric) => ({ format: 'scramble', metric, rules_json: { team: { teamSize } } })))).toBe(teamSize === 3 ? 'three_player_scramble' : 'four_player_scramble');
});

it('recognizes the complete throwdown competition set regardless of order', () => {
  expect(templatePreset(['skins', 'individual_stroke', 'best_k'].flatMap((format) => ['net', 'gross'].map((metric) => ({ format, metric, rules_json: {} }))))).toBe('two_person_throwdown');
});

it('rejects unsupported competition sets instead of changing their format', () => {
  expect(() => templatePreset([{ format: 'stableford', metric: 'net', rules_json: {} }])).toThrow(/cannot copy faithfully/);
});

it('rejects inconsistent saved scramble sizes', () => {
  expect(() => templatePreset([
    { format: 'scramble', metric: 'gross', rules_json: { team: { teamSize: 3 } } },
    { format: 'scramble', metric: 'net', rules_json: { team: { teamSize: 4 } } },
  ])).toThrow(/cannot copy faithfully/);
});

it('preserves tee groups when teams are renamed or reordered, but not reassigned', () => {
  const source = {
    preset: 'two_person_throwdown' as const,
    participantIds: ['a', 'b', 'c', 'd'],
    teams: [{ name: 'First', participantIds: ['a', 'b'] }, { name: 'Second', participantIds: ['c', 'd'] }],
  };
  expect(hasSameGrouping(source, {
    ...source,
    participantIds: ['d', 'c', 'b', 'a'],
    teams: [{ name: 'Renamed', participantIds: ['d', 'c'] }, { name: 'Other', participantIds: ['b', 'a'] }],
  })).toBe(true);
  expect(hasSameGrouping(source, {
    ...source, teams: [{ participantIds: ['a', 'c'] }, { participantIds: ['b', 'd'] }],
  })).toBe(false);
  expect(hasSameGrouping(source, { ...source, participantIds: ['a', 'b', 'c', 'e'] })).toBe(false);
  expect(hasSameGrouping(source, { ...source, preset: 'individual_gross', teams: [] })).toBe(false);
});

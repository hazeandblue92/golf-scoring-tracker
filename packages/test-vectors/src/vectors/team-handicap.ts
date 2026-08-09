/**
 * Golden vectors — scramble / foursomes / Chapman team handicap presets
 * (spec §20.2 bullets 11-12; §8.8-8.10; §9.7; [S17]).
 *
 * Every preset combines exact UNROUNDED Course Handicaps and applies exactly
 * one final rounding step (usga_whs_2024: floor(x + 0.5)).
 */

import { fromTenths, percent, rational } from '@gtt/scoring'
import type { PairTeamHandicapVector, ScrambleHandicapVector } from './types.ts'

export const scrambleHandicapVectors: ScrambleHandicapVector[] = [
  {
    id: 'scramble-2-player-35-15',
    kind: 'scramble_handicap',
    section: '§20.2 · §8.8 · §9.7',
    description:
      'Two-player scramble weights 35% low + 15% high (input deliberately unsorted; engine sorts by value)',
    // CHs 18.2 and 8.2 -> sorted low..high: 8.2, 18.2
    //   0.35 x 8.2  = 2.87  (41/5 x 7/20  = 287/100)
    //   0.15 x 18.2 = 2.73  (91/5 x 3/20  = 273/100)
    //   sum = 5.60          (560/100 = 28/5)
    //   floor(5.6 + 0.5) = floor(6.1) = 6
    input: {
      courseHandicaps: [fromTenths(182), fromTenths(82)],
      weights: [percent(35), percent(15)],
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 28, den: 5 }, // 5.6
      teamPlayingHandicap: 6,
    },
  },
  {
    id: 'scramble-3-player-30-20-10',
    kind: 'scramble_handicap',
    section: '§20.2 · §8.8 · §9.7',
    description: 'Three-player scramble weights 30% low + 20% middle + 10% high',
    // CHs 12.6, 20.3, 4.1 -> sorted low..high: 4.1, 12.6, 20.3
    //   0.30 x 4.1  = 1.23  (123/100)
    //   0.20 x 12.6 = 2.52  (252/100)
    //   0.10 x 20.3 = 2.03  (203/100)
    //   sum = 5.78          (578/100 = 289/50)
    //   floor(5.78 + 0.5) = floor(6.28) = 6
    input: {
      courseHandicaps: [fromTenths(126), fromTenths(203), fromTenths(41)],
      weights: [percent(30), percent(20), percent(10)],
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 289, den: 50 }, // 5.78
      teamPlayingHandicap: 6,
    },
  },
  {
    id: 'scramble-4-player-25-20-15-10-with-plus',
    kind: 'scramble_handicap',
    section: '§20.2 · §8.8 · §7.3 · §9.7',
    description:
      'Four-player scramble weights 25/20/15/10 low to high; the plus handicap (internally negative) sorts lowest and takes the largest weight',
    // CHs 15.3, +1.4 (= -1.4), 10.7, 6.0 -> sorted: -1.4, 6.0, 10.7, 15.3
    //   0.25 x -1.4 = -0.35  (-7/20  = -70/200)
    //   0.20 x  6.0 =  1.20  (6/5    = 240/200)
    //   0.15 x 10.7 =  1.605 (321/200)
    //   0.10 x 15.3 =  1.53  (153/100 = 306/200)
    //   sum = 3.985          (797/200)
    //   floor(3.985 + 0.5) = floor(4.485) = 4
    input: {
      courseHandicaps: [
        fromTenths(153),
        fromTenths(-14), // plus 1.4, negative internally
        fromTenths(107),
        fromTenths(60),
      ],
      weights: [percent(25), percent(20), percent(15), percent(10)],
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 797, den: 200 }, // 3.985
      teamPlayingHandicap: 4,
    },
  },
]

export const pairTeamHandicapVectors: PairTeamHandicapVector[] = [
  {
    id: 'foursomes-50pct-combined',
    kind: 'foursomes_handicap',
    section: '§20.2 · §8.9 · §9.7',
    description:
      'Foursomes: 50% of the combined UNROUNDED Course Handicaps, one final rounding step',
    // Exact unrounded CHs from the tee snapshot (see ch/match vectors):
    //   CH_A = 12729/1130 (~11.264602), CH_B = 5969/1130 (~5.282301)
    //   sum  = 18698/1130 (~16.546903)
    //   x 0.5 -> 9349/1130 (~8.273451)
    //   floor(8.273451 + 0.5) = floor(8.773451) = 8
    input: {
      a: rational(12729, 1130),
      b: rational(5969, 1130),
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 9349, den: 1130 }, // ~8.273451
      teamPlayingHandicap: 8,
    },
  },
  {
    id: 'chapman-60-40',
    kind: 'greensomes_handicap',
    section: '§20.2 · §8.10 · §9.7',
    description: 'Chapman/Pinehurst: 60% of the lower + 40% of the higher CH',
    // CHs 6.3 and 14.9 -> lower 6.3, higher 14.9
    //   0.60 x 6.3  = 3.78  (63/10 x 3/5 = 189/50 = 378/100)
    //   0.40 x 14.9 = 5.96  (149/10 x 2/5 = 298/50 = 596/100)
    //   sum = 9.74          (974/100 = 487/50)
    //   floor(9.74 + 0.5) = floor(10.24) = 10
    input: {
      a: fromTenths(63),
      b: fromTenths(149),
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 487, den: 50 }, // 9.74
      teamPlayingHandicap: 10,
    },
  },
  {
    id: 'chapman-60-40-plus-is-lower',
    kind: 'greensomes_handicap',
    section: '§20.2 · §8.10 · §7.3',
    description:
      'Chapman with a plus handicap: the plus player (internally negative) is the LOWER value and takes the 60% weight',
    // CHs 2.1 and +1.0 (= -1.0) -> lower -1.0, higher 2.1
    //   0.60 x -1.0 = -0.60  (-3/5  = -15/25)
    //   0.40 x  2.1 =  0.84  (21/25)
    //   sum = 0.24           (6/25)
    //   floor(0.24 + 0.5) = floor(0.74) = 0
    input: {
      a: fromTenths(21),
      b: fromTenths(-10), // plus 1.0, negative internally
      rounding: { kind: 'usga_whs_2024' },
    },
    expected: {
      teamPlayingHandicapUnrounded: { num: 6, den: 25 }, // 0.24
      teamPlayingHandicap: 0,
    },
  },
]

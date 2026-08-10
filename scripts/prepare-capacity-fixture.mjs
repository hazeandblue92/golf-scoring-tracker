import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildScoringFixture } from '../tests/integration/helpers/fixture.ts';

const fixture = await buildScoringFixture({ playerCount: 50 });
const scoreCells = fixture.entries.flatMap((entry) => fixture.holes.map((hole) => ({
  roundId: fixture.roundId,
  target: { kind: 'individual', entryId: entry.entryId, holeId: hole.id },
  baseRevision: 0,
})));

const configPath = path.resolve('.capacity-config.local');
const tokenPath = path.resolve('.capacity-token.local');
await Promise.all([
  writeFile(configPath, `${JSON.stringify({
    eventId: fixture.eventId,
    competitionId: fixture.competitions.grossId,
    competitionIds: Object.values(fixture.competitions),
    scoreCells,
  }, null, 2)}\n`, { mode: 0o600 }),
  writeFile(tokenPath, `${fixture.scorer.accessToken}\n`, { mode: 0o600 }),
]);

console.log(`Disposable capacity fixture ready:\n- ${configPath}\n- ${tokenPath}`);

/** Phase 2 scorecard attestation contracts (spec §§5.6, 8.3, 12.2). */

import { z } from 'zod'

export const attestScorecardRequestSchema = z
  .strictObject({
    roundId: z.uuid(),
    targetKind: z.enum(['individual', 'team']),
    targetId: z.uuid(),
    attestationType: z.enum(['player', 'marker', 'director_override']),
    reason: z.string().trim().min(3).max(500).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.attestationType === 'director_override' && value.reason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A director override requires a reason',
      })
    }
  })

export type AttestScorecardRequest = z.infer<
  typeof attestScorecardRequestSchema
>

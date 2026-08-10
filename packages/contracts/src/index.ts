/**
 * @gtt/contracts — shared Zod schemas and inferred types.
 *
 * - rules.ts: rules_json discriminated union (spec §6.1, Appendix A)
 * - api.ts: submit-score request/response and score values (spec §12.3, §4.5)
 * - errors.ts: stable error codes (spec §12.4)
 */

export * from './errors.ts'
export * from './rules.ts'
export * from './api.ts'
export * from './phase1.ts'
export * from './phase2.ts'

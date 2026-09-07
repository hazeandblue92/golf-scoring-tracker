/**
 * Generate `packages/contracts/src/database.types.ts` from the live schema
 * (spec §26: "database migrations, data dictionary, RLS policy map, and
 * generated types").
 *
 * Until now every client and Edge Function hand-declared its row shapes, so a
 * migration could rename or drop a column and nothing failed to compile. The
 * generated file is the schema's own account of itself; committing it turns
 * schema drift into a diff.
 *
 *   npm run db:types          regenerate from the local stack
 *   npm run db:types -- --check   fail if the committed file is stale
 *
 * `--check` is what CI runs, in the job that already has a migrated database.
 * It regenerates into memory and compares, so a schema change that skipped the
 * regeneration step cannot merge.
 *
 * Source selection, in order: an explicit --db-url, then SUPABASE_DB_URL, then
 * the local stack. Never point this at production to "fix" a diff: the
 * migrations are the schema authority, and a hosted database that disagrees
 * with them is the finding, not the fix.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(repoRoot, 'packages/contracts/src/database.types.ts')

const HEADER = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by \`npm run db:types\` from the applied migrations in
 * supabase/migrations. CI regenerates it against a freshly migrated database
 * and fails when this file does not match, so a schema change that forgot the
 * regeneration step cannot merge.
 *
 * These are row shapes, not authorization. What a role may actually read or
 * write is decided by RLS and the table grants in the migrations; a column
 * appearing here says nothing about who can see it.
 */
`

function generate() {
  const args = ['supabase', 'gen', 'types', 'typescript', '--schema', 'public']
  const explicitUrl = process.argv.find((a) => a.startsWith('--db-url='))
  if (explicitUrl) args.push('--db-url', explicitUrl.slice('--db-url='.length))
  else if (process.env.SUPABASE_DB_URL) args.push('--db-url', process.env.SUPABASE_DB_URL)
  else args.push('--local')

  const stdout = execFileSync('npx', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // The CLI writes progress and update notices to stderr; only stdout is the
    // generated module.
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (!stdout.includes('export type Database')) {
    throw new Error('the generator produced no Database type; is the database migrated?')
  }
  return `${HEADER}${stdout.trimEnd()}\n`
}

const generated = generate()

if (process.argv.includes('--check')) {
  let committed
  try {
    committed = readFileSync(target, 'utf8')
  } catch {
    process.stderr.write(
      'packages/contracts/src/database.types.ts is missing. Run: npm run db:types\n',
    )
    process.exit(1)
  }
  if (committed !== generated) {
    process.stderr.write(
      'packages/contracts/src/database.types.ts is stale for the applied migrations.\n' +
        'Run: npm run db:types — then commit the result.\n',
    )
    process.exit(1)
  }
  process.stdout.write('Generated database types match the applied migrations.\n')
} else {
  writeFileSync(target, generated)
  process.stdout.write(`Wrote ${target}\n`)
}

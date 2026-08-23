import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RESTORE_SCRIPT = fileURLToPath(
  new URL('../../../scripts/restore-export.mjs', import.meta.url),
)

describe('portable export restore transaction', () => {
  it('routes the complete export through one atomic database workflow', async () => {
    const source = await readFile(RESTORE_SCRIPT, 'utf8')

    expect(source).toContain("'restore_portable_export'")
    expect(source).toContain('{ p_tables: document.tables ?? {} }')
    expect(source).not.toContain('.from(table).insert')
    expect(source).not.toContain('restore_portable_projection_artifact')
    expect(source).not.toContain('for (const table')
  })
})

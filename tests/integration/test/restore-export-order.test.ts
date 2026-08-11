import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RESTORE_SCRIPT = fileURLToPath(
  new URL('../../../scripts/restore-export.mjs', import.meta.url),
)

function restoreOrder(source: string): string[] {
  const match = source.match(/const order = \[([\s\S]*?)\n    \]/)
  if (!match?.[1]) throw new Error('restore table order not found')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

describe('portable export restore order', () => {
  it('restores flights before rows that reference flight_id', async () => {
    const order = restoreOrder(await readFile(RESTORE_SCRIPT, 'utf8'))
    const flights = order.indexOf('flights')

    expect(flights).toBeGreaterThanOrEqual(0)
    expect(flights).toBeLessThan(order.indexOf('event_entries'))
    expect(flights).toBeLessThan(order.indexOf('event_teams'))
  })
})

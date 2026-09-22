import type { Database as GeneratedDatabase, Json } from '../../../packages/contracts/src/database.types.ts'

/** Serialize domain payloads at the JSONB boundary, matching the HTTP transport. */
export function databaseJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

// PostgreSQL function arguments accept SQL NULL (unless their implementation
// rejects it). The generator omits that fact. Keep every generated name/type,
// including required arguments, while representing nullable RPC inputs.
type Functions = GeneratedDatabase['public']['Functions']
export type Database = Omit<GeneratedDatabase, 'public'> & {
  public: Omit<GeneratedDatabase['public'], 'Functions'> & {
    Functions: {
      [Name in keyof Functions]: Omit<Functions[Name], 'Args'> & {
        Args: { [Arg in keyof Functions[Name]['Args']]: Functions[Name]['Args'][Arg] | null }
      }
    }
  }
}

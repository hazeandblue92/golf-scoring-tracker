import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function operationsConfig(env, { backup = false } = {}) {
  const required = (name) => {
    const value = env[name]
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name} is missing or invalid.`)
    return value
  }
  let dbUrl
  if (env.SUPABASE_DB_URL) {
    try {
      dbUrl = new URL(required('SUPABASE_DB_URL'))
    } catch {
      throw new Error('SUPABASE_DB_URL must be a PostgreSQL connection URL.')
    }
  } else {
    const host = required('SUPABASE_DB_HOST')
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('SUPABASE_DB_HOST must be a hostname.')
    dbUrl = new URL(`postgresql://${host}:5432/postgres`)
    dbUrl.username = encodeURIComponent(required('SUPABASE_DB_USER'))
    dbUrl.password = encodeURIComponent(required('SUPABASE_DB_PASSWORD'))
  }
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || !dbUrl.hostname ||
      !dbUrl.username || !dbUrl.password || dbUrl.pathname.length < 2) {
    throw new Error('Database configuration requires a host, user, password, and database.')
  }
  // Hosted operations must never silently connect to a runner-local socket or disable TLS.
  dbUrl.searchParams.set('sslmode', 'require')
  const config = { SUPABASE_DB_URL: dbUrl.href }
  if (backup) {
    let url
    try { url = new URL(required('SUPABASE_URL')) } catch {
      throw new Error('SUPABASE_URL must be an HTTPS origin.')
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') {
      throw new Error('SUPABASE_URL must be an HTTPS origin.')
    }
    required('SUPABASE_SERVICE_ROLE_KEY')
    if (!/^age1[0-9a-z]{58}$/.test(required('AGE_BACKUP_RECIPIENT'))) {
      throw new Error('AGE_BACKUP_RECIPIENT must be a public age recipient.')
    }
    config.SUPABASE_URL = url.origin
  }
  return config
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = operationsConfig(process.env, { backup: process.argv.includes('--backup') })
    if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required.')
    for (const [key, value] of Object.entries(config)) {
      if (key === 'SUPABASE_DB_URL') process.stdout.write(`::add-mask::${value}\n`)
      appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`)
    }
    process.stdout.write('Operations configuration validated.\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

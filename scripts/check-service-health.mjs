const origin = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
let url
try { url = new URL(origin) } catch { throw new Error('A Supabase HTTPS origin is required.') }
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('A Supabase HTTPS origin is required.')
}
const response = await fetch(new URL('/functions/v1/health', url), {
  signal: AbortSignal.timeout(30_000),
  redirect: 'error',
})
if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}.`)
const body = await response.json()
if (body.status !== 'ok') throw new Error('Backend health is not OK; restore or investigate before an event.')
console.log('Backend database and authentication health: OK.')

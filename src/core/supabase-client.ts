/**
 * Shared Supabase client for catalog reads and sync writes (§6.2, §6.3).
 *
 * Auth (§10 open question) is resolved as **emailed one-time code**, verified
 * in-app rather than via a clicked link. A hardcoded long-lived token would be
 * simpler, but it would sit in the client bundle forever with no way to
 * rotate it. (A clickable magic link was the original plan, but this project
 * shares its Supabase instance — and its "Magic Link" email template — with
 * another app that already expects a typed code, so the client verifies the
 * code instead of relying on the template's link.) When Supabase is not
 * configured at all, the app runs local-only: everything works except
 * cross-device sync.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { createStore } from './store'

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''

export const supabaseConfigured = Boolean(URL && ANON_KEY)

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null
  client ??= createClient(URL, ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'pdr-auth',
    },
    global: {
      headers: { 'x-application-name': 'public-domain-reader' },
    },
  })
  return client
}

export type AuthState =
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; userId: string; email?: string }

export const authState = createStore<AuthState>(
  supabaseConfigured ? { status: 'signed-out' } : { status: 'unconfigured' },
)

function applySession(session: Session | null): void {
  if (!supabaseConfigured) return
  authState.set(
    session
      ? { status: 'signed-in', userId: session.user.id, email: session.user.email ?? undefined }
      : { status: 'signed-out' },
  )
}

export async function initAuth(): Promise<void> {
  const sb = supabase()
  if (!sb) return
  const { data } = await sb.auth.getSession()
  applySession(data.session)
  sb.auth.onAuthStateChange((_event, session) => applySession(session))
}

export async function signInWithEmail(email: string): Promise<void> {
  const sb = supabase()
  if (!sb) throw new Error('Supabase is not configured')
  const { error } = await sb.auth.signInWithOtp({ email })
  if (error) throw error
}

/** The code from the email `signInWithEmail` sent. */
export async function verifyEmailOtp(email: string, token: string): Promise<void> {
  const sb = supabase()
  if (!sb) throw new Error('Supabase is not configured')
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut()
}

export async function currentUserId(): Promise<string | null> {
  const state = authState.get()
  return state.status === 'signed-in' ? state.userId : null
}

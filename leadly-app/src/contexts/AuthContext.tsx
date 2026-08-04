import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import type { Profile, Tenant } from '../types/domain'

type TenantSummary = Pick<Tenant, 'id' | 'name' | 'status'>

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** Only set for tenant_admin/tenant_agent (null for superadmin, who has no tenant_id).
   * Loaded alongside the profile so guards can block access when status is 'inactive'. */
  tenant: TenantSummary | null
  /** True only while the auth.users row exists but no matching profiles row was found —
   * i.e. someone authenticated (Google or email/password) whose account hasn't created or
   * joined a tenant yet. Guards route these to the onboarding screen, not "not authorized". */
  unprovisioned: boolean
  loading: boolean
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>
  signUpWithPassword: (email: string, password: string, fullName: string) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>
  signInWithGoogle: () => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()

  if (error) {
    console.error('Failed to load profile', error)
    return null
  }
  return data as Profile | null
}

async function fetchTenant(tenantId: string): Promise<TenantSummary | null> {
  const { data, error } = await supabase.from('tenants').select('id, name, status').eq('id', tenantId).maybeSingle()

  if (error) {
    console.error('Failed to load tenant', error)
    return null
  }
  return data
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tenant, setTenant] = useState<TenantSummary | null>(null)
  const [unprovisioned, setUnprovisioned] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let currentUserId: string | null = null

    async function loadProfileFor(userId: string) {
      const nextProfile = await fetchProfile(userId)
      if (!active) return
      setProfile(nextProfile)
      setUnprovisioned(nextProfile === null)

      if (nextProfile?.tenant_id) {
        const nextTenant = await fetchTenant(nextProfile.tenant_id)
        if (!active) return
        setTenant(nextTenant)
      } else {
        setTenant(null)
      }
    }

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!active) return
      currentUserId = session?.user?.id ?? null
      setSession(session)
      if (session?.user) {
        await loadProfileFor(session.user.id)
      }
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!active) return

      const nextUserId = session?.user?.id ?? null
      if (nextUserId === currentUserId) {
        setSession(session)
        return
      }
      currentUserId = nextUserId

      setLoading(true)
      setSession(session)
      setProfile(null)
      setTenant(null)
      setUnprovisioned(false)
      if (session?.user) {
        await loadProfileFor(session.user.id)
      }
      setLoading(false)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  async function signInWithPassword(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function signUpWithPassword(email: string, password: string, fullName: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    })
    if (error) return { error: error.message, needsEmailConfirmation: false }
    // A session comes back immediately when email confirmation is off; when it's
    // required (current project setting), `session` is null until they click the link.
    return { error: null, needsEmailConfirmation: !data.session }
  }

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function refreshProfile() {
    if (session?.user) {
      const nextProfile = await fetchProfile(session.user.id)
      setProfile(nextProfile)
      setUnprovisioned(nextProfile === null)
      setTenant(nextProfile?.tenant_id ? await fetchTenant(nextProfile.tenant_id) : null)
    }
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    profile,
    tenant,
    unprovisioned,
    loading,
    signInWithPassword,
    signUpWithPassword,
    signInWithGoogle,
    signOut,
    refreshProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { listEnabledModuleKeys } from '../lib/api/tenantModules'
import { listMyPermissionKeys } from '../lib/api/permissions'
import type { Profile, Tenant } from '../types/domain'

type TenantSummary = Pick<Tenant, 'id' | 'name' | 'status'>

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** Only set for tenant_admin/tenant_agent (null for superadmin, who has no tenant_id).
   * Loaded alongside the profile so guards can block access when status is 'inactive'. */
  tenant: TenantSummary | null
  /** Module keys (see lib/modules.ts) the superadmin turned on for this tenant --
   * null for superadmin (no tenant, never gated) or while still loading. Drives both
   * TenantLayout's nav filtering and the RequireModule route guard, from the same
   * fetch so there's no duplicate query between the two call sites. */
  enabledModules: Set<string> | null
  /** Action keys (see lib/api/permissions.ts) the current user can perform --
   * all of permission_actions for superadmin/tenant_admin, or the granted set
   * of the tenant_agent's tenant_role_id. Null while loading; empty set fails
   * closed, same as enabledModules. */
  permissions: Set<string> | null
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

/** Fails closed (empty set = no modules visible) rather than throwing --
 * a broken fetch must never fall back to "everything unlocked". */
async function fetchEnabledModules(tenantId: string): Promise<Set<string>> {
  try {
    return await listEnabledModuleKeys(tenantId)
  } catch (error) {
    console.error('Failed to load enabled modules', error)
    return new Set()
  }
}

/** Fails closed (empty set = no actions allowed), same reasoning as
 * fetchEnabledModules -- a broken fetch must never fall back to "everything
 * unlocked". */
async function fetchPermissions(role: string, tenantRoleId: string | null): Promise<Set<string>> {
  try {
    return await listMyPermissionKeys(role, tenantRoleId)
  } catch (error) {
    console.error('Failed to load permissions', error)
    return new Set()
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tenant, setTenant] = useState<TenantSummary | null>(null)
  const [enabledModules, setEnabledModules] = useState<Set<string> | null>(null)
  const [permissions, setPermissions] = useState<Set<string> | null>(null)
  const [unprovisioned, setUnprovisioned] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let currentUserId: string | null = null
    // Set once the first onAuthStateChange callback (event `INITIAL_SESSION`)
    // has run -- see below for why there's no separate getSession() call.
    let initialized = false

    async function loadProfileFor(userId: string) {
      const nextProfile = await fetchProfile(userId)
      if (!active) return
      setProfile(nextProfile)
      setUnprovisioned(nextProfile === null)

      if (nextProfile?.tenant_id) {
        const [nextTenant, nextModules, nextPermissions] = await Promise.all([
          fetchTenant(nextProfile.tenant_id),
          fetchEnabledModules(nextProfile.tenant_id),
          fetchPermissions(nextProfile.role, nextProfile.tenant_role_id),
        ])
        if (!active) return
        setTenant(nextTenant)
        setEnabledModules(nextModules)
        setPermissions(nextPermissions)
      } else {
        setTenant(null)
        setEnabledModules(null)
        const nextPermissions = nextProfile ? await fetchPermissions(nextProfile.role, nextProfile.tenant_role_id) : null
        if (!active) return
        setPermissions(nextPermissions)
      }
    }

    // Deliberately no separate supabase.auth.getSession() call on mount --
    // it and onAuthStateChange each resolve the session independently
    // (supabase-js coordinates them via the Navigator LockManager), and
    // racing both caused a real bug in production: getSession() could
    // resolve with session=null a beat before onAuthStateChange's initial
    // INITIAL_SESSION event delivered the real one, which was enough for
    // RequireAuth to already have redirected to /login (loading briefly
    // false + session null) before the correct session arrived and Login.tsx
    // bounced back to /app -- the exact "flashes to login, then a second
    // later recovers" bug reported by the user on
    // https://leadly.lexycolombia.com/app. onAuthStateChange alone fires
    // once immediately on subscribe with the current session (already
    // resolved from storage), so it's the single source of truth here.
    const { data: subscription } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!active) return

      const nextUserId = session?.user?.id ?? null
      if (initialized && nextUserId === currentUserId) {
        setSession(session)
        return
      }
      currentUserId = nextUserId
      initialized = true

      setLoading(true)
      setSession(session)
      setProfile(null)
      setTenant(null)
      setEnabledModules(null)
      setPermissions(null)
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
      if (nextProfile?.tenant_id) {
        const [nextTenant, nextModules, nextPermissions] = await Promise.all([
          fetchTenant(nextProfile.tenant_id),
          fetchEnabledModules(nextProfile.tenant_id),
          fetchPermissions(nextProfile.role, nextProfile.tenant_role_id),
        ])
        setTenant(nextTenant)
        setEnabledModules(nextModules)
        setPermissions(nextPermissions)
      } else {
        setTenant(null)
        setEnabledModules(null)
        setPermissions(nextProfile ? await fetchPermissions(nextProfile.role, nextProfile.tenant_role_id) : null)
      }
    }
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    profile,
    tenant,
    enabledModules,
    permissions,
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

/** Whether the current user can perform `actionKey` (see permission_actions
 * / lib/api/permissions.ts). Only for showing/hiding UI -- the real boundary
 * is RLS's has_permission() on the DB side, this never substitutes for it.
 * `permissions === null` (still loading) reads as false, same fail-closed
 * default as the rest of this file. */
export function usePermission(actionKey: string): boolean {
  const { permissions } = useAuth()
  return permissions?.has(actionKey) ?? false
}

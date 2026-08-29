// Invites a tenant user: an auth.users row (via inviteUserByEmail, which
// emails them a link to set their own password -- we never handle/transmit
// a password ourselves) plus its matching public.profiles row. Must run
// server-side because it needs the service role key. Mirrors Bedly's
// admin-create-user pattern: callers must be either a platform superadmin
// (any role, any tenant) or a tenant_admin (only tenant_admin/tenant_agent,
// only for their own tenant -- can never grant superadmin or reach into
// another tenant).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const ALLOWED_ROLES = ["superadmin", "tenant_admin", "tenant_agent"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();

  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  const { data: callerProfile, error: callerProfileError } = await adminClient
    .from("profiles")
    .select("role, tenant_id")
    .eq("id", caller.id)
    .single();

  if (callerProfileError || !callerProfile) {
    return json({ error: "Caller profile not found" }, 403);
  }

  const isSuperadmin = callerProfile.role === "superadmin";
  const isTenantAdmin = callerProfile.role === "tenant_admin";

  if (!isSuperadmin && !isTenantAdmin) {
    return json({ error: "Only superadmins or tenant admins can create users" }, 403);
  }

  let body: {
    email?: string;
    full_name?: string;
    phone?: string | null;
    role?: string;
    tenant_id?: string | null;
    tenant_role_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { email, full_name, phone = null, role, tenant_id = null, tenant_role_id = null } = body;

  if (!email || !full_name || !role) {
    return json({ error: "email, full_name and role are required" }, 400);
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return json({ error: `role must be one of: ${ALLOWED_ROLES.join(", ")}` }, 400);
  }
  if (role !== "superadmin" && !tenant_id) {
    return json({ error: "tenant_id is required for non-superadmin roles" }, 400);
  }
  if (role === "tenant_agent" && !tenant_role_id) {
    return json({ error: "tenant_role_id is required for tenant_agent" }, 400);
  }

  if (isTenantAdmin) {
    // A tenant_admin caller may only invite users within their own tenant, and
    // cannot grant superadmin -- that stays a platform-superadmin-only privilege.
    if (tenant_id !== callerProfile.tenant_id) {
      return json({ error: "tenant_admin callers can only create users for their own tenant" }, 403);
    }
    if (role === "superadmin") {
      return json({ error: "Only a platform superadmin can grant the superadmin role" }, 403);
    }
  }

  // A tenant_role_id must belong to the same tenant this user is being
  // created for -- never trust an id the caller sends without checking
  // ownership first (same principle as resolveOrderAddress in storefront).
  if (role === "tenant_agent" && tenant_role_id) {
    const { data: roleRow, error: roleError } = await adminClient
      .from("tenant_roles")
      .select("id")
      .eq("id", tenant_role_id)
      .eq("tenant_id", tenant_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (roleError || !roleRow) {
      return json({ error: "tenant_role_id does not belong to this tenant" }, 400);
    }
  }

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { full_name },
  });

  if (inviteError || !invited.user) {
    return json({ error: inviteError?.message ?? "Failed to invite user" }, 400);
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .insert({
      id: invited.user.id,
      tenant_id: role === "superadmin" ? null : tenant_id,
      full_name,
      email,
      phone,
      role,
      tenant_role_id: role === "tenant_agent" ? tenant_role_id : null,
    })
    .select()
    .single();

  if (profileError) {
    // Roll back the orphaned invited auth user so retrying with the same email doesn't collide.
    await adminClient.auth.admin.deleteUser(invited.user.id);
    return json({ error: profileError.message }, 400);
  }

  return json({ profile }, 201);
});

// Lets a signed-in user who has NOT yet created/joined a tenant delete their
// own auth account -- the "I signed up by mistake, I'll wait to be invited"
// escape hatch from the onboarding screen (see CLAUDE.md / leadly-app
// pages/auth/CreateCompany.tsx). Deliberately scoped to accounts with no
// profiles row: this is not a general "delete my company" feature, it only
// ever removes a bare, still-unprovisioned auth.users row. Must run
// server-side because auth.admin.deleteUser requires the service role key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

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

  // Safety check, not just a UX nicety: refuse to run at all if a profile
  // already exists, so this endpoint can never become a way to delete a real
  // tenant admin's account (that would orphan their tenant's data).
  const { data: existingProfile } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", caller.id)
    .maybeSingle();

  if (existingProfile) {
    return json({ error: "This account already belongs to a tenant and cannot be self-deleted" }, 403);
  }

  const { error: deleteError } = await adminClient.auth.admin.deleteUser(caller.id);
  if (deleteError) {
    return json({ error: deleteError.message }, 400);
  }

  return json({ deleted: true }, 200);
});

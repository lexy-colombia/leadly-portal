// One-off seed script (Tenant QA Uno's demo product catalog) -- already ran,
// its job is done. Left disabled instead of deleted (no delete_edge_function
// tool available) so the function slug can't be reused to smuggle in
// unauthenticated writes.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => new Response(JSON.stringify({ error: "Disabled -- this was a one-off seed script, already run." }), { status: 410, headers: { "Content-Type": "application/json" } }));

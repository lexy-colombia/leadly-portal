export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Sin esto Chrome recuerda el preflight solo 5 s y repite un OPTIONS
  // (~300 ms medidos) casi en cada llamada. 7200 s es el tope que Chrome acepta.
  "Access-Control-Max-Age": "7200",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

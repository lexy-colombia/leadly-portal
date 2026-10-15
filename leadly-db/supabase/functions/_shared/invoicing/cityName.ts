// Nombre legible de un municipio DIVIPOLA a partir de su código. El nombre
// ya no se guarda duplicado junto al código (antes `tenant_dian_profile.city`):
// se resuelve contra el catálogo `cities`, que es la única fuente.
// deno-lint-ignore no-explicit-any
export async function resolveCityName(adminClient: any, cityCode: string | null | undefined): Promise<string | null> {
  if (!cityCode) return null;
  const { data } = await adminClient.from("cities").select("name").eq("code", cityCode).maybeSingle();
  return data?.name ?? null;
}

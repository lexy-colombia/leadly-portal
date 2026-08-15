// Minimal HubSpot REST client -- ported from tania-functions'
// HubSpotRepositoryImpl (~/Desktop/SEERI/tania-functions/internal/repositories/hubspot_repository.go),
// trimmed to just what the `hubspot` ai_skill needs: sync a contact, list
// deal pipelines, create a deal linked to that contact. Same base URL/auth
// (Bearer Private App token) as the reference implementation.
const BASE_URL = "https://api.hubapi.com";

async function request(token: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = typeof json.message === "string" ? json.message : `HubSpot API error (HTTP ${res.status})`;
    const err = new Error(message) as Error & { status: number; body: Record<string, unknown> };
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// HubSpot returns 409 with the existing contact's id embedded in the error
// message (e.g. "Contact already exists. Existing ID: 12345") -- there's no
// dedicated contact-search-by-email executor in the reference project to
// reuse instead, so this is the same trick HubSpot's own docs recommend for
// a create-or-update flow without a prior search call.
function extractExistingContactId(message: string): string | null {
  const match = message.match(/Existing ID:\s*(\d+)/i);
  return match ? match[1] : null;
}

export async function createOrUpdateContact(
  token: string,
  properties: Record<string, string>,
): Promise<{ id: string; created: boolean }> {
  try {
    const created = await request(token, "POST", "/crm/v3/objects/contacts", { properties });
    return { id: created.id as string, created: true };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 409) throw err;
    const existingId = extractExistingContactId((err as Error).message);
    if (!existingId) throw err;
    await request(token, "PATCH", `/crm/v3/objects/contacts/${existingId}`, { properties });
    return { id: existingId, created: false };
  }
}

export async function getDealPipelines(token: string): Promise<Array<Record<string, unknown>>> {
  const result = await request(token, "GET", "/crm/v3/pipelines/deals");
  return (result.results as Array<Record<string, unknown>>) ?? [];
}

export async function createDeal(
  token: string,
  properties: Record<string, string>,
  associatedContactId: string,
): Promise<{ id: string }> {
  const created = await request(token, "POST", "/crm/v3/objects/deals", {
    properties,
    associations: [
      {
        to: { id: associatedContactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }], // DEAL_TO_CONTACT
      },
    ],
  });
  return { id: created.id as string };
}

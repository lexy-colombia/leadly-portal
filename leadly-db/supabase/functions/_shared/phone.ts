/** Mismo catálogo y misma lógica que leadly-app/src/lib/phone.ts -- desde
 * la migración `20260904000000_clients_phone_prefix_split.sql`,
 * clients.phone quedó como SOLO el número local (clients.phone_prefix
 * guarda el indicativo aparte); todo lo que hasta ahora leía/escribía
 * clients.phone esperando el número completo (envío real por WhatsApp,
 * lookups por wa_id, integraciones externas como Shopify/HubSpot) necesita
 * reconstruirlo con combinePhone() antes de usarlo, o partir un número
 * entrante con splitPhone() antes de guardarlo/comparar contra las dos
 * columnas.
 *
 * No se importa el archivo del frontend porque vive en un paquete/runtime
 * distinto (Deno vs Vite) -- se duplica a propósito, igual que
 * isTenantWompiConnected está duplicada entre varias Edge Functions (ver
 * comentarios en ese código). Si el catálogo de indicativos cambia, hay que
 * tocar los dos archivos. */
export const DIAL_CODES = [
  { code: "57", label: "Colombia (+57)" },
  { code: "1", label: "Estados Unidos (+1)" },
  { code: "52", label: "México (+52)" },
  { code: "34", label: "España (+34)" },
  { code: "54", label: "Argentina (+54)" },
  { code: "56", label: "Chile (+56)" },
  { code: "51", label: "Perú (+51)" },
  { code: "593", label: "Ecuador (+593)" },
  { code: "58", label: "Venezuela (+58)" },
  { code: "507", label: "Panamá (+507)" },
  { code: "506", label: "Costa Rica (+506)" },
] as const;

export const DEFAULT_DIAL_CODE = DIAL_CODES[0].code;

const DIAL_CODES_BY_LENGTH = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length);

/** Separa un teléfono recibido como un solo string (ej. el wa_id que manda
 * Meta, "573209149704") en indicativo + número local -- para matchear
 * contra clients.phone_prefix/phone ya separados, o para guardar un
 * cliente nuevo. Nunca falla: si no matchea ningún indicativo conocido,
 * devuelve DEFAULT_DIAL_CODE y el string completo como número local. */
export function splitPhone(phone: string): { dialCode: string; localNumber: string } {
  const digits = (phone ?? "").replace(/\D/g, "");
  const match = DIAL_CODES_BY_LENGTH.find((c) => digits.startsWith(c.code));
  if (match) return { dialCode: match.code, localNumber: digits.slice(match.code.length) };
  return { dialCode: DEFAULT_DIAL_CODE, localNumber: digits };
}

/** Inverso de splitPhone -- reconstruye el número completo
 * (phone_prefix + phone) para todo lo que necesita el wa_id/E.164 completo:
 * enviar por la Graph API de Meta, un tel: link, o una integración externa
 * (Shopify/HubSpot). */
export function combinePhone(dialCode: string | null | undefined, localNumber: string | null | undefined): string {
  return `${dialCode ?? ""}${(localNumber ?? "").replace(/\D/g, "")}`;
}

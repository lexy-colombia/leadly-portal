// Anti-SSRF para las URLs de aviso (callback_url) de los proyectos.
//
// Qué se verifica:
//  - esquema https obligatorio, sin credenciales embebidas, largo <= 2048;
//  - hostname que sea una IP LITERAL (v4 o v6, incluyendo las formas
//    decimal/hex/octal que el parser WHATWG ya normaliza a punto-decimal)
//    privada, loopback, link-local, CGNAT, metadata (169.254.169.254,
//    fd00:ec2::254), multicast o reservada -> rechazada;
//  - nombres obviamente internos (localhost, *.localhost, *.local,
//    *.internal, *.lan, nombres de una sola etiqueta) -> rechazados;
//  - si el entorno expone resolución DNS (deps.resolveDns, p. ej.
//    Deno.resolveDns) cada dirección A/AAAA del host se vuelve a verificar.
//
// LÍMITE CONOCIDO (documentado a propósito): la resolución DNS NO se verifica
// si el runtime no la expone (el Edge Runtime de Supabase puede no tener
// permiso para Deno.resolveDns), y aun con ella existe una ventana TOCTOU
// (DNS rebinding) entre la resolución y el fetch real. La defensa en
// profundidad es: HTTPS, sin seguir redirecciones, timeout, cuerpo de
// respuesta nunca leído ni devuelto, y que el destino solo lo puede fijar un
// superadmin.

export class DestinationError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

function parseIPv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

export function isPrivateIPv4(p: number[]): boolean {
  const [a, b, c] = p;
  return (
    a === 0 || // "este" host / red
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast + reservado + broadcast
  );
}

/** Parsea un IPv6 (sin corchetes) a 8 grupos de 16 bits. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes("%")) s = s.split("%")[0];
  // cola IPv4 embebida
  const v4tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4tail) {
    const v4 = parseIPv4(v4tail[1]);
    if (!v4) return null;
    s = s.slice(0, s.length - v4tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const fill = halves.length === 2 ? new Array(8 - head.length - tail.length).fill("0") : [];
  const all = [...head, ...fill, ...tail];
  if (all.length !== 8) return null;
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

export function isPrivateIPv6(g: number[]): boolean {
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    // ::ffff:a.b.c.d (IPv4-mapped)
    return isPrivateIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (compat, obsoleto)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    // NAT64: se revisa el IPv4 embebido
    return isPrivateIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (g[0] === 0x2002) return isPrivateIPv4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentación
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA (incluye fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateAddress(addr: string): boolean {
  const v4 = parseIPv4(addr);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(addr.replace(/^\[|\]$/g, ""));
  if (v6) return isPrivateIPv6(v6);
  return true; // no se pudo interpretar -> se trata como no permitida
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".localdomain"];

/** Validación sincrónica (sin DNS). Devuelve el URL parseado o lanza DestinationError. */
export function checkCallbackUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) throw new DestinationError("invalid_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DestinationError("invalid_url");
  }
  if (url.protocol !== "https:") throw new DestinationError("https_required");
  if (url.username || url.password) throw new DestinationError("credentials_not_allowed");
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) throw new DestinationError("invalid_url");

  if (host.startsWith("[")) {
    const v6 = parseIPv6(host.slice(1, -1));
    if (!v6 || isPrivateIPv6(v6)) throw new DestinationError("private_address");
    return url;
  }
  // Literal IPv4 (el parser WHATWG ya convirtió 2130706433, 0x7f.1, 0177.0.0.1 -> 127.0.0.1)
  if (/^[0-9.]+$/.test(host)) {
    const v4 = parseIPv4(host);
    if (!v4 || isPrivateIPv4(v4)) throw new DestinationError("private_address");
    return url;
  }
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) throw new DestinationError("internal_hostname");
  if (!host.includes(".")) throw new DestinationError("internal_hostname");
  return url;
}

/** Validación completa: literal + (si hay resolver) DNS. */
export async function checkCallbackDestination(
  raw: string,
  resolveDns?: (hostname: string) => Promise<string[]>,
): Promise<URL> {
  const url = checkCallbackUrl(raw);
  const host = url.hostname;
  const isLiteral = host.startsWith("[") || /^[0-9.]+$/.test(host);
  if (!isLiteral && resolveDns) {
    let addrs: string[] | null = null;
    try {
      addrs = await resolveDns(host);
    } catch {
      addrs = null; // runtime sin DNS o fallo de resolución: no verificable (ver límite arriba)
    }
    if (addrs && addrs.some((a) => isPrivateAddress(a))) throw new DestinationError("resolves_to_private_address");
  }
  return url;
}

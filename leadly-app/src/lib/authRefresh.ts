/** Resultado de una lectura que distingue "fallo" de "no existe": un error de red NO es una fila inexistente. */
export type ReadResult<T> = { ok: true; data: T | null } | { ok: false }

/** Decide el valor a guardar tras un refresco: solo reemplaza el estado previo si la lectura tuvo exito
 * (incluido un `null` legitimo = la fila no existe); si fallo, conserva el previo. */
export function resolveRefresh<T>(previous: T | null, result: ReadResult<T>): T | null {
  return result.ok ? result.data : previous
}

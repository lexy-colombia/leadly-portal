/** Estado de una carga de la que se DERIVA una decisión (facturas, despacho,
 * pagos, saldo, ítems, catálogo). Regla: `loading` y `error` son
 * "desconocido" y se tratan como BLOQUEADO para lo destructivo/monetario. Solo
 * `ready` desbloquea. */
export type LoadStatus = 'loading' | 'ready' | 'error'

/** Estado al INICIAR una carga o un reintento: un `error` nunca se limpia
 * aquí (un reintento en vuelo sigue siendo "desconocido"); solo el éxito lo
 * pasa a `ready`. */
export function startLoad(prev: LoadStatus): LoadStatus {
  return prev === 'error' ? 'error' : 'loading'
}

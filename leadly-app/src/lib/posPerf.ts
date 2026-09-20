/** Medición de "abrir cuenta" del POS (clic → carrito creado → cuenta pintada
 * → catálogo listo), para decidir con datos reales si la Etapa 2 hace falta.
 * Solo `performance.mark` + `console.debug` (nivel "Verbose" del navegador,
 * invisible por defecto) -- nada de logs permanentes ruidosos ni telemetría.
 * En la consola de Chrome: filtrar por "[pos-open]" o correr
 * `performance.getEntriesByType('measure')`. */
const START = 'pos-open:click'

export function posOpenStart(): void {
  if (typeof performance === 'undefined') return
  performance.clearMarks()
  performance.clearMeasures()
  performance.mark(START)
}

export function posOpenMark(step: string): void {
  if (typeof performance === 'undefined' || !performance.getEntriesByName(START).length) return
  const name = `pos-open:${step}`
  if (performance.getEntriesByName(name).length) return
  performance.mark(name)
  const measure = performance.measure(`${name} (desde el clic)`, START, name)
  console.debug(`[pos-open] ${step}: +${Math.round(measure.duration)} ms`)
}

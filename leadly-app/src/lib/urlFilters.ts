import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

/** Filtros de una pantalla de lista, espejados en la URL.
 *
 * Pedido explícito del usuario (2026-09-13): "es molesto buscar algo y darle
 * pop y ver que todos los filtros se pierden" -- entrar al detalle de una
 * fila y volver con el botón "atrás" reconstruye la vista tal cual estaba, y
 * de paso el enlace se puede guardar o compartir ya filtrado.
 *
 * Convenciones:
 * - los nombres de los parámetros van en INGLÉS, igual que el resto del
 *   código; lo que se traduce es la interfaz, no los identificadores;
 * - lo que está en su valor por defecto NO se escribe, así que una URL sin
 *   parámetros es "la lista sin filtrar" y la barra de direcciones no se
 *   llena de ruido;
 * - se reemplaza la entrada de historial en vez de apilarla: "atrás" tiene
 *   que volver a la pantalla anterior, no deshacer letra por letra lo
 *   tipeado en el buscador. */
export function useUrlFilterSync(entries: Record<string, string | null>): void {
  const [searchParams, setSearchParams] = useSearchParams()
  const serialized = JSON.stringify(entries)

  useEffect(() => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries(entries)) {
      if (value) next.set(key, value)
    }
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized])
}

/** "Volver a la página 1 cuando cambian los filtros" -- pero solo cuando de
 * verdad CAMBIAN. Al entrar, filtros y página vienen de la URL y resetear
 * ahí haría imposible abrir un enlace con `?page=3`.
 *
 * Compara contra el valor anterior en vez de usar un flag de "primer
 * render": en desarrollo React monta los componentes dos veces y ese flag se
 * consume en la primera pasada, dejando la segunda sin guarda. */
export function useResetOnFilterChange(key: string, reset: () => void): void {
  const lastKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastKeyRef.current === key) return
    const isFirstRun = lastKeyRef.current === null
    lastKeyRef.current = key
    if (!isFirstRun) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

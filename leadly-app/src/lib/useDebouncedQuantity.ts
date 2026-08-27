import { useCallback, useEffect, useRef, useState } from 'react'

const COMMIT_DELAY_MS = 500

/** Cantidad de un ítem de carrito con guardado debounced -- separa el estado
 * local (lo que se ve y se puede seguir tocando al instante) del estado real
 * en la DB (lo que efectivamente se manda). Cada click de +/- o cada tecla
 * en el input actualiza `value` ya mismo, sin esperar ningún viaje de red, y
 * reinicia un timer de COMMIT_DELAY_MS -- recién cuando pasa ese tiempo sin
 * un cambio nuevo se llama a `onCommit` UNA sola vez con el valor final, en
 * vez de una llamada por click. `saving` se prende apenas hay un cambio sin
 * guardar (no recién cuando arranca la llamada de red) y se apaga cuando esa
 * llamada termina, para que la animación de "guardando" cubra todo el
 * período en el que lo que se ve en pantalla todavía no está confirmado en
 * el servidor. Si el componente se desmonta con un cambio pendiente (ej: el
 * usuario navegó justo después de tocar +), lo manda igual en vez de
 * perderlo. */
export function useDebouncedQuantity(initialValue: number, onCommit: (quantity: number) => Promise<void>) {
  const [value, setValueState] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const valueRef = useRef(initialValue)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef(false)
  // Cuántos commits hay efectivamente en vuelo (red) en este momento --
  // separado de `pendingRef` (un cambio sin mandar todavía) porque, si un
  // segundo click llega mientras el primer commit sigue viajando, ese
  // primer commit puede resolver DESPUÉS de que ya haya un cambio nuevo en
  // cola: sin este contador, `saving` se apagaría en ese resolve aunque
  // todavía quede algo sin guardar.
  const inFlightRef = useRef(0)
  const mountedRef = useRef(true)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // Resincroniza desde el servidor solo si no hay ningún cambio local
  // pendiente -- si lo hubiera, el valor que llega por props es el mismo que
  // se está por mandar (o ya se mandó), pisarlo ahora solo generaría un
  // parpadeo.
  useEffect(() => {
    if (!pendingRef.current) {
      valueRef.current = initialValue
      setValueState(initialValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue])

  const syncSaving = useCallback(() => {
    setSaving(pendingRef.current || inFlightRef.current > 0)
  }, [])

  const flush = useCallback(
    (quantity: number) => {
      pendingRef.current = false
      timerRef.current = null
      inFlightRef.current += 1
      syncSaving()
      onCommitRef.current(quantity).finally(() => {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1)
        if (mountedRef.current) syncSaving()
      })
    },
    [syncSaving],
  )

  const setValue = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.floor(next) || 0)
      valueRef.current = clamped
      setValueState(clamped)
      pendingRef.current = true
      syncSaving()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => flush(clamped), COMMIT_DELAY_MS)
    },
    [flush, syncSaving],
  )

  const nudge = useCallback((delta: number) => setValue(valueRef.current + delta), [setValue])

  // Salta el debounce y guarda ya mismo -- para acciones deliberadas y
  // puntuales (ej: el botón de "quitar" del carrito) que no deberían
  // competir con, ni perderse detrás de, un cambio de cantidad que ya
  // estuviera en cola para este mismo ítem.
  const flushNow = useCallback(
    (next?: number) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      const clamped = Math.max(0, Math.floor(next ?? valueRef.current) || 0)
      valueRef.current = clamped
      setValueState(clamped)
      pendingRef.current = true
      syncSaving()
      flush(clamped)
    },
    [flush, syncSaving],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        if (pendingRef.current) onCommitRef.current(valueRef.current)
      }
    }
  }, [])

  return { value, saving, setValue, nudge, flushNow }
}

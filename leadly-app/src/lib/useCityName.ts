import { useEffect, useState } from 'react'
import { listCities } from './api/geo'

/** Nombre legible de un municipio DIVIPOLA a partir de su código (el
 * catálogo se cachea en `listCities`, no hay consulta por llamada). */
export function useCityName(cityCode: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!cityCode) {
      setName(null)
      return
    }
    let cancelled = false
    listCities()
      .then((cities) => {
        if (!cancelled) setName(cities.find((c) => c.code === cityCode)?.name ?? null)
      })
      .catch(() => {
        if (!cancelled) setName(null)
      })
    return () => {
      cancelled = true
    }
  }, [cityCode])
  return name
}

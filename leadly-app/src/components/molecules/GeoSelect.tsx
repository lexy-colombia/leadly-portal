import { useEffect, useState } from 'react'
import { listDepartments, listCities, type Department, type City } from '../../lib/api/geo'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

export interface GeoValue {
  stateCode: string | null
  cityCode: string | null
  stateName: string | null
  cityName: string | null
}

/** Departamento + ciudad de Colombia, elegidos de una lista real (DIVIPOLA)
 * en vez de tipeados a mano -- la lista ya trae el código DANE que la DIAN
 * exige (ver buildInvoiceXml.ts, reglas FAJ09/FAJ12/FAJ29/FAJ32), así que
 * elegir "Medellín" completa el código sin que nadie tenga que saberlo de
 * memoria. Devuelve también el nombre legible de cada uno (`stateName`/
 * `cityName`) para que el caller pueda seguir guardando `city`/
 * `state_province` como texto, sin duplicar el catálogo en dos lugares.
 *
 * Elegir un departamento nuevo limpia la ciudad si ya no pertenece a ese
 * departamento -- evita guardar una combinación inconsistente (ej. una
 * ciudad de Antioquia con el departamento cambiado a Cundinamarca). */
export function GeoSelect({
  stateCode,
  cityCode,
  onChange,
  stateLabel,
  cityLabel,
  idPrefix = 'geo',
  disabled = false,
}: {
  stateCode: string | null
  cityCode: string | null
  onChange: (next: GeoValue) => void
  stateLabel: string
  cityLabel: string
  idPrefix?: string
  disabled?: boolean
}) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [cities, setCities] = useState<City[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    Promise.all([listDepartments(), listCities()])
      .then(([deps, cts]) => {
        setDepartments(deps)
        setCities(cts)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const citiesInState = stateCode ? cities.filter((c) => c.department_code === stateCode) : []

  function handleStateChange(nextCode: string) {
    const state = departments.find((d) => d.code === nextCode) ?? null
    // Si la ciudad ya elegida no pertenece al departamento nuevo, se
    // limpia -- no tiene sentido guardar "Medellín" con departamento
    // "Cundinamarca".
    const cityStillValid = cityCode ? cities.find((c) => c.code === cityCode)?.department_code === nextCode : false
    onChange({
      stateCode: nextCode,
      stateName: state?.name ?? null,
      cityCode: cityStillValid ? cityCode : null,
      cityName: cityStillValid ? (cities.find((c) => c.code === cityCode)?.name ?? null) : null,
    })
  }

  function handleCityChange(nextCode: string) {
    const city = cities.find((c) => c.code === nextCode) ?? null
    onChange({ stateCode, stateName: departments.find((d) => d.code === stateCode)?.name ?? null, cityCode: nextCode, cityName: city?.name ?? null })
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor={`${idPrefix}-state`}>{stateLabel}</Label>
        <Select value={stateCode ?? ''} onValueChange={handleStateChange} disabled={disabled || !loaded}>
          <SelectTrigger id={`${idPrefix}-state`} className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.code} value={d.code} className="text-xs">
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-city`}>{cityLabel}</Label>
        <Select value={cityCode ?? ''} onValueChange={handleCityChange} disabled={disabled || !loaded || !stateCode}>
          <SelectTrigger id={`${idPrefix}-city`} className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {citiesInState.map((c) => (
              <SelectItem key={c.code} value={c.code} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

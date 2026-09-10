import { supabase } from '../supabaseClient'

export interface Department {
  code: string
  name: string
}

export interface City {
  code: string
  name: string
  department_code: string
}

/** Catálogo real de departamentos/municipios de Colombia (DIVIPOLA) --
 * pedido explícito del usuario 2026-09-09, para que un tenant/cliente
 * ELIJA su ciudad de una lista en vez de escribir a mano el código DANE
 * que la DIAN exige (ver buildInvoiceXml.ts, reglas FAJ09/FAJ12/FAJ29/
 * FAJ32). Tablas públicas de solo lectura (mismo criterio que tax_types/
 * document_types) -- se cachean en memoria del lado del cliente
 * (1122 ciudades, ~40KB, no cambia nunca) para no repetir la consulta
 * cada vez que se abre un formulario. */
let departmentsCache: Department[] | null = null
let citiesCache: City[] | null = null

export async function listDepartments(): Promise<Department[]> {
  if (departmentsCache) return departmentsCache
  const { data, error } = await supabase.from('departments').select('*').order('name')
  if (error) throw error
  departmentsCache = data
  return data
}

export async function listCities(): Promise<City[]> {
  if (citiesCache) return citiesCache
  const { data, error } = await supabase.from('cities').select('*').order('name')
  if (error) throw error
  citiesCache = data
  return data
}

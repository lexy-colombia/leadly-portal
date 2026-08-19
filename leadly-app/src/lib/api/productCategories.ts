import { supabase } from '../supabaseClient'
import type { ProductCategory } from '../../types/domain'

export interface ProductCategoryInput {
  tenant_id: string
  name: string
  description?: string | null
  parent_category_id?: string | null
  is_active?: boolean
}

export async function listProductCategories(tenantId: string): Promise<ProductCategory[]> {
  const { data, error } = await supabase
    .from('product_categories')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createProductCategory(input: ProductCategoryInput): Promise<ProductCategory> {
  const { data, error } = await supabase.from('product_categories').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateProductCategory(id: string, input: Partial<ProductCategoryInput>): Promise<ProductCategory> {
  const { data, error } = await supabase.from('product_categories').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteProductCategory(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('product_categories')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}

export interface CategoryTreeNode {
  category: ProductCategory
  depth: number
}

/** Flattens the parent_category_id tree into a depth-first, indentable list
 * (parent immediately followed by its children, each with its nesting
 * depth) -- the shape both CategoriesTab's table rows and CategoryDrawer's
 * "categoría padre" picker want, so it's one pure function instead of two
 * ad-hoc traversals. A category whose parent_category_id points at a
 * deleted/missing category (or, defensively, at itself via a stale id) is
 * treated as a root rather than dropped -- orphaning it silently would be
 * worse than showing it one level too high. */
export function flattenCategoryTree(categories: ProductCategory[]): CategoryTreeNode[] {
  const byParent = new Map<string | null, ProductCategory[]>()
  for (const category of categories) {
    const parentId = categories.some((c) => c.id === category.parent_category_id) ? category.parent_category_id : null
    const siblings = byParent.get(parentId) ?? []
    siblings.push(category)
    byParent.set(parentId, siblings)
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.name.localeCompare(b.name))

  const result: CategoryTreeNode[] = []
  function visit(parentId: string | null, depth: number) {
    for (const category of byParent.get(parentId) ?? []) {
      result.push({ category, depth })
      visit(category.id, depth + 1)
    }
  }
  visit(null, 0)
  return result
}

/** A category can't become its own ancestor -- used to filter the "categoría
 * padre" picker when editing an existing category (excludes itself and
 * every descendant). Not needed when creating a new one (it has no
 * descendants yet, and can't be its own parent since it has no id). */
export function descendantIds(categories: ProductCategory[], categoryId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const c of categories) {
    if (!c.parent_category_id) continue
    const list = children.get(c.parent_category_id) ?? []
    list.push(c.id)
    children.set(c.parent_category_id, list)
  }
  const result = new Set<string>()
  function visit(id: string) {
    for (const childId of children.get(id) ?? []) {
      if (result.has(childId)) continue // guards against a cyclic parent chain, if one ever slips in
      result.add(childId)
      visit(childId)
    }
  }
  visit(categoryId)
  return result
}

import { useEffect, useState } from 'react'
import { deleteSupplier, listSuppliers } from '../../../lib/api/suppliers'
import type { CrmSupplier } from '../../../types/domain'
import { Badge, Button, Card, EmptyState, PageSpinner, Pagination, Table, TBody, TD, TH, THead, TRow } from '../../../components/ui'
import { PencilIcon, PlusIcon, TrashIcon } from '../../../components/icons'
import { SupplierDrawer } from './SupplierDrawer'

const PAGE_SIZE = 10

export function SuppliersTab({ tenantId }: { tenantId: string }) {
  const [suppliers, setSuppliers] = useState<CrmSupplier[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; supplier: CrmSupplier | null }>({ open: false, supplier: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listSuppliers(tenantId)
      .then(setSuppliers)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los proveedores.'))
  }

  useEffect(reload, [tenantId])

  const totalPages = suppliers ? Math.max(1, Math.ceil(suppliers.length / PAGE_SIZE)) : 1
  const pageItems = suppliers ? suppliers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteSupplier(id)
      setSuppliers((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar el proveedor.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-brand-400">
          {suppliers?.length ?? 0} {(suppliers?.length ?? 0) === 1 ? 'proveedor' : 'proveedores'}
        </span>
        <Button variant="secondary" onClick={() => setDrawer({ open: true, supplier: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> Nuevo proveedor
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!suppliers && !error && <PageSpinner />}

      {suppliers && suppliers.length === 0 && (
        <Card>
          <EmptyState>Todavía no tenés proveedores registrados.</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Proveedor</TH>
                <TH>Contacto</TH>
                <TH>Teléfono</TH>
                <TH>Estado</TH>
                <TH className="text-right">Acciones</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((supplier) => (
                <TRow key={supplier.id}>
                  <TD className="text-xs font-medium text-brand-800">{supplier.name}</TD>
                  <TD className="text-xs text-brand-500">{supplier.contact_name ?? '-'}</TD>
                  <TD className="text-xs text-brand-500">{supplier.phone ?? '-'}</TD>
                  <TD>
                    <Badge tone={supplier.is_active ? 'success' : 'neutral'}>{supplier.is_active ? 'Activo' : 'Inactivo'}</Badge>
                  </TD>
                  <TD className="text-right">
                    {deletingId === supplier.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(supplier.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? 'Eliminando…' : 'Confirmar'}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          Cancelar
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, supplier })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(supplier.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                          <TrashIcon width={12} height={12} />
                        </Button>
                      </span>
                    )}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <SupplierDrawer open={drawer.open} onClose={() => setDrawer({ open: false, supplier: null })} tenantId={tenantId} supplier={drawer.supplier} onSaved={reload} />
    </div>
  )
}

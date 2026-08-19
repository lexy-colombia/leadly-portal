import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, Input, Select } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { PlusIcon, TrashIcon } from '@/components/atoms/icons'
import type { OrderItemInput } from '../../../lib/api/orders'
import type { ProductWithImages } from '../../../lib/api/products'

const CUSTOM_LINE_VALUE = '__custom__'

/** Editable line-item list shared by OrderDrawer.tsx (inside its form) and
 * OrderDetail.tsx (inline on the page, no drawer) -- same product
 * picker/quantity/price/discount editing either way, just a different
 * container and save trigger around it. */
export function OrderItemsEditor({
  items,
  products,
  onChange,
}: {
  items: OrderItemInput[]
  products: ProductWithImages[]
  onChange: (items: OrderItemInput[]) => void
}) {
  const { t } = useLanguage()

  function addItem() {
    onChange([...items, { product_id: null, product_name: '', sku: null, quantity: 1, unit_price: 0, discount_percentage: 0 }])
  }

  function updateItem(index: number, patch: Partial<OrderItemInput>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index))
  }

  function handleProductSelect(index: number, productId: string) {
    if (productId === CUSTOM_LINE_VALUE || !productId) {
      updateItem(index, { product_id: null, product_name: '', sku: null, unit_price: 0 })
      return
    }
    const product = products.find((p) => p.id === productId)
    if (!product) return
    updateItem(index, { product_id: product.id, product_name: product.name, sku: product.sku, unit_price: product.retail_price ?? 0 })
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-brand-500">{t('orders.itemsEditor.title')}</span>
        <Button type="button" variant="ghost" onClick={addItem} className="!px-2 !py-1 text-xs">
          <PlusIcon width={13} height={13} /> {t('orders.itemsEditor.addLine')}
        </Button>
      </div>

      {items.length === 0 && <p className="text-xs text-brand-400">{t('orders.itemsEditor.empty')}</p>}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="rounded-lg border border-brand-100 p-2.5">
              <div className="flex items-start gap-2">
                <Select value={item.product_id ?? CUSTOM_LINE_VALUE} onChange={(e) => handleProductSelect(index, e.target.value)} className="!flex-1 !py-1.5 text-xs">
                  <option value={CUSTOM_LINE_VALUE}>{t('orders.itemsEditor.customLine')}</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeItem(index)}
                  aria-label={t('orders.itemsEditor.removeAria')}
                  className="!shrink-0 !px-2 !py-1.5 !text-red-600 hover:!bg-red-50"
                >
                  <TrashIcon width={13} height={13} />
                </Button>
              </div>

              {!item.product_id && (
                <Input
                  value={item.product_name}
                  onChange={(e) => updateItem(index, { product_name: e.target.value })}
                  placeholder={t('orders.itemsEditor.lineNamePlaceholder')}
                  className="!mt-2 !py-1.5 text-xs"
                />
              )}

              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-brand-500">{t('orders.itemsEditor.quantity')}</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={item.quantity}
                    onChange={(e) => updateItem(index, { quantity: Number(e.target.value) || 0 })}
                    className="!py-1.5 text-xs"
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-brand-500">{t('orders.itemsEditor.unitPrice')}</span>
                  <CurrencyInput
                    value={item.unit_price}
                    onChange={(e) => updateItem(index, { unit_price: Number(e.target.value) || 0 })}
                    className="!py-1.5 text-xs"
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-brand-500">{t('orders.itemsEditor.discountPercent')}</span>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={item.discount_percentage ?? 0}
                    onChange={(e) => updateItem(index, { discount_percentage: Number(e.target.value) || 0 })}
                    className="!py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

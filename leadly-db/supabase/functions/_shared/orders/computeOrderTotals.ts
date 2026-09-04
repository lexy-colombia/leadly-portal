import { computeLineTax } from "../invoicing/queueInvoiceGeneration.ts";

/** Cálculo puro de los totales de un pedido/carrito -- extraído de
 * persistOrderItems.ts (2026-09-04) para que el desglose que se MUESTRA
 * antes de cobrar (POS, resumen de pago) salga exactamente del mismo
 * código que el que después PERSISTE los totales del pedido real. Sin
 * esto, mostrar "base + IVA" en el POS obligaba a una segunda cuenta en
 * el frontend -- justo lo que el usuario prohibió explícitamente
 * (2026-09-03: cero cálculos de negocio en el frontend, ni de preview).
 *
 * El precio YA INCLUYE el impuesto: se extrae, no se suma (ver
 * computeLineTax). Por eso `total` no depende de `taxTotal` -- mover el
 * IVA solo cambia cómo se reparte entre base e impuesto, nunca cuánto
 * paga el cliente. */
export interface TaxableItem {
  quantity: number;
  unit_price: number;
  discount_amount?: number;
  tax_type_code?: string | null;
  tax_rate?: number;
}

export interface OrderTaxLine {
  tax_type_code: string | null;
  tax_rate: number;
  /** Base gravable de este impuesto (lo que queda de las líneas que lo
   * llevan una vez extraído el impuesto). */
  base: number;
  amount: number;
}

export interface ComputedLine {
  subtotal: number;
  tax_type_code: string | null;
  tax_rate: number;
  tax_amount: number;
  taxable_base: number;
}

export interface OrderTotalsBreakdown {
  /** Bruto: suma de quantity * unit_price, con impuesto incluido y sin
   * descontar nada. */
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  /** Suma de las bases gravables -- también cubre las líneas sin
   * impuesto (ahí base = subtotal de la línea). */
  taxableBase: number;
  shipping: number;
  total: number;
  taxLines: OrderTaxLine[];
  /** Un elemento por ítem de entrada, en el mismo orden. */
  lines: ComputedLine[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeOrderTotals(
  items: TaxableItem[],
  shipping: number,
  taxEnabled: boolean,
): OrderTotalsBreakdown {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let taxableBase = 0;
  // Agrupado por impuesto + tarifa: una factura con productos al 19% y al
  // 5% tiene que discriminar las dos, no un "impuestos" único.
  const grouped = new Map<string, OrderTaxLine>();

  const lines = items.map((item) => {
    const gross = item.quantity * item.unit_price;
    const discount = item.discount_amount ?? 0;
    const lineSubtotal = gross - discount;
    subtotal += gross;
    discountTotal += discount;

    const rate = taxEnabled ? (item.tax_rate ?? 0) : 0;
    const typeCode = taxEnabled ? (item.tax_type_code ?? null) : null;
    const { taxAmount, taxableBase: lineBase } = taxEnabled
      ? computeLineTax(lineSubtotal, rate)
      : { taxAmount: 0, taxableBase: round2(lineSubtotal) };
    taxTotal += taxAmount;
    taxableBase += lineBase;

    if (rate > 0) {
      const key = `${typeCode ?? ""}:${rate}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.base = round2(existing.base + lineBase);
        existing.amount = round2(existing.amount + taxAmount);
      } else {
        grouped.set(key, { tax_type_code: typeCode, tax_rate: rate, base: lineBase, amount: taxAmount });
      }
    }

    return {
      subtotal: lineSubtotal,
      tax_type_code: typeCode,
      tax_rate: rate,
      tax_amount: taxAmount,
      taxable_base: lineBase,
    };
  });

  return {
    subtotal,
    discountTotal,
    taxTotal: round2(taxTotal),
    taxableBase: round2(taxableBase),
    shipping,
    total: subtotal - discountTotal + shipping,
    taxLines: Array.from(grouped.values()).sort((a, b) => b.tax_rate - a.tax_rate),
    lines,
  };
}

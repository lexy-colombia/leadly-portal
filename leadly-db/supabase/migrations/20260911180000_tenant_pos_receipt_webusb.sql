-- Impresión térmica directa por WebUSB (ESC/POS crudo), alternativa a
-- window.print()/ReceiptPrintPortal.tsx -- bug real encontrado en vivo
-- (2026-09-11, Barriles de la sexta): el diálogo de impresión del sistema
-- exige que el @page que le pedimos coincida EXACTO con el único "papel
-- definido por el usuario" que tiene registrado el driver de su Epson
-- TM-T20 (80x160mm fijo, vía APD5) -- probamos alto dinámico por
-- contenido y alto fijo igual al registrado, y en ambos casos el ticket
-- terminaba cortado (a veces por abajo, a veces por el costado, según qué
-- tan cerca quedara la coincidencia). WebUSB con comandos ESC/POS crudos
-- evita el problema de raíz: no hay diálogo de impresión ni negociación
-- de tamaño de papel, se le manda a la impresora exactamente los bytes
-- que tiene que imprimir.
alter table public.tenants
  add column pos_receipt_use_webusb boolean not null default false;

comment on column public.tenants.pos_receipt_use_webusb is 'Si true, el ticket del POS se imprime enviando comandos ESC/POS crudos directo a la impresora por WebUSB (ver lib/receiptEscPos.ts + lib/webUsbPrinter.ts en leadly-app), en vez de window.print(). Requiere que el navegador soporte WebUSB (Chrome/Edge, no Safari/Firefox) y que el cajero haya emparejado la impresora una vez desde Configuración > Documentos y tickets. Default false: no rompe el flujo actual de ningún otro tenant.';

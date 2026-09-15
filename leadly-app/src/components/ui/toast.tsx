import {
  CheckCircle2Icon,
  CircleAlertIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type ToastVariant = "success" | "error" | "info";
export type Position =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  position?: Position;
}

const VARIANT_ICON = {
  success: CheckCircle2Icon,
  error: CircleAlertIcon,
  info: InfoIcon,
} as const;

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-destructive/30 bg-red-50 text-destructive",
  info: "border-border bg-background text-foreground",
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-emerald-600",
  error: "text-destructive",
  info: "text-muted-foreground",
};

const DEFAULT_POSITION: Position = "bottom-right";
const POSITION_CLASS: Record<Position, string> = {
  "top-left": "left-0 top-0 items-start",
  "top-center": "inset-x-0 top-0 items-center",
  "top-right": "right-0 top-0 items-end",
  "bottom-left": "left-0 bottom-0 items-start",
  "bottom-center": "inset-x-0 bottom-0 items-center",
  "bottom-right": "right-0 bottom-0 items-end",
};

function ToastBubble({
  item,
  onDismiss,
  dismissLabel,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  const Icon = VARIANT_ICON[item.variant];
  return (
    <div
      // `alert`/`assertive` solo para el error: un éxito no debería
      // interrumpir lo que esté leyendo un lector de pantalla.
      role={item.variant === "error" ? "alert" : "status"}
      aria-live={item.variant === "error" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border p-3 shadow-lg",
        "animate-in fade-in slide-in-from-bottom-2 duration-200",
        VARIANT_CLASS[item.variant],
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          VARIANT_ICON_CLASS[item.variant],
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{item.title}</p>
        {item.description && (
          <p className="mt-0.5 text-xs opacity-80">{item.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label={dismissLabel}
        className="-m-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function Toaster({
  toasts,
  onDismiss,
  dismissLabel,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  /** Etiqueta accesible del botón de cerrar -- viene traducida del
   * provider, este componente no habla con el contexto de idioma. */
  dismissLabel: string;
}) {
  if (toasts.length === 0) return null;

  const groups = new Map<Position, ToastItem[]>();
  for (const item of toasts) {
    const position = item.position ?? DEFAULT_POSITION;
    const group = groups.get(position);
    if (group) {
      group.push(item);
    } else {
      groups.set(position, [item]);
    }
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-100 flex flex-col items-center gap-2 p-4 sm:hidden">
        {toasts.map((item) => (
          <ToastBubble
            key={item.id}
            item={item}
            onDismiss={onDismiss}
            dismissLabel={dismissLabel}
          />
        ))}
      </div>

      {Array.from(groups.entries()).map(([position, items]) => (
        <div
          key={position}
          className={cn(
            "pointer-events-none fixed z-100 hidden flex-col gap-2 p-4 sm:flex",
            POSITION_CLASS[position],
          )}
        >
          {items.map((item) => (
            <ToastBubble
              key={item.id}
              item={item}
              onDismiss={onDismiss}
              dismissLabel={dismissLabel}
            />
          ))}
        </div>
      ))}
    </>
  );
}

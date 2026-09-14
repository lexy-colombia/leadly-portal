import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Toaster,
  type Position,
  type ToastItem,
  type ToastVariant,
} from "../components/ui/toast";
import { useLanguage } from "./LanguageContext";

interface ShowToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  position?: Position;
}

interface ToastContextValue {
  toast: (options: ShowToastOptions) => string;
  success: (
    title: string,
    options?: Omit<ShowToastOptions, "variant" | "title">,
  ) => string;
  error: (
    title: string,
    options?: Omit<ShowToastOptions, "variant" | "title">,
  ) => string;
  info: (
    title: string,
    options?: Omit<ShowToastOptions, "variant" | "title">,
  ) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/** Un error se queda más tiempo que un éxito: el éxito solo confirma algo
 * que el usuario acaba de hacer a propósito, el error tiene contenido que
 * hay que leer. */
const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 3500,
  info: 4500,
  error: 7000,
};
/** Más de esto en pantalla a la vez no se alcanza a leer -- entra el nuevo
 * y se va el más viejo. */
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Los timers viven en un ref (no en estado) para poder limpiarlos al
  // desmontar sin que cada alta/baja dispare un render extra.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({
      title,
      description,
      variant = "info",
      durationMs,
      position,
    }: ShowToastOptions) => {
      const id = crypto.randomUUID();
      setToasts((current) =>
        [...current, { id, title, description, variant, position }].slice(
          -MAX_VISIBLE,
        ),
      );
      const duration = durationMs ?? DEFAULT_DURATION_MS[variant];
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            setToasts((current) => current.filter((item) => item.id !== id));
          }, duration),
        );
      }
      return id;
    },
    [],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      success: (title, props) => toast({ title, variant: "success", ...props }),
      error: (title, props) => toast({ title, variant: "error", ...props }),
      info: (title, props) => toast({ title, variant: "info", ...props }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        toasts={toasts}
        onDismiss={dismiss}
        dismissLabel={t("common.actions.close")}
      />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

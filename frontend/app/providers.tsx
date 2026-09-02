"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ThemeCtx {
  resolvedTheme: string;
  setTheme: (t: string) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  resolvedTheme: "light",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

// Lightweight toast — replaces window.alert() for error/status messages.
// Native alert() blocks the tab (including browser automation), so any
// non-blocking notification goes through here instead.
type ToastVariant = "error" | "info";
interface ToastItem { id: number; message: string; variant: ToastVariant }
interface ToastCtx { showToast: (message: string, variant?: ToastVariant) => void }

const ToastContext = createContext<ToastCtx>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`flex items-start gap-2 px-3.5 py-2.5 rounded-lg shadow-lg text-sm text-white ${
            t.variant === "error" ? "bg-red-600" : "bg-gray-800"
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="opacity-70 hover:opacity-100 shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState("light");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  // Read persisted preference after mount (avoids SSR mismatch)
  useEffect(() => {
    const stored = localStorage.getItem("sb-theme") ?? "light";
    setThemeState(stored);
    document.documentElement.classList.toggle("dark", stored === "dark");
  }, []);

  function setTheme(next: string) {
    setThemeState(next);
    localStorage.setItem("sb-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, variant: ToastVariant = "error") => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => dismissToast(id), 5000);
  }, [dismissToast]);

  return (
    <ThemeContext.Provider value={{ resolvedTheme: theme, setTheme }}>
      <ToastContext.Provider value={{ showToast }}>
        {children}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}

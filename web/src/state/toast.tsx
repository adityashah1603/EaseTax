// Toasts confirm what happened and offer Undo (a compensating event, design §7.2).
import clsx from 'clsx';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { errorText } from '../api/client';

interface Toast {
  id: number;
  text: string;
  detail?: string;
  tone: 'ok' | 'error' | 'info';
  undo?: () => Promise<unknown>;
}

interface ToastApi {
  push: (t: Omit<Toast, 'id'>) => void;
  error: (e: unknown, prefix?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = next.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.undo ? 12_000 : t.tone === 'error' ? 10_000 : 5_000);
    },
    [dismiss],
  );
  const error = useCallback(
    (e: unknown, prefix?: string) => {
      const { message, rule } = errorText(e);
      push({ tone: 'error', text: prefix ? `${prefix}: ${message}` : message, detail: rule && rule !== message ? `Firm rule: ${rule}` : undefined });
    },
    [push],
  );
  return (
    <Ctx.Provider value={{ push, error }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-[min(520px,92vw)] -translate-x-1/2 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-lg',
              t.tone === 'error' ? 'border-pencil bg-pencil-soft text-pencil-ink' : 'border-ink bg-ink text-white',
            )}
          >
            <div className="flex-1">
              <div>{t.text}</div>
              {t.detail && <div className="mt-0.5 text-xs opacity-80">{t.detail}</div>}
            </div>
            {t.undo && (
              <button
                className="font-semibold underline underline-offset-2"
                onClick={async () => {
                  dismiss(t.id);
                  try {
                    await t.undo!();
                    push({ tone: 'info', text: 'Undone. The undo is recorded in the history.' });
                  } catch (e) {
                    error(e, 'Undo failed');
                  }
                }}
              >
                Undo
              </button>
            )}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="opacity-70 hover:opacity-100">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const t = useContext(Ctx);
  if (!t) throw new Error('ToastProvider missing');
  return t;
}

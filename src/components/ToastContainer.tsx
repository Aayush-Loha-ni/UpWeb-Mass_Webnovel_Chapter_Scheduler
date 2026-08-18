import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X, RefreshCw } from 'lucide-react';
import { useUI } from '../context/UIContext';

export interface Toast {
  id: number;
  platform: 'inkstone' | 'patreon' | 'kofi';
  message: string;
  timestamp: string;
}

export default function ToastContainer() {
  const { toasts, dismissToast, toastReconnect, toastAbort } = useUI();
  return (
    <div role="alert" aria-live="assertive" aria-label="Notifications" className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={dismissToast} onReconnect={toastReconnect} onAbort={toastAbort} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast, onDismiss, onReconnect, onAbort }: { toast: Toast; onDismiss: (id: number) => void; onReconnect: ((platform: 'inkstone' | 'patreon' | 'kofi') => void) | null; onAbort: (() => void) | null }) {
  const platformLabel = toast.platform === 'inkstone' ? 'Webnovel/Inkstone' : toast.platform === 'patreon' ? 'Patreon' : 'Ko-fi';

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 10000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="pointer-events-auto bg-[#1a1f2e] border border-amber-500/30 rounded-xl p-3 shadow-2xl font-mono text-xs"
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 h-6 w-6 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
          <AlertTriangle size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold">{platformLabel} Session Expired</p>
          <p className="text-slate-300 mt-1 leading-relaxed">{toast.message}</p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onReconnect?.(toast.platform)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[10px] font-semibold uppercase tracking-wider transition-all cursor-pointer"
            >
              <RefreshCw size={10} />
              Reconnect
            </button>
            <button
              onClick={() => onAbort?.()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] font-semibold uppercase tracking-wider transition-all cursor-pointer"
            >
              <X size={10} />
              Abort
            </button>
          </div>
        </div>
        <button
          onClick={() => onDismiss(toast.id)}
          className="shrink-0 h-5 w-5 flex items-center justify-center rounded hover:bg-slate-700/50 text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>
    </motion.div>
  );
}

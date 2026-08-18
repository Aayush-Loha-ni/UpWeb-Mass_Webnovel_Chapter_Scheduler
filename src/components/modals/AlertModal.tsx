import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, AlertTriangle, FileText } from 'lucide-react';
import { useUI } from '../../context/UIContext';

export default function AlertModal() {
  const { modalAlert, dismissAlert } = useUI();
  const alert = modalAlert;
  const onClose = dismissAlert;
  return (
    <AnimatePresence>
      {alert && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={alert.type === 'success' ? 'Success' : alert.type === 'error' ? 'Error' : 'Info'}
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            className="bg-[#131722] border border-slate-800 rounded-xl p-6 max-w-sm w-full shadow-2xl font-mono text-xs text-center"
          >
            <div className="flex justify-center mb-3">
              {alert.type === 'success' ? (
                <div className="h-10 w-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <Check size={20} />
                </div>
              ) : alert.type === 'error' ? (
                <div className="h-10 w-10 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
                  <AlertTriangle size={20} />
                </div>
              ) : (
                <div className="h-10 w-10 rounded-full bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400">
                  <FileText size={20} />
                </div>
              )}
            </div>
            <p className="text-sm font-semibold text-slate-200 mb-4">{alert.message}</p>
            <button
              onClick={onClose}
              className="w-full py-2 rounded bg-slate-800 hover:bg-[#00f2fe] hover:text-[#0f1117] font-bold transition-all cursor-pointer text-[11px] uppercase tracking-wider"
            >
              Acknowledge
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

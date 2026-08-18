import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { useUI } from '../../context/UIContext';

export default function ConfirmModal() {
  const { modalConfirm, setModalConfirm } = useUI();
  const confirm = modalConfirm;
  const onClose = () => setModalConfirm(null);
  return (
    <AnimatePresence>
      {confirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[90] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 15 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 15 }}
            className="bg-[#131722] border border-rose-500/30 rounded-xl p-6 max-w-md w-full shadow-2xl font-mono text-xs"
          >
            <div className="flex items-start gap-4 mb-4">
              <div className="h-10 w-10 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-1">
                  {confirm.title || 'Are you sure?'}
                </h3>
                <p className="text-slate-400 font-sans leading-relaxed text-xs">
                  {confirm.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const cb = confirm.onConfirm;
                  onClose();
                  cb();
                }}
                className="px-4 py-2 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider shadow-lg shadow-rose-900/20"
              >
                Proceed
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

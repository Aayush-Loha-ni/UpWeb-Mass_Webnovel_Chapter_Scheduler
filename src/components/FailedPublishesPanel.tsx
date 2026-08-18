import React from 'react';
import { AlertTriangle, RefreshCw, Undo2, X } from 'lucide-react';

interface FailedPublishesPanelProps {
  failed: { chapter_number: number; error?: string; platform?: string }[];
  onRetryAll: () => void;
  onDismiss: () => void;
  onRollback?: () => void;
  rollbackLoading?: boolean;
}

export default function FailedPublishesPanel({ failed, onRetryAll, onDismiss, onRollback, rollbackLoading }: FailedPublishesPanelProps) {
  if (failed.length === 0) return null;

  return (
    <div className="bg-rose-950/20 border border-rose-800/40 rounded-xl p-4 mb-6 relative">
      <button
        onClick={onDismiss}
        className="absolute top-2 right-2 text-rose-400/60 hover:text-rose-400 cursor-pointer"
      >
        <X size={14} />
      </button>
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-rose-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-mono font-bold text-rose-400 uppercase tracking-wider mb-1">
            {failed.length} Failed Publishes
          </h3>
          <div className="space-y-1 mb-3">
            {failed.map(f => (
              <div key={f.chapter_number} className="text-[10px] font-mono text-rose-300/80">
                Ch #{f.chapter_number}{f.platform ? ` (${f.platform})` : ''}: {f.error || 'Unknown error'}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onRetryAll}
              className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <RefreshCw size={11} /> Retry All Failed
            </button>
            {onRollback && (
              <button
                onClick={onRollback}
                disabled={rollbackLoading}
                className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              >
                <Undo2 size={11} /> {rollbackLoading ? 'Rolling back...' : 'Rollback Published'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
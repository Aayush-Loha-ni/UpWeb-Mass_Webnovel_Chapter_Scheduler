import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trash2 } from 'lucide-react';

interface PlanItem { number: number; title: string; id: string }
interface PlanEntry { strategy: string; items: PlanItem[] }

interface CleanupPreviewModalProps {
  plan: { platform: string; plan: PlanEntry[] } | null;
  exclude: Set<number>;
  onToggleExclude: (num: number) => void;
  onSelectAll: (nums: number[], selected: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

const platformColors: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  inkstone: { border: 'border-rose-500/30', bg: 'bg-rose-500/10', text: 'text-rose-400', dot: 'bg-rose-500' },
  patreon: { border: 'border-purple-500/30', bg: 'bg-purple-500/10', text: 'text-purple-400', dot: 'bg-purple-500' },
  kofi: { border: 'border-blue-500/30', bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-500' },
};

export default function CleanupPreviewModal({ plan, exclude, onToggleExclude, onSelectAll, onConfirm, onCancel, loading }: CleanupPreviewModalProps) {
  const platform = plan?.platform || 'inkstone';
  const entries = plan?.plan || [];
  const totalItems = entries.reduce((a, p) => a + p.items.length, 0);
  const toDelete = totalItems - exclude.size;
  const colors = platformColors[platform] || platformColors.inkstone;

  return (
    <AnimatePresence>
      {plan && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[90] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 15 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 15 }}
            className="bg-[#131722] border border-gray-700/50 rounded-xl p-6 max-w-2xl w-full shadow-2xl font-mono text-xs max-h-[85vh] flex flex-col"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className={`h-8 w-8 rounded-full ${colors.bg} border ${colors.border} flex items-center justify-center ${colors.text} shrink-0`}>
                <Trash2 size={16} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                  Cleanup Preview — {platform}
                </h3>
                <p className="text-slate-500 text-[10px]">
                  {toDelete} of {totalItems} item{totalItems !== 1 ? 's' : ''} selected for deletion
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
              {entries.map((entry) => (
                <div key={entry.strategy} className="bg-[#1a1f2e] rounded-lg p-3 border border-gray-800">
                  <div className="flex items-center gap-2 text-slate-300 font-bold mb-2 uppercase tracking-wider text-[10px]">
                    <input
                      type="checkbox"
                      checked={entry.items.every(item => !exclude.has(item.number))}
                      onChange={(e) => onSelectAll(entry.items.map(i => i.number), e.target.checked)}
                      className="accent-rose-500 cursor-pointer"
                    />
                    <span className={`h-2 w-2 rounded-full ${colors.dot}`} />
                    {entry.strategy.replace(/-/g, ' ')} — {entry.items.length}
                  </div>
                  <div className="space-y-1 ml-4">
                    {entry.items.length === 0 ? (
                      <p className="text-slate-500 text-[10px]">None</p>
                    ) : (
                      entry.items.map((item) => {
                        const exc = exclude.has(item.number);
                        return (
                          <label
                            key={`${item.number}-${item.id}`}
                            className={`flex items-center gap-3 px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
                              exc ? 'bg-slate-800/30 opacity-50' : 'hover:bg-slate-800/50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={!exc}
                              onChange={() => onToggleExclude(item.number)}
                              className="accent-rose-500 cursor-pointer"
                            />
                            <span className={exc ? 'text-slate-600 line-through' : 'text-slate-200'}>
                              Ch {item.number}
                              {item.title ? <span className="text-slate-500 ml-2">— {item.title}</span> : null}
                            </span>
                            <span className="text-slate-600 ml-auto text-[9px] truncate max-w-[120px]">{item.id}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3 pt-4 mt-2 border-t border-gray-800">
              <button
                onClick={onCancel}
                disabled={loading}
                className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={toDelete === 0 || loading}
                className={`px-4 py-2 rounded text-white font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider shadow-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                  toDelete > 0 ? `${colors.bg} ${colors.text} border ${colors.border} hover:opacity-80` : 'bg-slate-800 text-slate-600'
                }`}
              >
                {loading ? 'Cleaning...' : toDelete === 0 ? 'Nothing to Delete' : `Delete ${toDelete} item${toDelete !== 1 ? 's' : ''}`}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

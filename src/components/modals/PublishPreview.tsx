import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, CheckCircle, XCircle, Calendar, ArrowRight } from 'lucide-react';

interface PublishPlan {
  ok: boolean;
  plan: {
    platform: string;
    chapters: { chapter_number: number; title: string; scheduled_date: string }[];
  }[];
  gaps: { platform: string; missing: number[] }[];
  conflicts: { type: string; detail: string }[];
  warnings: string[];
  lead: { current: number; target: number };
  backfill?: {
    platform: string;
    chaptersToDelete: number[];
    rescheduledChapters: { chapter_number: number; title: string; scheduled_date: string }[];
  }[];
  tracker_stuck?: boolean;
}

interface PublishPreviewProps {
  plan: PublishPlan | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PublishPreview({ plan, loading, onConfirm, onCancel }: PublishPreviewProps) {
  const totalChapters = plan?.plan?.reduce((sum, p) => sum + p.chapters.length, 0) ?? 0;
  const hasAnythingToDo = totalChapters > 0 || (plan?.backfill?.length ?? 0) > 0;

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
              <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${plan.ok ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'}`}>
                {plan.ok ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                  Publish Preview
                </h3>
                <p className="text-slate-500 text-[10px]">
                  {plan.ok ? 'Plan looks good. Review and confirm to execute.' : 'Conflicts found — publishing is blocked.'}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
              {/* Tracker stuck warning */}
              {plan.tracker_stuck && (
                <div className="bg-rose-950/20 border border-rose-500/30 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-rose-400 font-bold mb-2">
                    <AlertTriangle size={12} /> Tracker Status Warning
                  </div>
                  <p className="text-rose-300 text-[10px] ml-5">
                    Tracker is stuck in 'running' from a previous run. Publishing may be blocked until resolved.
                  </p>
                </div>
              )}

              {/* Lead status */}
              <div className="bg-[#1a1f2e] rounded-lg p-3 border border-gray-800">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">{plan.plan[0]?.platform ?? 'Lead'} Lead</span>
                  <span className={`font-bold ${plan.lead.current > plan.lead.target ? 'text-rose-400' : plan.lead.current === plan.lead.target ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {plan.lead.current} / {plan.lead.target}
                  </span>
                </div>
              </div>

              {/* Conflicts */}
              {plan.conflicts.length > 0 && (
                <div className="bg-rose-950/20 border border-rose-500/30 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-rose-400 font-bold mb-2">
                    <XCircle size={12} /> Conflicts
                  </div>
                  {plan.conflicts.map((c, i) => (
                    <p key={i} className="text-rose-300 text-[10px] ml-5">{c.detail}</p>
                  ))}
                </div>
              )}

              {/* Warnings */}
              {plan.warnings.length > 0 && (
                <div className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-amber-400 font-bold mb-2">
                    <AlertTriangle size={12} /> Warnings
                  </div>
                  {plan.warnings.map((w, i) => (
                    <p key={i} className="text-amber-300 text-[10px] ml-5">{w}</p>
                  ))}
                </div>
              )}

              {/* Nothing to publish */}
              {!hasAnythingToDo && (
                <div className="bg-slate-950/20 border border-slate-500/30 rounded-lg p-3">
                  <p className="text-slate-400 text-[10px] text-center">
                    No chapters to publish or backfill. All caught up.
                  </p>
                </div>
              )}

              {/* Platform plans */}
              {plan.plan.map((p) => (
                <div key={p.platform} className="bg-[#1a1f2e] rounded-lg p-3 border border-gray-800">
                  <div className="flex items-center gap-2 text-slate-300 font-bold mb-2 uppercase tracking-wider text-[10px]">
                    <Calendar size={12} className="text-[#00f2fe]" /> {p.platform} — {p.chapters.length} chapter(s)
                  </div>
                  {p.chapters.length === 0 ? (
                    <p className="text-slate-500 text-[10px] ml-5">No chapters to schedule.</p>
                  ) : (
                    <div className="space-y-1 ml-5">
                      {p.chapters.map((ch) => (
                        <div key={ch.chapter_number} className="flex items-center justify-between text-[10px]">
                          <span className="text-slate-300">Ch {ch.chapter_number}</span>
                          <ArrowRight size={10} className="text-slate-600 mx-1" />
                          <span className="text-slate-400 truncate max-w-[200px]">{ch.title}</span>
                          <ArrowRight size={10} className="text-slate-600 mx-1" />
                          <span className="text-[#00f2fe] font-bold">{formatDate(ch.scheduled_date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Gaps */}
              {plan.gaps.length > 0 && (
                <div className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-amber-400 font-bold mb-2">
                    <AlertTriangle size={12} /> Gaps Detected
                  </div>
                  {plan.gaps.map((g, i) => (
                    <p key={i} className="text-amber-300 text-[10px] ml-5">
                      {g.platform}: Missing chapters {g.missing.join(', ')}
                    </p>
                  ))}
                </div>
              )}

              {/* Backfill */}
              {plan.backfill && plan.backfill.length > 0 && (
                <div className="bg-blue-950/20 border border-blue-500/30 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-blue-400 font-bold mb-2">
                    <Calendar size={12} /> Backfill Required
                  </div>
                  {plan.backfill.map((bf, i) => (
                    <div key={i} className="ml-5 mb-2">
                      <p className="text-blue-300 text-[10px] mb-1">
                        {bf.platform}: Deleting {bf.chaptersToDelete.length} conflicting chapter(s) to make room for gaps.
                      </p>
                      <p className="text-slate-400 text-[10px]">
                        Chapters to delete: {bf.chaptersToDelete.join(', ')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
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
                disabled={!plan.ok || !hasAnythingToDo || loading}
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider shadow-lg shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                title={!hasAnythingToDo ? 'Nothing to publish' : !plan.ok ? 'Conflicts must be resolved first' : ''}
              >
                {loading ? 'Publishing...' : !hasAnythingToDo ? 'Nothing to Do' : 'Confirm & Publish'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

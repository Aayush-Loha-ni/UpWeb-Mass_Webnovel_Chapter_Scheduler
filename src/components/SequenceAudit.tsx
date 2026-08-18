import React from 'react';
import { BarChart3, Check, AlertTriangle, RefreshCw, Play, Loader2 } from 'lucide-react';
import { SequenceAudit as SequenceAuditType, ProgressInfo } from '../types';

interface SequenceAuditProps {
  inkstone: SequenceAuditType | null;
  patreon: SequenceAuditType | null;
  kofi?: SequenceAuditType | null;
  check: any;
  isRunning: boolean;
  progress: ProgressInfo | null;
  onRefresh: () => void;
  onResequence: () => void;
}

export default function SequenceAudit({ inkstone, patreon, kofi, check, isRunning, progress, onRefresh, onResequence }: SequenceAuditProps) {
  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider mb-4 flex items-center gap-2">
        <BarChart3 size={14} className="text-[#00f2fe]" /> Schedule Check
      </h2>
      <div className="space-y-3">
        {(['inkstone', 'patreon', 'kofi'] as const).map(platform => {
          const audit = platform === 'inkstone' ? inkstone : platform === 'patreon' ? patreon : kofi;
          return (
            <div key={platform} className="text-xs font-mono">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-slate-400 capitalize">{platform === 'kofi' ? 'Ko-fi' : platform}:</span>
                {!audit ? (
                  <span className="text-slate-600">—</span>
                ) : audit.ok ? (
                  <span className="text-emerald-400 font-bold flex items-center gap-1">
                    <Check size={12} /> Sequential
                  </span>
                ) : (
                  <span className="text-rose-400 font-bold flex items-center gap-1">
                    <AlertTriangle size={12} /> {audit.missing.length} gap{audit.missing.length !== 1 ? 's' : ''}, {audit.mismatches.length} date{audit.mismatches.length !== 1 ? 's' : ''}, {audit.duplicates.length} dup
                  </span>
                )}
              </div>
              {audit && !audit.ok && (
                <div className="ml-4 space-y-0.5 text-slate-500">
                  {audit.missing.length > 0 && (
                    <div className="text-amber-400">Gaps: #{audit.missing.join(', #')}</div>
                  )}
                  {audit.mismatches.length > 0 && audit.mismatches.slice(0, 5).map(m => (
                    <div key={m.chapter_number} className="text-slate-400">
                      Ch {m.chapter_number}: {m.actual_date?.slice(0,10) || 'none'} → {m.expected_date.slice(0,10)}
                    </div>
                  ))}
                  {audit.mismatches.length > 5 && (
                    <div className="text-slate-600">+{audit.mismatches.length - 5} more date mismatches</div>
                  )}
                  {audit.duplicates.length > 0 && (
                    <div className="text-rose-400">Duplicates: #{audit.duplicates.join(', #')}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={onRefresh}
          className="flex-1 py-1.5 px-3 rounded-lg text-xs font-mono font-bold bg-gray-800 hover:bg-gray-700 text-slate-300 transition-all flex items-center justify-center gap-1.5"
        >
          <RefreshCw size={12} /> Refresh
        </button>
        <button
          onClick={onResequence}
          disabled={isRunning}
          className="flex-1 py-1.5 px-3 rounded-lg text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] hover:from-[#00d4df] hover:to-[#3a9cf5] text-black disabled:opacity-50 transition-all flex items-center justify-center gap-1.5"
        >
          {isRunning && progress ? <>{progress.percent}% — {progress.label}</> : isRunning ? <><Loader2 size={12} className="animate-spin" /> Running...</> : <><Play size={12} /> Resequence</>}
        </button>
      </div>
    </div>
  );
}

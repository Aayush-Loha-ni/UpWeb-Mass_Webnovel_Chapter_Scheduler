import React from 'react';
import { Activity } from 'lucide-react';
import { NovelDetail } from '../types';

interface PlatformSummaryProps {
  novel: NovelDetail | null;
  showEdit: boolean;
  onToggleEdit: () => void;
  onSaveTracker: (e: React.FormEvent<HTMLFormElement>) => void;
  triggerAlert?: (msg: string, type?: string) => void;
}

export default function PlatformSummary({ novel, showEdit, onToggleEdit, onSaveTracker }: PlatformSummaryProps) {
  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider flex items-center gap-2">
          <Activity size={14} className="text-[#00f2fe]" /> Sync Status
        </h2>
        {novel && (
          <button
            onClick={onToggleEdit}
            className="px-2 py-1 rounded bg-[#1e293b] hover:bg-[#1e293b]/80 border border-slate-700 text-[10px] font-mono font-bold text-slate-300 flex items-center gap-1 transition-all cursor-pointer"
          >
            {showEdit ? 'Cancel' : 'Edit'}
          </button>
        )}
      </div>

      {novel ? (
        showEdit ? (
          <form onSubmit={onSaveTracker} className="flex flex-col gap-3 font-mono text-xs">
            <div className="bg-[#1e293b]/20 border border-gray-800/60 rounded p-3 text-[10px] text-slate-400">
              Manually set your publishing progress. Useful for testing.
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Published on Webnovel</label>
                <input
                  type="number"
                  name="webnovel_last"
                  defaultValue={novel.tracker?.webnovel_last ?? 0}
                  className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Published on Patreon</label>
                <input
                  type="number"
                  name="patreon_last"
                  defaultValue={novel.tracker?.patreon_last ?? 0}
                  className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
                  required
                />
              </div>
            </div>

            {novel.config?.kofi_enabled && (
              <div>
                <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Published on Ko-fi</label>
                <input
                  type="number"
                  name="kofi_last"
                  defaultValue={novel.tracker?.kofi_last ?? 0}
                  className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
                  required
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Scheduled for Webnovel</label>
                <input
                  type="number"
                  name="inkstone_scheduled_count"
                  defaultValue={novel.tracker?.inkstone_scheduled_count ?? 0}
                  className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Scheduled for Patreon</label>
                <input
                  type="number"
                  name="patreon_scheduled_count"
                  defaultValue={novel.tracker?.patreon_scheduled_count ?? 0}
                  className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Next Schedule Date</label>
              <input
                type="date"
                name="next_schedule_date"
                defaultValue={novel.tracker?.next_schedule_date ?? ''}
                className="w-full px-2.5 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>

            <button
              type="submit"
              className="w-full mt-2 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-[#0f1117] font-bold transition-all text-center cursor-pointer font-mono"
            >
              Save Progress
            </button>
          </form>
        ) : (
          <div className="space-y-3 font-mono text-xs">
            <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
              <span className="text-slate-400">Available:</span>
              <span className="text-slate-200 font-bold">
                {novel.chapters ? [...new Set(novel.chapters.map(c => Math.floor(c.chapter_number)))].length : 0} chapters ({
                  novel.chapters && novel.chapters.length > 0
                    ? `#${Math.max(...novel.chapters.map(c => Math.floor(c.chapter_number)))}`
                    : 'None'
                })
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
              <span className="text-slate-400">Published on Webnovel:</span>
              <span className="text-[#00f2fe] font-bold">
                {novel.tracker?.webnovel_last ?? 0} chapters
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
              <span className="text-slate-400">Published on Patreon:</span>
              <span className="text-emerald-400 font-bold">
                {novel.tracker?.patreon_last ?? 0} chapters
              </span>
            </div>

            {novel.config?.kofi_enabled && (
              <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
                <span className="text-slate-400">Published on Ko-fi:</span>
                <span className="text-pink-400 font-bold">
                  {novel.tracker?.kofi_last ?? 0} chapters
                </span>
              </div>
            )}

            <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
              <span className="text-slate-400">Scheduled for Webnovel:</span>
              <span className="text-indigo-400 font-bold">
                {(novel.tracker?.inkstone_scheduled_count ?? 0)} drafts (up to #{(novel.tracker?.inkstone_scheduled?.length ?? 0) > 0 ? Math.max(...novel.tracker.inkstone_scheduled.map((s: any) => s.chapter_number)) : 0})
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
              <span className="text-slate-400">Scheduled for Patreon:</span>
              <span className="text-purple-400 font-bold">
                {(novel.tracker?.patreon_scheduled_count ?? 0)} posts (up to #{(novel.tracker?.patreon_scheduled?.length ?? 0) ? Math.max(...novel.tracker.patreon_scheduled.map((s: any) => s.chapter_number)) : 0})
              </span>
            </div>

            {novel.config?.kofi_enabled && (
              <div className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
                <span className="text-slate-400">Scheduled for Ko-fi:</span>
                <span className="text-pink-400 font-bold">
                  {(novel.tracker?.kofi_scheduled?.length ?? 0)} posts (up to #{(novel.tracker?.kofi_scheduled?.length ?? 0) ? Math.max(...(novel.tracker?.kofi_scheduled ?? []).map((s: any) => s.chapter_number)) : 0})
                </span>
              </div>
            )}

            <div className="flex justify-between items-center py-1.5">
              <span className="text-slate-400">Next Webnovel:</span>
              <span className="text-amber-400 font-bold">
                {(novel as any)?.next_inkstone_schedule
                  ? new Date((novel as any).next_inkstone_schedule).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-slate-400">Next Patreon:</span>
              <span className="text-amber-400 font-bold">
                {(novel as any)?.next_patreon_schedule
                  ? new Date((novel as any).next_patreon_schedule).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'N/A'}
              </span>
            </div>
            {novel.config?.kofi_enabled && (
              <div className="flex justify-between items-center py-1.5">
                <span className="text-slate-400">Next Ko-fi:</span>
                <span className="text-amber-400 font-bold">
                  {(novel as any)?.next_kofi_schedule
                    ? new Date((novel as any).next_kofi_schedule).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'N/A'}
                </span>
              </div>
            )}

            {novel?.chapters && novel.chapters.length > 0 && (
              (() => {
                // ponytail: Math.floor maps decimal sub-chapters (5.1, 5.2) to base chapter (5)
                const bases = [...new Set(novel.chapters.map(c => Math.floor(c.chapter_number)))].sort((a, b) => a - b);
                const missing: number[] = [];
                for (let i = bases[0]; i <= bases[bases.length - 1]; i++) {
                  if (!bases.includes(i) && i > 0) missing.push(i);
                }
                const clean = bases[0] === 1 && missing.length === 0;
                return (
                  <div className="flex justify-between items-center py-1.5 border-t border-gray-800/60">
                    <span className="text-slate-400">Sequence:</span>
                    <span className={`font-bold ${clean ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {clean ? '✓ Sequential' : missing.length > 0 ? `Missing: #${missing.join(', #')}` : `Starts at #${bases[0]}`}
                    </span>
                  </div>
                );
              })()
            )}
          </div>
        )
      ) : (
        <p className="text-xs text-slate-500 italic font-mono text-center">No active novel selected.</p>
      )}
    </div>
  );
}

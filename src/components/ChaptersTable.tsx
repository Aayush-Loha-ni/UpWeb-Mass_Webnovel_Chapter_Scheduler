import React, { useState } from 'react';
import {
  FileText, UploadCloud, Plus, Check, Calendar, Lock, Unlock, Trash2, FileCode, AlertTriangle, ChevronDown, ChevronUp, Send
} from 'lucide-react';
import { Chapter, SequenceCheck } from '../types';

interface PublishTracker {
  webnovel_last?: number;
  patreon_last?: number;
  kofi_last?: number;
  inkstone_scheduled_count?: number;
  patreon_scheduled_count?: number;
  execution_status?: string;
}

interface NovelConfig {
  target_lead?: number;
  patreon_enabled?: boolean;
  kofi_enabled?: boolean;
}

interface ChaptersTableProps {
  chapters: Chapter[] | undefined;
  selected: Set<number>;
  onSelect: (selected: Set<number>) => void;
  onToggleLock: (num: number, locked: boolean) => void;
  onDelete: (num: number) => void;
  onEdit: (num: number) => void;
  onBatchDelete: () => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAddChapter: () => void;
  onUpdatePlatform?: (num: number) => void;
  onPublishSingle?: (num: number) => void;
  slug: string;
  tracker?: PublishTracker | null;
  config?: NovelConfig | null;
  sequenceCheck?: SequenceCheck | null;
  onShowConfirm?: (confirm: { title?: string; message: string; onConfirm: () => void }) => void;
}

export default function ChaptersTable({
  chapters, selected, onSelect, onToggleLock, onDelete, onEdit,
  onBatchDelete, onUpload, onAddChapter, onUpdatePlatform, onPublishSingle, slug, tracker, config, sequenceCheck, onShowConfirm
}: ChaptersTableProps) {
  const confirm = onShowConfirm || ((_c: { title?: string; message: string; onConfirm: () => void }) => {});
  const [expanded, setExpanded] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const INITIAL_SHOW = 20;
  const displayChapters = chapters && (expanded ? chapters : chapters.slice(0, INITIAL_SHOW));
  const hiddenCount = chapters ? Math.max(0, chapters.length - INITIAL_SHOW) : 0;

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (!chapters) return;
    const ch = chapters[idx];
    if (!ch) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(idx + 1, (expanded ? chapters : displayChapters || chapters).length - 1);
      setFocusedIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex(Math.max(0, idx - 1));
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const n = new Set(selected);
      selected.has(ch.chapter_number) ? n.delete(ch.chapter_number) : n.add(ch.chapter_number);
      onSelect(n);
    }
  };

  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl flex-1 flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <div className="cursor-pointer select-none group" onClick={() => setExpanded(!expanded)}>
          <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider flex items-center gap-2">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            <FileText size={14} className="text-[#00f2fe]" /> Chapters
            {chapters && <span className="text-[10px] font-mono text-slate-400 font-normal">({chapters.length})</span>}
            <span className="text-[10px] text-slate-600 group-hover:text-[#00f2fe]/60 transition-colors">({expanded ? 'click to collapse' : 'click to expand'})</span>
          </h2>
          <p className="text-[10px] text-slate-500 font-mono mt-1">
            data/{slug}/chapters/
            {!expanded && hiddenCount > 0 && <span className="text-slate-600"> — showing {Math.min(INITIAL_SHOW, chapters?.length || 0)} of {chapters?.length}</span>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="cursor-pointer px-2.5 py-1.5 rounded bg-[#162a22] border border-emerald-500/30 hover:bg-emerald-500/20 text-[10px] font-mono font-bold text-emerald-400 flex items-center gap-1">
            <UploadCloud size={12} /> Upload File
            <input
              type="file"
              accept=".md,.txt,.docx,.doc,.rtf,.csv"
              multiple
              className="hidden"
              onChange={onUpload}
            />
          </label>

          <button
            onClick={onAddChapter}
            className="px-2.5 py-1.5 rounded bg-[#1e293b] border border-[#00f2fe]/30 hover:bg-[#00f2fe]/10 text-[10px] font-mono font-bold text-[#00f2fe] flex items-center gap-1 cursor-pointer"
          >
            <Plus size={12} /> New Chapter
          </button>
        </div>
      </div>

      <div className="border border-gray-800/80 rounded-lg overflow-hidden mb-4 flex-1">
        {selected.size > 0 && (
          <div className="flex items-center justify-between px-3 py-2 bg-rose-950/20 border-b border-rose-800/30">
            <span className="text-xs text-rose-300 font-mono">{selected.size} chapter(s) selected</span>
            <button
              onClick={() => confirm({
                title: 'Delete Selected Chapters',
                message: `Delete ${selected.size} chapter(s)? This cannot be undone.`,
                onConfirm: onBatchDelete,
              })}
              className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold cursor-pointer flex items-center gap-1"
            >
              <Trash2 size={11} /> Delete Selected
            </button>
          </div>
        )}

        <table className="w-full text-left border-collapse font-mono text-xs">
          <thead>
            <tr className="bg-[#171c2a] text-slate-400 border-b border-gray-800">
              <th className="py-2.5 px-3 w-8">
                <input
                  type="checkbox"
                  className="cursor-pointer accent-[#00f2fe]"
                  checked={chapters ? chapters.length > 0 && chapters.every(ch => selected.has(ch.chapter_number)) : false}
                  onChange={() => {
                    if (!chapters) return;
                    const all = chapters.every(ch => selected.has(ch.chapter_number));
                    onSelect(all ? new Set() : new Set(chapters.map(ch => ch.chapter_number)));
                  }}
                />
              </th>
              <th className="py-2.5 px-3 font-semibold text-[10px] uppercase">Ch</th>
              <th className="py-2.5 px-3 font-semibold text-[10px] uppercase">Title</th>
              <th className="py-2.5 px-3 font-semibold text-[10px] uppercase text-center">Webnovel</th>
              <th className="py-2.5 px-3 font-semibold text-[10px] uppercase text-center">Patreon</th>
              <th className="py-2.5 px-3 font-semibold text-[10px] uppercase text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {displayChapters && displayChapters.length > 0 ? (
              displayChapters.map((ch, idx) => {
                const wnLast = tracker?.webnovel_last || 0;
                const patreonLast = tracker?.patreon_last || 0;
                const inkstoneScheduled = tracker?.inkstone_scheduled_count || 0;
                const patreonScheduled = tracker?.patreon_scheduled_count || 0;
                const isWNPublished = ch.chapter_number <= wnLast;
                const isPatreonPublished = ch.chapter_number <= patreonLast;
                const isInkstoneScheduled = !isWNPublished && ch.chapter_number <= wnLast + inkstoneScheduled;
                const isPatreonScheduled = !isPatreonPublished && ch.chapter_number <= patreonLast + patreonScheduled;
                const isSelected = selected.has(ch.chapter_number);

                return (
                  <tr key={ch.chapter_number} tabIndex={0} onKeyDown={e => handleKeyDown(e, idx)} className={`${isSelected ? 'bg-rose-950/10' : ''} hover:bg-[#181f30]/30 transition-all ${focusedIndex === idx ? 'ring-1 ring-[#00f2fe]/50' : ''}`}>
                    <td className="py-3 px-3">
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-[#00f2fe]"
                        checked={isSelected}
                        onChange={() => {
                          onSelect(new Set(selected));
                          const n = new Set(selected);
                          isSelected ? n.delete(ch.chapter_number) : n.add(ch.chapter_number);
                          // Need to trigger with the new set
                          onSelect(n);
                        }}
                      />
                    </td>
                    <td className="py-3 px-3 font-bold text-[#00f2fe]">#{ch.chapter_number}</td>
                    <td className="py-3 px-3">
                      <p className="font-semibold text-slate-200 truncate max-w-[180px]">{ch.title}</p>
                      <p className="text-[9px] text-slate-500 truncate max-w-[180px]">{ch.file_name}</p>
                    </td>
                    <td className="py-3 px-3 text-center">
                      {isWNPublished ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold">
                          <Check size={10} /> Published
                        </span>
                      ) : isInkstoneScheduled ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold">
                          <Calendar size={10} /> Scheduled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-gray-800 text-slate-500 border border-transparent text-[10px]">
                          Unpublished
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center">
                      {isPatreonPublished ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold">
                          <Check size={10} /> Published
                        </span>
                      ) : isPatreonScheduled ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold">
                          <Calendar size={10} /> Scheduled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-gray-800 text-slate-500 border border-transparent text-[10px]">
                          Unpublished
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {onPublishSingle && !isWNPublished && !isInkstoneScheduled && !isPatreonPublished && !isPatreonScheduled && (
                          <button
                            onClick={() => onPublishSingle(ch.chapter_number)}
                            className="p-1.5 rounded bg-emerald-950/40 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-900/20 transition-all cursor-pointer"
                            title="Publish single chapter"
                          >
                            <Send size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => onEdit(ch.chapter_number)}
                          className="p-1.5 rounded bg-[#1e293b] border border-slate-700 text-slate-400 hover:text-[#00f2fe] hover:border-[#00f2fe]/40 transition-all cursor-pointer"
                          title="Edit chapter content"
                        >
                          <FileCode size={13} />
                        </button>
                        {(isWNPublished || isInkstoneScheduled || isPatreonPublished || isPatreonScheduled) && onUpdatePlatform && (
                          <button
                            onClick={() => onUpdatePlatform(ch.chapter_number)}
                            className="p-1.5 rounded bg-blue-950/40 border border-blue-700/40 text-blue-400 hover:bg-blue-900/20 transition-all cursor-pointer"
                            title="Push local content update to platform"
                          >
                            <UploadCloud size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => onToggleLock(ch.chapter_number, ch.is_locked)}
                          className={`p-1.5 rounded transition-all cursor-pointer ${
                            ch.is_locked
                              ? 'bg-rose-950/40 border border-rose-800/40 text-rose-400 hover:bg-rose-900/20'
                              : 'bg-emerald-950/40 border border-emerald-800/40 text-emerald-400 hover:bg-emerald-900/20'
                          }`}
                          title={ch.is_locked ? 'Click to Unlock' : 'Click to Lock'}
                        >
                          {ch.is_locked ? <Lock size={13} /> : <Unlock size={13} />}
                        </button>
                        <button
                          onClick={() => confirm({
                            title: 'Delete Chapter',
                            message: `Delete Chapter ${ch.chapter_number} "${ch.title}"? This cannot be undone.`,
                            onConfirm: () => onDelete(ch.chapter_number),
                          })}
                          className="p-1.5 rounded bg-[#1e293b] border border-slate-700 text-slate-400 hover:text-rose-400 hover:border-rose-500/40 transition-all cursor-pointer"
                          title="Delete chapter"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">
                  No chapter files found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!expanded && hiddenCount > 0 && (
          <div className="text-center py-3 border-t border-gray-800/50">
            <button
              onClick={() => setExpanded(true)}
              className="px-4 py-2 rounded-lg bg-[#1e293b] border border-[#00f2fe]/40 hover:bg-[#00f2fe]/10 text-[12px] font-mono font-bold text-[#00f2fe] cursor-pointer transition-all"
            >
              <ChevronDown size={14} className="inline mr-1" /> Show All {chapters?.length} Chapters
            </button>
          </div>
        )}
      </div>

      {tracker && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg bg-[#181f30]/40 border border-gray-800/60 font-mono text-center">
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Webnovel</p>
              <p className="text-lg font-bold text-[#00f2fe]">Ch {tracker.webnovel_last}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Patreon</p>
              <p className="text-lg font-bold text-emerald-400">Ch {tracker.patreon_last}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Lead Buffer</p>
              <p className={`text-lg font-bold ${
                (config?.patreon_enabled
                  ? (tracker.patreon_last ?? 0)
                  : config?.kofi_enabled ? (tracker.kofi_last ?? 0) : 0) - (tracker.webnovel_last ?? 0) >= (config?.target_lead ?? 0)
                  ? 'text-emerald-400'
                  : 'text-rose-400 animate-pulse'
              }`}>
                {(config?.patreon_enabled
                  ? (tracker.patreon_last ?? 0)
                  : config?.kofi_enabled ? (tracker.kofi_last ?? 0) : 0) - (tracker.webnovel_last ?? 0)} / {config?.target_lead ?? 0}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Status</p>
              <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                tracker.execution_status === 'running'
                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                  : tracker.execution_status === 'failed'
                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-pulse'
                  : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              }`}>
                {tracker.execution_status?.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#181f30]/40 border border-gray-800/60 font-mono">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-slate-400 uppercase tracking-wider">Sequence Health</p>
              {sequenceCheck && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sequenceCheck.ok ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'}`}>
                  {sequenceCheck.ok ? 'All Clear' : 'Issues Found'}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {sequenceCheck && (() => {
                const checks = [
                  { label: 'Local Chapters', ok: sequenceCheck.local.ok, detail: sequenceCheck.local.count > 0 ? `#1..#${sequenceCheck.local.to} (${sequenceCheck.local.count} ch)` : '0 chapters', extra: sequenceCheck.local.missing.length > 0 ? `Missing: #${sequenceCheck.local.missing.join(', #')}` : null },
                  { label: 'Inkstone', ok: sequenceCheck.inkstone?.ok ?? true, detail: sequenceCheck.inkstone ? `${sequenceCheck.inkstone.missing.length} gap${sequenceCheck.inkstone.missing.length !== 1 ? 's' : ''}, ${sequenceCheck.inkstone.mismatches.length} date` : 'No data', extra: sequenceCheck.inkstone?.missing.length ? `Gaps: #${sequenceCheck.inkstone.missing.slice(0,5).join(', #')}${sequenceCheck.inkstone.missing.length > 5 ? ` +${sequenceCheck.inkstone.missing.length - 5}` : ''}` : sequenceCheck.inkstone?.mismatches.length ? `${sequenceCheck.inkstone.mismatches[0].chapter_number}: ${(sequenceCheck.inkstone.mismatches[0].actual_date||'').slice(0,10)||'none'} → ${sequenceCheck.inkstone.mismatches[0].expected_date.slice(0,10)}` : null },
                  { label: 'Patreon', ok: sequenceCheck.patreon?.ok ?? true, detail: sequenceCheck.patreon ? `${sequenceCheck.patreon.missing.length} gap${sequenceCheck.patreon.missing.length !== 1 ? 's' : ''}, ${sequenceCheck.patreon.mismatches.length} date` : 'No data', extra: sequenceCheck.patreon?.missing.length ? `Gaps: #${sequenceCheck.patreon.missing.slice(0,5).join(', #')}${sequenceCheck.patreon.missing.length > 5 ? ` +${sequenceCheck.patreon.missing.length - 5}` : ''}` : sequenceCheck.patreon?.mismatches.length ? `${sequenceCheck.patreon.mismatches[0].chapter_number}: ${(sequenceCheck.patreon.mismatches[0].actual_date||'').slice(0,10)||'none'} → ${sequenceCheck.patreon.mismatches[0].expected_date.slice(0,10)}` : null },
                  { label: 'Ko-fi', ok: sequenceCheck.kofi?.ok ?? true, detail: sequenceCheck.kofi ? `${sequenceCheck.kofi.missing.length} gap${sequenceCheck.kofi.missing.length !== 1 ? 's' : ''}, ${sequenceCheck.kofi.mismatches.length} date` : 'No data', extra: sequenceCheck.kofi?.missing.length ? `Gaps: #${sequenceCheck.kofi.missing.slice(0,5).join(', #')}${sequenceCheck.kofi.missing.length > 5 ? ` +${sequenceCheck.kofi.missing.length - 5}` : ''}` : sequenceCheck.kofi?.mismatches.length ? `${sequenceCheck.kofi.mismatches[0].chapter_number}: ${(sequenceCheck.kofi.mismatches[0].actual_date||'').slice(0,10)||'none'} → ${sequenceCheck.kofi.mismatches[0].expected_date.slice(0,10)}` : null },
                ];
                return checks.map(c => (
                  <div key={c.label} className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">{c.label}</span>
                    <span className={`flex items-center gap-1 ${c.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {c.ok ? <Check size={10} /> : <AlertTriangle size={10} />}
                      {c.detail}
                    </span>
                  </div>
                ));
              })()}
              {!sequenceCheck && (
                <p className="text-[11px] text-slate-600">Loading...</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

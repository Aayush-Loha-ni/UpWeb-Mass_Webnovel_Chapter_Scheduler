import React, { useState, memo } from 'react';
import { motion } from 'motion/react';
import { Calendar, X, ExternalLink, Clock, RefreshCw, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../lib/apiKey';
import { SequenceAudit } from '../types';

interface QueueItem {
  chapter_number: number;
  date: string | null;
  edit_url?: string;
}

interface ScheduledQueueProps {
  slug: string;
  inkstone: QueueItem[];
  patreon: QueueItem[];
  inkstoneAudit?: SequenceAudit | null;
  patreonAudit?: SequenceAudit | null;
  onUpdate: () => void;
}

const ScheduledQueue = memo(function ScheduledQueue({ slug, inkstone, patreon, inkstoneAudit, patreonAudit, onUpdate }: ScheduledQueueProps) {
  const [editingDate, setEditingDate] = useState<{ platform: string; num: number } | null>(null);
  const [newDate, setNewDate] = useState('');
  const [loading, setLoading] = useState<{ platform: string; num: number; action: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const handleReschedule = async (platform: string, num: number) => {
    if (!newDate) return;
    setLoading({ platform, num, action: 'reschedule' });
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/novels/${slug}/queue/${platform}/${num}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: newDate }),
      });
      if (res.ok) {
        setEditingDate(null);
        onUpdate();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Reschedule failed (${res.status})`);
      }
    } catch (e: any) {
      setError(e.message || 'Network error');
    } finally {
      setLoading(null);
    }
  };

  const handleCancel = async (platform: string, num: number) => {
    setLoading({ platform, num, action: 'cancel' });
    try {
      const res = await apiFetch(`/api/v1/novels/${slug}/queue/${platform}/${num}/cancel`, {
        method: 'POST',
      });
      if (res.ok) onUpdate();
    } finally {
      setLoading(null);
    }
  };

  const renderColumn = (platformLabel: string, items: QueueItem[], audit?: SequenceAudit | null) => {
    const sorted = [...items].sort((a, b) => a.chapter_number - b.chapter_number);
    const plat = platformLabel === 'inkstone' ? 'inkstone' : 'patreon';
    const auditKey = `queue-${plat}`;
    const showMis = expanded[`${auditKey}-mis`];
    const showMissing = expanded[`${auditKey}-missing`];
    const showDups = expanded[`${auditKey}-dups`];
    const toggle = (k: string) => setExpanded(p => ({ ...p, [k]: !p[k] }));

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-3">
          <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${plat === 'inkstone' ? 'text-amber-400' : 'text-orange-400'}`}>
            {platformLabel}
          </span>
          <span className="text-[10px] font-mono text-slate-500">({items.length})</span>
          {audit && !audit.ok && (
            <div className="flex items-center gap-2 ml-auto">
              {audit.mismatches.length > 0 && (
                <span onClick={() => toggle(`${auditKey}-mis`)} className="text-[9px] font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded px-1.5 py-0.5 cursor-pointer hover:underline flex items-center gap-0.5">
                  {audit.mismatches.length} date{showMis ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </span>
              )}
              {audit.missing.length > 0 && (
                <span onClick={() => toggle(`${auditKey}-missing`)} className="text-[9px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 cursor-pointer hover:underline flex items-center gap-0.5">
                  {audit.missing.length} missing{showMissing ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </span>
              )}
              {audit.duplicates.length > 0 && (
                <span onClick={() => toggle(`${auditKey}-dups`)} className="text-[9px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-1.5 py-0.5 cursor-pointer hover:underline flex items-center gap-0.5">
                  {audit.duplicates.length} dup{showDups ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </span>
              )}
            </div>
          )}
          {audit?.ok && (
            <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5 ml-auto flex items-center gap-1">
              <Check size={10} /> All Clear
            </span>
          )}
        </div>

        {audit && !audit.ok && (
          <div className="text-[9px] font-mono text-slate-500 space-y-0.5 mb-2 overflow-hidden">
            {showMis && audit.mismatches.length > 0 && (
              <div className="bg-[#0f1117] rounded p-2 space-y-0.5 text-indigo-300/80 max-h-32 overflow-y-auto">
                {audit.mismatches.slice(0, 30).map(m => (
                  <div key={m.chapter_number}>
                    Ch {m.chapter_number}: {m.actual_date ? new Date(m.actual_date).toLocaleDateString() : 'none'} → {new Date(m.expected_date).toLocaleDateString()}
                  </div>
                ))}
                {audit.mismatches.length > 30 && (
                  <div className="text-slate-500">+{audit.mismatches.length - 30} more</div>
                )}
              </div>
            )}
            {showMissing && audit.missing.length > 0 && (
              <div className="bg-[#0f1117] rounded p-1.5 text-amber-400/80">
                Missing: #{audit.missing.join(', #')}
              </div>
            )}
            {showDups && audit.duplicates.length > 0 && (
              <div className="bg-[#0f1117] rounded p-1.5 text-rose-400/80">
                Duplicates: #{audit.duplicates.join(', #')}
              </div>
            )}
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="text-center py-6 text-slate-600 text-[11px] font-mono">
            No scheduled chapters.
          </div>
        ) : (
          <div className="space-y-1.5">
            {sorted.map(item => {
              const isLoading = loading?.platform === plat && loading?.num === item.chapter_number;
              const isEditing = editingDate?.platform === plat && editingDate?.num === item.chapter_number;
              return (
                <motion.div
                  key={`${plat}-${item.chapter_number}`}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 bg-[#1a1f2e] rounded-lg px-3 py-2 border border-gray-800"
                >
                  <span className="text-xs font-mono font-bold text-slate-200 w-10 shrink-0">Ch {item.chapter_number}</span>

                  {isEditing ? (
                    <div className="flex items-center gap-1.5 flex-1">
                      <input
                        type="date"
                        value={newDate}
                        onChange={e => setNewDate(e.target.value)}
                        className="flex-1 px-2 py-1 rounded bg-[#0b0e14] border border-gray-700 text-slate-200 text-[10px] font-mono focus:outline-none focus:border-[#00f2fe]"
                      />
                      <button
                        onClick={() => handleReschedule(plat, item.chapter_number)}
                        disabled={isLoading || !newDate}
                        className="px-1.5 py-1 rounded bg-emerald-600 text-white text-[9px] font-mono font-bold hover:bg-emerald-500 transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isLoading ? '...' : 'Set'}
                      </button>
                      <button
                        onClick={() => setEditingDate(null)}
                        className="px-1.5 py-1 rounded bg-slate-800 text-slate-400 text-[9px] font-mono hover:text-slate-200 transition-all cursor-pointer"
                      >
                        X
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <Clock size={10} className="text-slate-500 shrink-0" />
                      <span className="text-[10px] font-mono text-slate-300 truncate">{item.date ? item.date.slice(0, 10) : 'No date'}</span>
                    </div>
                  )}

                      <div className="flex items-center gap-0.5 shrink-0">
                        {!isEditing && (
                          <button
                            onClick={() => { setEditingDate({ platform: plat, num: item.chapter_number }); setNewDate(item.date ? item.date.slice(0, 10) : ''); }}
                            className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-[#00f2fe] transition-all cursor-pointer"
                            title="Reschedule"
                          >
                            <Calendar size={12} />
                          </button>
                        )}
                        {item.edit_url && (
                          <a
                            href={item.edit_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-emerald-400 transition-all"
                            title="Open edit URL"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                        <button
                          onClick={() => handleCancel(plat, item.chapter_number)}
                          disabled={isLoading}
                          className="p-1 rounded hover:bg-rose-950/30 text-slate-500 hover:text-rose-400 transition-all cursor-pointer disabled:opacity-50"
                          title="Cancel scheduled publish"
                        >
                          {isLoading ? <RefreshCw size={12} className="animate-spin" /> : <X size={12} />}
                        </button>
                      </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const totalItems = inkstone.length + patreon.length;
  if (totalItems === 0) {
    return (
      <div className="text-center py-10 text-slate-500 text-sm font-mono">
        No scheduled chapters pending.
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row gap-6">
      {error && (
        <div className="w-full bg-rose-950/30 border border-rose-500/30 rounded-lg px-3 py-2 text-[10px] font-mono text-rose-400 flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-300 cursor-pointer">✕</button>
        </div>
      )}
      {renderColumn('inkstone', inkstone, inkstoneAudit)}
      <div className="hidden md:block w-px bg-gray-800 self-stretch" />
      {renderColumn('patreon', patreon, patreonAudit)}
    </div>
  );
});

export default ScheduledQueue;

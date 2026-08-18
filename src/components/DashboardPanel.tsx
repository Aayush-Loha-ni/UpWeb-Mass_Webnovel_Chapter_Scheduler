import React, { useEffect, useState, memo } from 'react';
import { motion } from 'motion/react';
import { Loader2, Gauge, BookOpen, Activity, Check, AlertTriangle, ChevronDown, ChevronUp, Play, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/apiKey';
import { SequenceAudit } from '../types';

interface DashboardStat {
  slug: string;
  name: string;
  lead: number;
  target_lead: number;
  patreon_last: number;
  kofi_last?: number;
  webnovel_last: number;
  execution_status: string;
  inkstone_audit: SequenceAudit | null;
  patreon_audit: SequenceAudit | null;
  kofi_audit?: SequenceAudit | null;
  local_sequence: { ok: boolean; missing: number[]; from: number; to: number } | null;
  next_inkstone_schedule: { chapter_number: number; publish_date: string }[];
  next_patreon_schedule: { chapter_number: number; publish_date: string }[];
  next_kofi_schedule: { chapter_number: number; publish_date: string }[];
}

const DashboardPanel = memo(function DashboardPanel() {
  const [stats, setStats] = useState<DashboardStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    apiFetch('/api/v1/dashboard').then(r => r.json()).then(data => {
      setStats(Array.isArray(data) ? data : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-[#00f2fe]" size={24} />
      </div>
    );
  }

  if (stats.length === 0) {
    return (
      <div className="text-center py-20 text-slate-500 text-sm font-mono">
        No novels registered yet.
      </div>
    );
  }

  const toggleExpand = (key: string) => setExpanded(p => ({ ...p, [key]: !p[key] }));

  const renderAuditRow = (label: string, audit: SequenceAudit | null) => {
    const key = `${label}-${audit?.platform}`;
    const showMissing = expanded[`${key}-missing`];
    const showDups = expanded[`${key}-dups`];
    return (
      <div key={label} className={`bg-[#1a1f2e] rounded-lg p-3 ${!audit || audit.ok ? '' : 'cursor-pointer'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-400 text-[11px] font-mono">
            {audit?.ok
              ? <Check size={14} className="text-emerald-400" />
              : <AlertTriangle size={14} className="text-rose-400" />
            }
            {label}
          </div>
          <div className="flex items-center gap-1">
            {!audit ? (
              <span className="text-[10px] text-slate-600 font-mono">—</span>
            ) : audit.ok ? (
              <span className="text-[10px] text-emerald-400 font-mono font-bold">Sequential</span>
            ) : (
              <div className="flex items-center gap-2">
                {audit.missing.length > 0 && (
                  <span onClick={() => toggleExpand(`${key}-missing`)} className="text-[10px] text-amber-400 font-mono font-bold hover:underline flex items-center gap-0.5">
                    {audit.missing.length} missing{showMissing ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </span>
                )}
                {audit.duplicates.length > 0 && (
                  <span onClick={() => toggleExpand(`${key}-dups`)} className="text-[10px] text-rose-400 font-mono font-bold hover:underline flex items-center gap-0.5">
                    {audit.duplicates.length} dup{showDups ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {audit && !audit.ok && (
          <div className="text-[10px] font-mono text-slate-500 space-y-0.5 mt-1 overflow-hidden">
            {showMissing && audit.missing.length > 0 && (
              <div className="bg-[#131722] rounded p-1.5 text-amber-400/80">
                Missing: #{audit.missing.join(', #')}
              </div>
            )}
            {showDups && audit.duplicates.length > 0 && (
              <div className="bg-[#131722] rounded p-1.5 text-rose-400/80">
                Duplicates: #{audit.duplicates.join(', #')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {stats.map(s => {
        const leadOk = s.lead <= s.target_lead;
        return (
          <motion.div
            key={s.slug}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#131722] border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all"
          >
            <div className="flex items-center gap-2 mb-4">
              <BookOpen size={16} className="text-[#00f2fe]" />
              <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">{s.name}</h3>
              <span className={`ml-auto text-[10px] font-mono font-bold uppercase flex items-center gap-1 ${s.execution_status === 'running' ? 'text-amber-400' : s.execution_status === 'failed' ? 'text-rose-400' : 'text-emerald-400'}`}>
                {s.execution_status === 'running' ? <Play size={10} /> : s.execution_status === 'failed' ? <XCircle size={10} /> : <Check size={10} />}
                {s.execution_status}
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between bg-[#1a1f2e] rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 text-[11px] font-mono">
                  <Gauge size={14} className="text-[#00f2fe]" /> Lead
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold font-mono ${leadOk ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {s.lead}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">/ {s.target_lead}</span>
                </div>
              </div>

              <div className="flex items-center justify-between bg-[#1a1f2e] rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 text-[11px] font-mono">
                  <Activity size={14} className="text-[#00f2fe]" /> Published
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold font-mono text-slate-200">{s.webnovel_last}</span>
                  <span className="text-[10px] text-slate-500 font-mono">(web) /</span>
                  {s.kofi_last !== undefined ? (
                    <>
                      <span className="text-sm font-bold font-mono text-slate-200">{s.kofi_last}</span>
                      <span className="text-[10px] text-slate-500 font-mono">(kofi)</span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-bold font-mono text-slate-200">{s.patreon_last}</span>
                      <span className="text-[10px] text-slate-500 font-mono">(pat)</span>
                    </>
                  )}
                </div>
              </div>

              {renderAuditRow('Inkstone', s.inkstone_audit)}
              {renderAuditRow('Patreon', s.patreon_audit)}
              {s.kofi_audit && renderAuditRow('Ko-fi', s.kofi_audit)}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
});

export default DashboardPanel;

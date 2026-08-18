import React from 'react';
import { Wifi, WifiOff, BookOpen, RefreshCw, Loader2 } from 'lucide-react';

interface StatusCardsProps {
  inkstoneAuth: boolean;
  inkstoneAge: number;
  patreonAuth: boolean;
  patreonAge: number;
  chaptersCount: number;
  lockedCount: number;
  leadBuffer: number;
  targetLead: number;
  lastScrapedAt?: string | null;
  isRunning: boolean;
  executionStatus?: string;
}

export default function StatusCards({
  inkstoneAuth, inkstoneAge, patreonAuth, patreonAge,
  chaptersCount, lockedCount, leadBuffer, targetLead,
  lastScrapedAt, isRunning, executionStatus
}: StatusCardsProps) {
  const cards = [
    {
      label: 'Inkstone',
      ok: inkstoneAuth,
      detail: inkstoneAuth ? `${inkstoneAge}h old` : 'Offline',
      icon: inkstoneAuth ? Wifi : WifiOff,
      color: inkstoneAuth ? 'text-emerald-400' : 'text-rose-400',
      bg: inkstoneAuth ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20',
      dot: inkstoneAuth ? 'bg-emerald-400' : 'bg-rose-400',
    },
    {
      label: 'Patreon',
      ok: patreonAuth,
      detail: patreonAuth ? `${patreonAge}h old` : 'Offline',
      icon: patreonAuth ? Wifi : WifiOff,
      color: patreonAuth ? 'text-emerald-400' : 'text-rose-400',
      bg: patreonAuth ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20',
      dot: patreonAuth ? 'bg-emerald-400' : 'bg-rose-400',
    },
    {
      label: 'Chapters',
      ok: true,
      detail: `${chaptersCount} files · ${lockedCount} locked`,
      icon: BookOpen,
      color: 'text-sky-400',
      bg: 'bg-sky-500/10 border-sky-500/20',
      dot: 'bg-sky-400',
      extra: `Buffer: ${leadBuffer}/${targetLead}`,
    },
    {
      label: 'Last Sync',
      ok: !isRunning,
      detail: lastScrapedAt ? new Date(lastScrapedAt).toLocaleString() : 'Never',
      icon: isRunning ? Loader2 : RefreshCw,
      color: isRunning ? 'text-indigo-400' : executionStatus === 'failed' ? 'text-rose-400' : 'text-slate-400',
      bg: isRunning ? 'bg-indigo-500/10 border-indigo-500/20' : executionStatus === 'failed' ? 'bg-rose-500/10 border-rose-500/20' : 'bg-slate-500/10 border-slate-500/20',
      dot: isRunning ? 'bg-indigo-400 animate-pulse' : executionStatus === 'failed' ? 'bg-rose-400' : 'bg-slate-400',
      extra: isRunning ? 'Running...' : executionStatus ? executionStatus.toUpperCase() : 'Idle',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      {cards.map(c => {
        const Icon = c.icon;
        return (
          <div key={c.label} className={`${c.bg} border rounded-lg p-3 flex items-start gap-3`}>
            <div className={`mt-0.5 flex h-2 w-2 relative`}>
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${c.dot} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${c.dot}`}></span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon size={11} className={c.color} />
                <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">{c.label}</span>
              </div>
              <p className={`text-xs font-mono font-semibold ${c.color} truncate`}>{c.detail}</p>
              {'extra' in c && c.extra ? (
                <p className="text-[10px] font-mono text-slate-500 mt-0.5">{c.extra}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

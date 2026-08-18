import React from 'react';
import { Play, RefreshCw, Activity, Loader2, Calendar, ShieldAlert, Trash2, AlertTriangle } from 'lucide-react';
import { ProgressInfo } from '../types';

interface ExecutionControlsProps {
  isRunning: boolean;
  progress: ProgressInfo | null;
  onScrape: () => void;
  onPublish: (mode: 'single' | 'all', dryRun: boolean) => void;
  onResequence: () => void;
  onCleanup: (platform: string) => void;
  lastScrapedAt?: string | null;
  hasInkstoneAuth: boolean;
  hasPatreonAuth: boolean;
  hasKofiAuth?: boolean;
  inkstoneSessionExpired?: boolean;
  patreonSessionExpired?: boolean;
  onReconnect?: (platform: 'inkstone' | 'patreon') => void;
  onResetStatus?: () => void;
}

export default function ExecutionControls({ isRunning, progress, onScrape, onPublish, onCleanup, lastScrapedAt, hasInkstoneAuth, hasPatreonAuth, hasKofiAuth, inkstoneSessionExpired, patreonSessionExpired, onReconnect, onResetStatus }: ExecutionControlsProps) {
  const anySessionExpired = inkstoneSessionExpired || patreonSessionExpired;
  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
        <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider flex items-center gap-2">
          <Activity size={14} className="text-[#00f2fe]" /> Publish Controls
        </h2>

        {lastScrapedAt && (
          <span className="text-[10px] font-mono text-slate-500">
            Last Scraped: {new Date(lastScrapedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          onClick={onScrape}
          disabled={isRunning || (!hasInkstoneAuth && !hasPatreonAuth) || anySessionExpired}
          className="py-3 px-4 rounded-lg bg-indigo-950/40 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-900/30 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isRunning && progress ? (
            <><Loader2 className="animate-spin text-indigo-400" size={14} /> {progress.percent}% — {progress.label}</>
          ) : isRunning ? (
            <><Loader2 className="animate-spin text-indigo-400" size={14} /> Running...</>
          ) : (
            <><RefreshCw size={14} /> Scrape Progress</>
          )}
        </button>

        <button
          onClick={() => onPublish('all', false)}
          disabled={isRunning || (!hasInkstoneAuth && !hasPatreonAuth) || anySessionExpired}
          className="py-3 px-4 rounded-lg bg-[#162a22] border border-[#10b981]/40 text-[#10b981] hover:bg-[#10b981]/10 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isRunning && progress ? (
            <><Loader2 className="animate-spin text-[#10b981]" size={14} /> {progress.percent}% — {progress.label}</>
          ) : isRunning ? (
            <><Loader2 className="animate-spin text-[#10b981]" size={14} /> Running...</>
          ) : (
            <><Play size={14} /> Publish/Schedule Now</>
          )}
        </button>

        <div className="relative group">
          <button
            onClick={() => onPublish('all', true)}
            disabled={isRunning || (!hasInkstoneAuth && !hasPatreonAuth) || anySessionExpired}
            className="w-full py-3 px-4 rounded-lg bg-[#292212] border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Calendar size={14} /> Test Publish
          </button>
        </div>

        {hasInkstoneAuth && (
          <button
            onClick={() => onCleanup('inkstone')}
            disabled={isRunning}
            className="py-3 px-4 rounded-lg bg-rose-950/30 border border-rose-500/30 text-rose-300 hover:bg-rose-900/30 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Trash2 size={14} /> Clean Inkstone
          </button>
        )}
        {hasPatreonAuth && (
          <button
            onClick={() => onCleanup('patreon')}
            disabled={isRunning}
            className="py-3 px-4 rounded-lg bg-purple-950/30 border border-purple-500/30 text-purple-300 hover:bg-purple-900/30 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Trash2 size={14} /> Clean Patreon
          </button>
        )}
        {hasKofiAuth && (
          <button
            onClick={() => onCleanup('kofi')}
            disabled={isRunning}
            className="py-3 px-4 rounded-lg bg-blue-950/30 border border-blue-500/30 text-blue-300 hover:bg-blue-900/30 font-mono text-xs font-bold tracking-wide flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Trash2 size={14} /> Clean Ko-fi
          </button>
        )}
      </div>

      {progress && isRunning && (
        <div className="mt-3">
          <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
            <span>{progress.label}</span>
            <span className="font-bold text-[#00f2fe]">{progress.percent}%</span>
          </div>
          <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}
      {isRunning && onResetStatus && (
        <div className="mt-3 flex items-center justify-between bg-amber-950/20 border border-amber-800/40 rounded-lg px-4 py-2">
          <span className="text-[10px] font-mono text-amber-300 flex items-center gap-1">
            <AlertTriangle size={11} /> Automation stuck?
          </span>
          <button
            onClick={onResetStatus}
            className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-mono font-bold transition-all cursor-pointer"
          >
            Reset Status
          </button>
        </div>
      )}
      {(!hasInkstoneAuth && !hasPatreonAuth) && (
        <p className="text-[10px] font-mono text-rose-400 mt-3 text-center flex items-center justify-center gap-1">
          <ShieldAlert size={12} /> Connect your accounts above to enable publishing.
        </p>
      )}
      {anySessionExpired && (
        <div className="mt-3 space-y-2">
          {inkstoneSessionExpired && (
            <div className="flex items-center justify-between bg-rose-950/20 border border-rose-800/40 rounded-lg px-4 py-2">
              <span className="text-[10px] font-mono text-rose-300">Inkstone session expired. Reconnect to continue.</span>
              <button
                onClick={() => onReconnect?.('inkstone')}
                className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-mono font-bold transition-all cursor-pointer"
              >
                Reconnect
              </button>
            </div>
          )}
          {patreonSessionExpired && (
            <div className="flex items-center justify-between bg-rose-950/20 border border-rose-800/40 rounded-lg px-4 py-2">
              <span className="text-[10px] font-mono text-rose-300">Patreon session expired. Reconnect to continue.</span>
              <button
                onClick={() => onReconnect?.('patreon')}
                className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-mono font-bold transition-all cursor-pointer"
              >
                Reconnect
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

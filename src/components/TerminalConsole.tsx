import React, { useRef, useEffect } from 'react';
import { Terminal } from 'lucide-react';

interface TerminalConsoleProps {
  logs: string[];
  isRunning: boolean;
}

export default function TerminalConsole({ logs, isRunning }: TerminalConsoleProps) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const prevLogsRef = useRef<string[]>([]);

  useEffect(() => {
    if (isRunning && (prevLogsRef.current.length !== logs.length || prevLogsRef.current.some((v, i) => v !== logs[i]))) {
      logEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
    prevLogsRef.current = logs;
  }, [logs, isRunning]);

  return (
    <div className="bg-[#0b0d13] border border-gray-800 rounded-xl p-5 shadow-2xl">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <Terminal size={14} className="text-[#00f2fe]" /> Terminal Logs
        </h2>
        <div className="flex items-center gap-2">
          {isRunning && <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />}
          <span className="text-[9px] font-mono text-slate-500">Output</span>
        </div>
      </div>

      <div role="log" aria-live="polite" aria-label="Execution logs" className="bg-black/80 rounded-lg p-4 h-48 overflow-y-auto font-mono text-xs border border-gray-900/50 flex flex-col gap-1.5 scrollbar-thin scrollbar-thumb-gray-800">
        {logs.length > 0 ? (
          logs.map((log, idx) => {
            let colorClass = 'text-slate-300';
            if (log.includes('[SUCCESS]')) colorClass = 'text-emerald-400 font-semibold';
            else if (log.includes('[CRITICAL ERROR]') || log.includes('[FAILED]')) colorClass = 'text-rose-400 font-bold';
            else if (log.includes('[BUFFER TRIGGER]') || log.includes('[BLOCKED]')) colorClass = 'text-amber-400';
            else if (log.includes('[Patreon Staged]') || log.includes('[Inkstone Staged]')) colorClass = 'text-teal-400 font-medium';
            else if (log.includes('[STAGING STEP]')) colorClass = 'text-[#00f2fe]';

            return (
              <div key={idx} className={`${colorClass} leading-relaxed`}>
                {log}
              </div>
            );
          })
        ) : (
          <div className="text-slate-600 text-[11px] italic">
            Idle. Run Scrape or Publish to see output here.
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

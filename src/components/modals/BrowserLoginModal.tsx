import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Chrome, Globe, Loader2, Check, AlertTriangle } from 'lucide-react';

interface BrowserLoginModalProps {
  show: boolean;
  platform: string;
  status: string;
  logs: string[];
  onClose: () => void;
  onLaunch: (platform: 'inkstone' | 'patreon' | 'kofi') => void;
}

export default function BrowserLoginModal({ show, platform, status, logs, onClose, onLaunch }: BrowserLoginModalProps) {
  const connectLogsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connectLogsEndRef.current) {
      connectLogsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[80] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            className="bg-[#0b0e14] border border-slate-800 rounded-xl max-w-2xl w-full shadow-2xl flex flex-col overflow-hidden font-mono text-xs text-slate-300"
          >
            <div className="bg-[#080a10] border-b border-slate-800/80 px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[#00f2fe]/10 border border-[#00f2fe]/30">
                  <Chrome size={20} className="text-[#00f2fe]" />
                </div>
                <div>
                  <h3 className="text-sm font-sans font-extrabold tracking-wider text-white uppercase">
                    {platform === 'inkstone' ? 'Inkstone' : platform === 'patreon' ? 'Patreon' : 'Ko-fi'} Login
                  </h3>
                  <p className="text-[10px] text-slate-400 font-mono">Real browser launch with cookie extraction</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 p-5 space-y-4">
              {status === 'disconnected' && (
                <div className="space-y-3">
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Click "Launch Browser" to open a real Chromium window. Log in manually on the website.
                    Cookies will be extracted automatically when you close the browser.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onLaunch('inkstone')}
                      className="flex-1 px-4 py-3 rounded-lg bg-gradient-to-r from-teal-500 to-[#00f2fe] text-[#0f1117] font-extrabold font-mono text-[11px] uppercase tracking-widest hover:opacity-95 active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Chrome size={14} /> Launch Inkstone Browser
                    </button>
                    <button
                      onClick={() => onLaunch('patreon')}
                      className="flex-1 px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 font-extrabold font-mono text-[11px] uppercase tracking-widest hover:bg-slate-700 active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Globe size={14} /> Launch Patreon Browser
                    </button>
                    <button
                      onClick={() => onLaunch('kofi')}
                      className="flex-1 px-4 py-3 rounded-lg bg-gradient-to-r from-rose-500 to-pink-500 text-[#0f1117] font-extrabold font-mono text-[11px] uppercase tracking-widest hover:opacity-95 active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Globe size={14} /> Launch Ko-fi Browser
                    </button>
                  </div>
                </div>
              )}

              {(status === 'launching' || status === 'waiting_login') && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Loader2 className="animate-spin text-[#00f2fe]" size={20} />
                    <div>
                      <p className="text-slate-200 font-bold text-[11px]">
                        {status === 'launching' ? 'Launching Chromium...' : 'Browser is open - Log in now'}
                      </p>
                      <p className="text-slate-500 text-[10px]">
                        {status === 'launching'
                          ? 'Starting headed browser with persistent profile...'
                          : 'Log in on the website, then close the browser window when done.'
                        }
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {status === 'connected' && (
                <div className="text-center py-4">
                  <div className="h-14 w-14 rounded-full bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center text-emerald-400 mx-auto mb-3">
                    <Check size={28} className="stroke-[3px]" />
                  </div>
                  <p className="text-emerald-400 font-extrabold uppercase tracking-widest text-[12px] font-mono mb-1">Login Complete</p>
                  <p className="text-slate-500 text-[10px]">Cookies saved. Browser is ready for scraping.</p>
                </div>
              )}

              {status === 'error' && (
                <div className="text-center py-4">
                  <AlertTriangle className="text-rose-400 mx-auto mb-2" size={28} />
                  <p className="text-rose-400 font-bold text-[11px]">Connection failed</p>
                </div>
              )}

              <div className="bg-black/40 border border-slate-900/60 rounded p-3 overflow-y-auto font-mono text-[9.5px] leading-relaxed space-y-1 h-[180px] scrollbar-thin">
                {logs.map((log, idx) => {
                  let logColor = 'text-slate-400';
                  if (log.includes('Error') || log.includes('error')) logColor = 'text-rose-400';
                  else if (log.includes('complete') || log.includes('saved') || log.includes('ready')) logColor = 'text-emerald-400';
                  else if (log.includes('Launching') || log.includes('launched')) logColor = 'text-cyan-400';
                  return (
                    <div key={idx} className={`${logColor} border-l border-slate-800 pl-1.5`}>
                      {log}
                    </div>
                  );
                })}
                <div ref={connectLogsEndRef} />
              </div>
            </div>

            <div className="px-5 py-3 border-t border-slate-800/80 flex justify-between items-center">
              <span className="text-[9px] text-slate-600 font-mono uppercase">
                Status: {status}
              </span>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 text-[10px] font-mono hover:bg-slate-800 transition-all cursor-pointer uppercase tracking-wide font-bold"
              >
                Close
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

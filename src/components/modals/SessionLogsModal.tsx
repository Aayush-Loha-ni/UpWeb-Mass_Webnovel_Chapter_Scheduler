import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal, Plus, Loader2 } from 'lucide-react';
import type { LogEntry } from '../../types';

interface SessionLogsModalProps {
  show: boolean;
  onClose: () => void;
  logFiles: string[];
  selectedFile: string;
  onSelectFile: (f: string) => void;
  entries: LogEntry[];
  loading: boolean;
  onLoadFiles: () => void;
}

export default function SessionLogsModal({ show, onClose, logFiles, selectedFile, onSelectFile, entries, loading, onLoadFiles }: SessionLogsModalProps) {
  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[85] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-[#0b0e14] border border-slate-800 rounded-xl max-w-3xl w-full shadow-2xl flex flex-col overflow-hidden font-mono text-xs max-h-[85vh]"
          >
            <div className="bg-[#080a10] border-b border-slate-800/80 px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Terminal size={18} className="text-[#00f2fe]" />
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Session Logs</h3>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
              >
                <Plus size={16} className="rotate-45" />
              </button>
            </div>

            <div className="flex-1 flex overflow-hidden">
              <div className="w-1/3 border-r border-slate-800/80 overflow-y-auto p-3 space-y-1">
                {loading && logFiles.length === 0 ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="animate-spin text-[#00f2fe]" size={16} />
                  </div>
                ) : logFiles.length === 0 ? (
                  <button
                    onClick={onLoadFiles}
                    className="w-full py-3 rounded bg-[#1e293b] border border-slate-700 text-slate-400 hover:text-[#00f2fe] hover:border-[#00f2fe]/30 text-[10px] font-bold transition-all cursor-pointer"
                  >
                    Load Log Files
                  </button>
                ) : (
                  logFiles.map((file) => (
                    <button
                      key={file}
                      onClick={() => onSelectFile(file)}
                      className={`w-full text-left px-3 py-2 rounded text-[10px] transition-all cursor-pointer ${
                        selectedFile === file
                          ? 'bg-[#182635] border-l-2 border-[#00f2fe] text-[#00f2fe]'
                          : 'hover:bg-[#181f30]/40 text-slate-400 border-l-2 border-transparent'
                      }`}
                    >
                      {file.replace('_session.jsonl', '')}
                    </button>
                  ))
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {entries.length > 0 ? (
                  <div className="space-y-2">
                    {entries.map((entry: LogEntry, idx: number) => {
                      let statusColor = 'text-slate-400';
                      let bgColor = 'bg-[#131722]';
                      if (entry.status === 'error') { statusColor = 'text-rose-400'; bgColor = 'bg-rose-950/20'; }
                      else if (entry.status === 'warning') { statusColor = 'text-amber-400'; bgColor = 'bg-amber-950/20'; }
                      else if (entry.status === 'success') { statusColor = 'text-emerald-400'; bgColor = 'bg-emerald-950/20'; }

                      return (
                        <div key={idx} className={`${bgColor} border border-gray-800/50 rounded p-3`}>
                          <div className="flex justify-between items-start mb-1">
                            <span className={`font-bold ${statusColor}`}>{entry.event}</span>
                            <span className="text-[9px] text-slate-600">
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                          </div>
                          {entry.details && Object.keys(entry.details).length > 0 && (
                            <pre className="text-[10px] text-slate-500 mt-1 overflow-x-auto">
                              {JSON.stringify(entry.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : selectedFile ? (
                  <div className="text-center text-slate-600 py-8">No entries in this log file.</div>
                ) : (
                  <div className="text-center text-slate-600 py-8">Select a log file to view entries.</div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-slate-800/80 flex justify-between items-center">
              <span className="text-[9px] text-slate-600">
                {entries.length} entries{selectedFile ? ` in ${selectedFile}` : ''}
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

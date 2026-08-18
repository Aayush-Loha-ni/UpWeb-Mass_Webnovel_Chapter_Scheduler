import React from 'react';
import { Terminal, Plus, Book, X } from 'lucide-react';
import { NovelDetail } from '../types';

interface NovelTabsProps {
  novels: NovelDetail[];
  activeSlug: string;
  onSelect: (slug: string) => void;
  onShowLogs: () => void;
  onRegister: () => void;
  onDelete: (slug: string, name: string) => void;
}

export default function NovelTabs({ novels, activeSlug, onSelect, onShowLogs, onRegister, onDelete }: NovelTabsProps) {
  return (
    <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8 pb-6 border-b border-gray-800">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="flex h-3 w-3 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00f2fe] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00f2fe]"></span>
          </span>
          <span className="font-mono text-xs tracking-wider text-[#00f2fe] uppercase">Dashboard</span>
        </div>
        <div className="flex items-center gap-3">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
            <rect width="36" height="36" rx="8" fill="#0f1117"/>
            <rect x="1" y="1" width="34" height="34" rx="7" stroke="#00f2fe" strokeWidth="1.5" strokeOpacity="0.4"/>
            <path d="M12 24V12h4a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-4" stroke="#00f2fe" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20 12h2.5a3.5 3.5 0 0 1 0 7H20" stroke="#00f2fe" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="28" cy="26" r="5" fill="#00f2fe" fillOpacity="0.15" stroke="#00f2fe" strokeWidth="1.5"/>
            <path d="M27 24v4l3-2" stroke="#00f2fe" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
            UpWeb
          </h1>
        </div>
        <p className="text-sm text-slate-400 mt-1">
          Manage your novel publishing workflow.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {novels.map(n => (
          <div
            key={n.slug}
            className={`group flex items-center gap-1 px-3 py-2 rounded-md font-mono text-xs font-semibold transition-all duration-200 border cursor-pointer ${
              activeSlug === n.slug
                ? 'bg-[#1e293b] border-[#00f2fe] text-[#00f2fe] shadow-[0_0_15px_rgba(0,242,254,0.15)]'
                : 'bg-[#131722] border-gray-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
            onClick={() => onSelect(n.slug)}
          >
            <Book size={14} className="shrink-0" /> {n.name}
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(n.slug, n.name); }}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-rose-500/20 hover:text-rose-400 transition-all cursor-pointer"
              title={`Delete ${n.name}`}
              aria-label={`Delete ${n.name}`}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={onShowLogs}
          className="px-3 py-2 rounded-md bg-[#1e293b] border border-slate-700 text-slate-400 hover:text-[#00f2fe] hover:border-[#00f2fe]/40 text-xs font-mono font-bold flex items-center gap-1 transition-all cursor-pointer"
          title="View session logs"
          aria-label="View session logs"
        >
          <Terminal size={12} /> Logs
        </button>
        <button
          onClick={onRegister}
          className="px-3 py-2 rounded-md bg-[#162a2b] border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 text-xs font-mono font-bold flex items-center gap-1 transition-all"
          aria-label="Register a new novel"
        >
          <Plus size={14} /> Register Novel
        </button>
      </div>
    </header>
  );
}

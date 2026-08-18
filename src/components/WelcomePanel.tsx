import React from 'react';
import { BookOpen, Plus } from 'lucide-react';

interface WelcomePanelProps {
  onOpenRegister: () => void;
}

export default function WelcomePanel({ onOpenRegister }: WelcomePanelProps) {
  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-8 shadow-xl flex flex-col items-center gap-6 text-center">
      <div>
        <BookOpen size={40} className="text-[#00f2fe] mx-auto mb-3" />
        <h2 className="text-lg font-bold text-[#00f2fe] mb-1">No Novels Yet</h2>
        <p className="text-xs text-slate-400 max-w-sm">
          Register a novel by pasting its Inkstone or Webnovel URL to get started.
        </p>
      </div>

      <button
        type="button"
        onClick={onOpenRegister}
        className="px-5 py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-[#0f1117] font-bold text-xs tracking-wider uppercase transition-all flex items-center gap-1.5 shadow-[0_0_10px_rgba(16,185,129,0.15)] cursor-pointer"
      >
        <Plus size={14} /> Register Novel
      </button>
    </div>
  );
}

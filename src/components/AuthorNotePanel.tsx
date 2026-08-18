import React, { useState, useEffect } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import { NovelConfig } from '../types';

interface AuthorNotePanelProps {
  config: NovelConfig | null;
  slug: string;
  onSave: (config: Partial<NovelConfig>) => void;
}

export default function AuthorNotePanel({ config, slug, onSave }: AuthorNotePanelProps) {
  const [note, setNote] = useState('');
  const [position, setPosition] = useState('bottom');
  const [inkstone, setInkstone] = useState(true);
  const [patreon, setPatreon] = useState(true);

  useEffect(() => {
    if (config) {
      setNote(config.author_note || '');
      setPosition(config.author_note_position || 'bottom');
      setInkstone(config.author_note_inkstone !== false);
      setPatreon(config.author_note_patreon !== false);
    }
  }, [config]);

  const handleSave = () => {
    onSave({ author_note: note, author_note_position: position, author_note_inkstone: inkstone, author_note_patreon: patreon });
  };

  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider flex items-center gap-2">
          <MessageSquareQuote size={14} className="text-[#00f2fe]" /> Author's Note
        </h2>
        <button
          onClick={handleSave}
          className="px-2 py-1 rounded bg-[#1e293b] hover:bg-[#1e293b]/80 border border-slate-700 text-[10px] font-mono font-bold text-slate-300 flex items-center gap-1 transition-all cursor-pointer"
        >
          Save Note
        </button>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Write an author's note that will be appended to chapters when publishing..."
        rows={4}
        className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-slate-200 font-mono placeholder-slate-500 resize-y focus:outline-none focus:border-[#00f2fe] transition-colors"
      />

      <div className="mt-3 flex items-center gap-4">
        <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">Position:</span>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="radio" name="note-pos" value="bottom" checked={position === 'bottom'} onChange={() => setPosition('bottom')} className="accent-[#00f2fe]" />
          Bottom
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="radio" name="note-pos" value="top" checked={position === 'top'} onChange={() => setPosition('top')} className="accent-[#00f2fe]" />
          Top
        </label>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">Apply to:</span>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" checked={inkstone} onChange={(e) => setInkstone(e.target.checked)} className="accent-[#00f2fe]" />
          Inkstone
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" checked={patreon} onChange={(e) => setPatreon(e.target.checked)} className="accent-[#00f2fe]" />
          Patreon
        </label>
      </div>

      <p className="mt-2 text-[10px] text-slate-500 font-mono">
        Per-novel default. Override per-chapter in the chapter editor.
      </p>
    </div>
  );
}

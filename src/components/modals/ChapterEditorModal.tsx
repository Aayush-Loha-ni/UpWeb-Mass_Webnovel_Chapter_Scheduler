import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, FileCode, Plus, Settings2 } from 'lucide-react';

interface ChapterEditorModalProps {
  show: boolean;
  onClose: () => void;
  onSave: () => void;
  title: string;
  onTitleChange: (v: string) => void;
  body: string;
  onBodyChange: (v: string) => void;
  frontmatter: Record<string, any>;
  onFrontmatterChange: (v: Record<string, any>) => void;
  loading: boolean;
}

export default function ChapterEditorModal({ show, onClose, onSave, title, onTitleChange, body, onBodyChange, frontmatter, onFrontmatterChange, loading }: ChapterEditorModalProps) {
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
                <FileCode size={18} className="text-[#00f2fe]" />
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                  Edit Chapter
                </h3>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
              >
                <Plus size={16} className="rotate-45" />
              </button>
            </div>

            <div className="flex-1 p-5 overflow-y-auto space-y-4">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="animate-spin text-[#00f2fe]" size={24} />
                  <span className="ml-3 text-slate-400">Loading chapter content...</span>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Chapter Title</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => onTitleChange(e.target.value)}
                      className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-sm"
                    />
                  </div>

                  <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3 space-y-3">
                    <div className="flex items-center gap-2 text-slate-400 font-bold text-[10px] uppercase tracking-wider">
                      <Settings2 size={12} /> Frontmatter Overrides
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Patreon Tier ID</label>
                        <input
                          type="text"
                          value={frontmatter.patreon_tier_id || ''}
                          onChange={(e) => onFrontmatterChange({ ...frontmatter, patreon_tier_id: e.target.value || '' })}
                          placeholder="e.g. tier-early-access"
                          className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Patreon Tag</label>
                        <input
                          type="text"
                          value={frontmatter.patreon_tag || ''}
                          onChange={(e) => onFrontmatterChange({ ...frontmatter, patreon_tag: e.target.value || '' })}
                          placeholder="e.g. early-access"
                          className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3">
                    <label className="flex items-center gap-2 text-slate-400 font-bold text-[10px] uppercase tracking-wider cursor-pointer">
                      <input type="checkbox" checked={!!frontmatter.author_note_override} onChange={(e) => onFrontmatterChange({ ...frontmatter, author_note_override: e.target.checked ? true : false, author_note: e.target.checked ? (frontmatter.author_note || '') : frontmatter.author_note, author_note_position: e.target.checked ? (frontmatter.author_note_position || 'bottom') : frontmatter.author_note_position })} className="accent-[#00f2fe]" />
                      Override Author's Note
                    </label>
                    {frontmatter.author_note_override && (
                      <div className="mt-3 space-y-2">
                        <textarea
                          value={frontmatter.author_note || ''}
                          onChange={(e) => onFrontmatterChange({ ...frontmatter, author_note: e.target.value })}
                          rows={3}
                          placeholder="Per-chapter author's note..."
                          className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs resize-y"
                        />
                        <div className="flex items-center gap-4">
                          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Position:</span>
                          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input type="radio" name="ch-note-pos" value="bottom" checked={(frontmatter.author_note_position || 'bottom') === 'bottom'} onChange={() => onFrontmatterChange({ ...frontmatter, author_note_position: 'bottom' })} className="accent-[#00f2fe]" />
                            Bottom
                          </label>
                          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input type="radio" name="ch-note-pos" value="top" checked={frontmatter.author_note_position === 'top'} onChange={() => onFrontmatterChange({ ...frontmatter, author_note_position: 'top' })} className="accent-[#00f2fe]" />
                            Top
                          </label>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Apply to:</span>
                          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input type="checkbox" checked={frontmatter.author_note_inkstone !== false} onChange={(e) => onFrontmatterChange({ ...frontmatter, author_note_inkstone: e.target.checked })} className="accent-[#00f2fe]" />
                            Inkstone
                          </label>
                          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input type="checkbox" checked={frontmatter.author_note_patreon !== false} onChange={(e) => onFrontmatterChange({ ...frontmatter, author_note_patreon: e.target.checked })} className="accent-[#00f2fe]" />
                            Patreon
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex-1">
                    <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Body Content</label>
                    <textarea
                      value={body}
                      onChange={(e) => onBodyChange(e.target.value)}
                      rows={20}
                      className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-sans text-sm leading-relaxed resize-y"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-800/80 flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 text-[10px] font-mono hover:bg-slate-800 transition-all cursor-pointer uppercase tracking-wide font-bold"
              >
                Cancel
              </button>
              <button
                onClick={onSave}
                disabled={loading}
                className="px-5 py-2 rounded bg-[#00f2fe] hover:bg-[#00d4e0] text-[#0f1117] text-[10px] font-mono font-bold uppercase tracking-wide transition-all cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save Chapter'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
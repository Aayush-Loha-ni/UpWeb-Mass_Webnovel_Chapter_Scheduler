import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus } from 'lucide-react';

interface CreateChapterModalProps {
  show: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  chapterNum: number;
  onChapterNumChange: (v: number) => void;
  title: string;
  onTitleChange: (v: string) => void;
  body: string;
  onBodyChange: (v: string) => void;
}

export default function CreateChapterModal({ show, onClose, onSubmit, chapterNum, onChapterNumChange, title, onTitleChange, body, onBodyChange }: CreateChapterModalProps) {
  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-[#131722] border border-gray-800 rounded-xl p-6 max-w-lg w-full shadow-2xl font-mono text-xs"
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-[#00f2fe] uppercase">Add Chapter Markdown File</h3>
              <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
                <Plus size={20} className="rotate-45" />
              </button>
            </div>

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="grid grid-cols-4 gap-4">
                <div className="col-span-1">
                  <label className="block text-slate-400 uppercase mb-1">Ch Number</label>
                  <input
                    type="number"
                    required
                    value={chapterNum}
                    onChange={(e) => onChapterNumChange(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe]"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-slate-400 uppercase mb-1">Chapter Title</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => onTitleChange(e.target.value)}
                    placeholder="The Sword of Judgment"
                    className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 uppercase mb-1">Body Text Content</label>
                <textarea
                  required
                  rows={6}
                  value={body}
                  onChange={(e) => onBodyChange(e.target.value)}
                  placeholder="Paste parsed body components or raw manuscript prose safely here..."
                  className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-sans"
                />
              </div>

              <button
                type="submit"
                className="py-2.5 rounded bg-[#1e293b] hover:bg-[#00f2fe] hover:text-[#0f1117] border border-[#00f2fe]/40 font-bold transition-all"
              >
                Write to Disk (chapter_{chapterNum}.md)
              </button>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

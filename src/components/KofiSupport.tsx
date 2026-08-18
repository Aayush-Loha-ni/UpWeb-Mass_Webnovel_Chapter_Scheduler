import React from 'react';
import { Coffee } from 'lucide-react';

const KOFI_URL = 'https://ko-fi.com/W7W8O020Y';

/**
 * Ko-fi support button, styled to match the app's cyan/teal accent.
 */
export default function KofiSupport({ className = '' }: { className?: string }) {
  return (
    <a
      href={KOFI_URL}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-teal-500 text-[#0f1117] font-bold text-xs tracking-wider uppercase transition-all hover:from-[#00f2fe]/90 hover:to-teal-400 shadow-[0_0_18px_rgba(0,242,254,0.6)] hover:shadow-[0_0_30px_rgba(0,242,254,0.95)] cursor-pointer ${className}`}
    >
      <Coffee size={14} /> Support me on Ko-fi
    </a>
  );
}

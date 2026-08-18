import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Link, Loader2, Check, BookOpen, AlertCircle } from 'lucide-react';
import { apiFetch } from '../../lib/apiKey';

interface PreviewResult {
  slug: string;
  name: string;
  exists?: boolean;
}

interface RegisterNovelModalProps {
  show: boolean;
  onClose: () => void;
  onRegister: (slug: string, name: string, patreonTierId?: string, patreonTag?: string, kofiUrl?: string, kofiTierId?: string, kofiTag?: string) => void;
}

function parsePatreonUrl(urlStr: string): { tier: string | null; tag: string | null } {
  try {
    const u = new URL(urlStr);
    return { tier: u.searchParams.get('tier'), tag: u.searchParams.get('tags') };
  } catch { return { tier: null, tag: null }; }
}

function parseKofiUrl(urlStr: string): { tierId: string | null; tag: string | null; valid: boolean } {
  try {
    const u = new URL(urlStr);
    if (!/^(www\.)?ko-fi\.com$/i.test(u.hostname)) return { tierId: null, tag: null, valid: false };
    return { tierId: u.searchParams.get('tierId'), tag: u.searchParams.get('tag'), valid: true };
  } catch { return { tierId: null, tag: null, valid: false }; }
}

export default function RegisterNovelModal({ show, onClose, onRegister }: RegisterNovelModalProps) {
  const [url, setUrl] = useState('');
  const [patreonUrl, setPatreonUrl] = useState('');
  const [kofiUrl, setKofiUrl] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [patreonTierId, setPatreonTierId] = useState('tier-early-access');
  const [patreonTag, setPatreonTag] = useState('');
  const [patreonError, setPatreonError] = useState('');
  const [kofiTierId, setKofiTierId] = useState('');
  const [kofiTag, setKofiTag] = useState('');
  const [kofiError, setKofiError] = useState('');

  const validatePatreonUrl = useCallback((urlStr: string) => {
    if (!urlStr.trim()) { setPatreonError(''); return; }
    const { tier, tag } = parsePatreonUrl(urlStr);
    if (!tier) { setPatreonError('Patreon URL missing "tier" parameter.'); return; }
    if (!tag) { setPatreonError('Patreon URL missing "tags" parameter.'); return; }
    setPatreonError('');
    setPatreonTierId(tier);
    setPatreonTag(decodeURIComponent(tag));
  }, []);

  const validateKofiUrl = useCallback((urlStr: string) => {
    if (!urlStr.trim()) { setKofiError(''); return; }
    const { tierId, tag, valid } = parseKofiUrl(urlStr);
    if (!valid) { setKofiError('Enter a valid ko-fi.com URL (e.g. https://ko-fi.com/yourname).'); return; }
    setKofiError('');
    setKofiTierId(tierId || '');
    setKofiTag(tag ? decodeURIComponent(tag) : '');
  }, []);

  const reset = () => {
    setUrl('');
    setPatreonUrl('');
    setKofiUrl('');
    setPreview(null);
    setError('');
    setPatreonError('');
    setKofiError('');
    setLoading(false);
    setPatreonTierId('tier-early-access');
    setPatreonTag('');
    setKofiTierId('');
    setKofiTag('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const hasPatreon = (() => {
    if (!patreonUrl.trim()) return false;
    const { tier, tag } = parsePatreonUrl(patreonUrl);
    return !!tier && !!tag;
  })();

  const hasKofi = (() => {
    if (!kofiUrl.trim()) return false;
    return parseKofiUrl(kofiUrl).valid;
  })();

  const platformValid = hasPatreon || hasKofi;

  const handlePreview = async () => {
    if (!url.trim() || !platformValid) return;
    setLoading(true);
    setError('');
    setPreview(null);
    try {
      const res = await apiFetch('/api/v1/novels/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), preview: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const data = await res.json();
      setPreview(data);
    } catch (e: any) {
      if (e.message === 'Failed to fetch') {
        setError('Could not reach the server. Make sure the app is running and try again.');
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = () => {
    if (preview && !preview.exists && platformValid) {
      const pt = parsePatreonUrl(patreonUrl);
      const kf = parseKofiUrl(kofiUrl);
      onRegister(preview.slug, preview.name, pt.tier || undefined, pt.tag ? decodeURIComponent(pt.tag) : undefined, kofiUrl.trim() || undefined, kf.tierId || undefined, kf.tag || undefined);
      reset();
    }
  };

  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-[#131722] border border-gray-800 rounded-xl p-6 max-w-lg w-full shadow-2xl"
          >
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-sm font-bold text-[#00f2fe] uppercase flex items-center gap-2">
                <BookOpen size={16} /> Register Novel
              </h3>
              <button onClick={handleClose} className="text-slate-500 hover:text-slate-300">
                <Plus size={20} className="rotate-45" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Paste an Inkstone or Webnovel URL. At least one of Patreon or Ko-fi URL is required.
            </p>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Novel URL</label>
                <input
                  type="url"
                  autoFocus
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setPreview(null); setError(''); }}
                  placeholder="https://inkstone.webnovel.com/novels/your-novel-slug"
                  className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs"
                />
                <p className="text-[9px] text-slate-500 italic mt-0.5">
                  Supported: inkstone.webnovel.com/novels/SLUG or webnovel.com/book/SLUG
                </p>
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                  Patreon URL <span className="text-slate-500">(optional)</span>
                </label>
                <input
                  type="url"
                  value={patreonUrl}
                  onChange={(e) => { setPatreonUrl(e.target.value); setPreview(null); setError(''); setPatreonError(''); }}
                  onBlur={(e) => validatePatreonUrl(e.target.value)}
                  onPaste={(e) => setTimeout(() => validatePatreonUrl(e.currentTarget.value), 0)}
                  placeholder="https://www.patreon.com/library?tier=22851746&tags=Sinner%27s+World"
                  className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs"
                />
                {patreonError && (
                  <p className="text-[9px] text-rose-400 font-mono flex items-center gap-1 mt-0.5">
                    <AlertCircle size={10} /> {patreonError}
                  </p>
                )}
                {hasPatreon && (
                  <p className="text-[9px] text-emerald-400 font-mono mt-0.5">
                    Tier: {parsePatreonUrl(patreonUrl).tier} | Tag: {decodeURIComponent(parsePatreonUrl(patreonUrl).tag || '')}
                  </p>
                )}
                <p className="text-[9px] text-slate-500 italic mt-0.5">
                  Must contain both <span className="text-amber-400">tier</span> and <span className="text-amber-400">tags</span> query params from your Patreon library URL.
                </p>
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                  Ko-fi URL <span className="text-slate-500">(optional)</span>
                </label>
                <input
                  type="url"
                  value={kofiUrl}
                  onChange={(e) => { setKofiUrl(e.target.value); setPreview(null); setError(''); setKofiError(''); }}
                  onBlur={(e) => validateKofiUrl(e.target.value)}
                  onPaste={(e) => setTimeout(() => validateKofiUrl(e.currentTarget.value), 0)}
                  placeholder="https://ko-fi.com/yourname or https://ko-fi.com/yourname/posts"
                  className="w-full px-3 py-2 rounded bg-[#1e293b] border border-gray-800 text-slate-200 focus:outline-none focus:border-[#00f2fe] font-mono text-xs"
                />
                {kofiError && (
                  <p className="text-[9px] text-rose-400 font-mono flex items-center gap-1 mt-0.5">
                    <AlertCircle size={10} /> {kofiError}
                  </p>
                )}
                {hasKofi && (
                  <p className="text-[9px] text-emerald-400 font-mono mt-0.5">
                    Tier ID: {parseKofiUrl(kofiUrl).tierId}{parseKofiUrl(kofiUrl).tag ? ` | Tag: ${decodeURIComponent(parseKofiUrl(kofiUrl).tag || '')}` : ''}
                  </p>
                )}
                <p className="text-[9px] text-slate-500 italic mt-0.5">
                  Your ko-fi.com profile URL. Add <span className="text-amber-400">tierId</span> query param (optional) to set an audience tier.
                </p>
              </div>

              <button
                type="button"
                onClick={handlePreview}
                disabled={!url.trim() || !platformValid || loading}
                className="w-full py-2.5 rounded bg-[#00f2fe]/10 border border-[#00f2fe]/30 text-[#00f2fe] hover:bg-[#00f2fe]/20 disabled:opacity-50 disabled:cursor-not-allowed font-mono text-xs font-bold tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Link size={14} />}
                Preview
              </button>
            </div>

            {!platformValid && (patreonUrl || kofiUrl) && (
              <p className="text-[9px] text-amber-400 font-mono mt-2 flex items-center gap-1">
                <AlertCircle size={10} /> Provide a valid Patreon URL (with tier &amp; tags) or Ko-fi URL (https://ko-fi.com/...) to continue.
              </p>
            )}

            {error && (
              <div className="bg-rose-950/20 border border-rose-900/40 rounded-lg p-3 mt-4">
                <p className="text-xs text-rose-400 font-mono">{error}</p>
              </div>
            )}

            {preview && (
              <div className="bg-[#182635]/50 border border-[#00f2fe]/20 rounded-lg p-4 space-y-3 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Novel Name</p>
                    <p className="text-sm font-bold text-[#00f2fe]">{preview.name}</p>
                  </div>
                  {preview.exists && (
                    <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded">
                      Already Registered
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  Slug: <span className="text-slate-400">{preview.slug}</span>
                </div>
                {!preview.exists && (
                  <>
                    <div className="border-t border-gray-800 pt-3 space-y-2">
                      {hasPatreon && (
                        <p className="text-[9px] text-slate-500 font-mono">
                          Patreon tier: <span className="text-[#00f2fe]">{parsePatreonUrl(patreonUrl).tier}</span> | tag: <span className="text-emerald-400">{decodeURIComponent(parsePatreonUrl(patreonUrl).tag || '')}</span>
                        </p>
                      )}
                      {hasKofi && (
                        <p className="text-[9px] text-slate-500 font-mono">
                          Ko-fi tierId: <span className="text-[#00f2fe]">{parseKofiUrl(kofiUrl).tierId}</span>{parseKofiUrl(kofiUrl).tag ? ` | tag: <span class="text-emerald-400">${decodeURIComponent(parseKofiUrl(kofiUrl).tag || '')}</span>` : ''}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleRegister}
                      className="w-full py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-[#0f1117] font-bold text-xs tracking-wider uppercase transition-all flex items-center justify-center gap-1.5 shadow-[0_0_10px_rgba(16,185,129,0.15)] cursor-pointer"
                    >
                      <Check size={14} /> Register This Novel
                    </button>
                  </>
                )}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

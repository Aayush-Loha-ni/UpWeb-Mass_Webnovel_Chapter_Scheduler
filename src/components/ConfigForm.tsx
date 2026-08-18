import React, { useState } from 'react';
import { Sliders, RefreshCw, Check, X, HelpCircle, Users } from 'lucide-react';
import { NovelConfig } from '../types';
import { apiFetch } from '../lib/apiKey';
import Tooltip from './Tooltip';

interface PatreonTier {
  id: string;
  name: string;
  price: string;
}

interface PatreonCollections {
  selected: string[];
  hasSelectButton: boolean;
}

interface ConfigFormProps {
  config: NovelConfig;
  slug: string;
  name: string;
  onSave: (config: Partial<NovelConfig>) => void;
}

export default function ConfigForm({ config, slug, name, onSave }: ConfigFormProps) {
  const [tiers, setTiers] = useState<PatreonTier[]>([]);
  const [collections, setCollections] = useState<PatreonCollections | null>(null);
  const [fetching, setFetching] = useState(false);
  const [selectedTiers, setSelectedTiers] = useState<string[]>(config.patreon_tier_names || []);
  const [selectedTag, setSelectedTag] = useState(config.patreon_tag || '');
  const [fetchError, setFetchError] = useState('');
  const [kofiAudiences, setKofiAudiences] = useState<{ value: string; label: string }[]>([]);
  const [kofiAudienceName, setKofiAudienceName] = useState(config.kofi_tier_id || '');
  const [kofiFetching, setKofiFetching] = useState(false);
  const [kofiFetchError, setKofiFetchError] = useState('');

  const fetchPatreonInfo = async () => {
    setFetching(true);
    setFetchError('');
    try {
      const res = await apiFetch(`/api/v1/novels/${slug}/patreon-info`);
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { setFetchError('Server returned HTML — try refreshing the page. If it persists, restart the server.'); return; }
      if (!res.ok) {
        setFetchError(data.error || `HTTP ${res.status}`);
        return;
      }

      setTiers(data.tiers || []);
      setCollections(data.collections || null);
    } catch (e: any) {
      setFetchError(e.message || 'Network error');
    } finally {
      setFetching(false);
    }
  };

  const fetchKofiAudience = async () => {
    setKofiFetching(true);
    setKofiFetchError('');
    try {
      const res = await apiFetch(`/api/v1/novels/${slug}/kofi-audience`);
      const data = await res.json();
      if (!res.ok) { setKofiFetchError(data.error || `HTTP ${res.status}`); return; }
      setKofiAudiences(data.audiences || []);
      if (data.audiences?.length && !data.audiences.some((a: any) => a.label === kofiAudienceName)) {
        setKofiAudienceName(data.audiences[0].label);
      }
    } catch (e: any) {
      setKofiFetchError(e.message || 'Network error');
    } finally {
      setKofiFetching(false);
    }
  };

  const toggleTier = (name: string) => {
    setSelectedTiers(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider mb-4 flex items-center gap-2">
        <Sliders size={14} className="text-[#00f2fe]" /> Settings
      </h2>

      {config ? (
        <form onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
            onSave({
            target_lead: Number(formData.get('target_lead')),
            chapters_per_day: Number(formData.get('chapters_per_day')),
            batch_limit: Number(formData.get('batch_limit')),
            base_publish_time: String(formData.get('base_publish_time')),
            patreon_tier_id: String(formData.get('patreon_tier_id')),
            patreon_tier_names: selectedTiers,
            patreon_tag: selectedTag,
            inkstone_enabled: formData.get('inkstone_enabled') === 'true',
            patreon_enabled: formData.get('patreon_enabled') === 'true',
            kofi_enabled: formData.get('kofi_enabled') === 'true',
            kofi_url: String(formData.get('kofi_url') || ''),
            kofi_tier_id: kofiAudienceName,
            kofi_tag: String(formData.get('kofi_tag') || ''),
            auto_fill_gaps: formData.get('auto_fill_gaps') !== 'false',
            timezone: String(formData.get('timezone')),
          });
        }} className="flex flex-col gap-4">

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                <Tooltip text="How many chapters ahead Patreon must stay over Webnovel. Higher = more Patreon lead.">
                  <span className="inline-flex items-center gap-1">Patreon Lead <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </label>
              <input
                type="number"
                name="target_lead"
                defaultValue={config.target_lead}
                className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                <Tooltip text="Number of chapters published per day on each platform.">
                  <span className="inline-flex items-center gap-1">Chapters per Day <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </label>
              <input
                type="number"
                name="chapters_per_day"
                defaultValue={config.chapters_per_day}
                className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                <Tooltip text="Maximum chapters published in a single automation run. Prevents flooding.">
                  <span className="inline-flex items-center gap-1">Batch Limit <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </label>
              <input
                type="number"
                name="batch_limit"
                defaultValue={config.batch_limit}
                className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                <Tooltip text="Time of day when chapters should be published (HH:MM 24h format).">
                  <span className="inline-flex items-center gap-1">Release Time <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </label>
              <input
                type="text"
                name="base_publish_time"
                defaultValue={config.base_publish_time}
                placeholder="12:00"
                className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
          </div>

          {/* Patreon Tier ID (hidden behind accordion) */}
          <details className="text-[10px] font-mono text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">Advanced: Patreon API Tier ID</summary>
            <input
              type="text"
              name="patreon_tier_id"
              defaultValue={config.patreon_tier_id}
              className="mt-2 w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00f2fe]"
            />
          </details>

          {/* Patreon Tiers Selector */}
          <div className="border border-gray-800/50 rounded-lg p-3 bg-[#1e293b]/30">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Patreon Tiers</label>
              <button
                type="button"
                onClick={fetchPatreonInfo}
                disabled={fetching}
                className="flex items-center gap-1 px-2 py-1 rounded bg-[#1e293b] hover:bg-[#00f2fe]/20 border border-[#00f2fe]/30 text-[10px] font-mono text-[#00f2fe] transition-all disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw size={10} className={fetching ? 'animate-spin' : ''} />
                {fetching ? 'Fetching...' : 'Fetch from Patreon'}
              </button>
            </div>

            {fetchError && (
              <div className="flex items-center gap-1 text-[10px] font-mono text-red-400 mb-2">
                <X size={10} /> {fetchError}
              </div>
            )}

            {tiers.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {tiers.map((tier, i) => {
                  const checked = selectedTiers.includes(tier.name);
                  return (
                    <label
                      key={i}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors text-xs font-mono ${
                        checked ? 'bg-[#00f2fe]/10 border border-[#00f2fe]/30' : 'hover:bg-[#1e293b] border border-transparent'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTier(tier.name)}
                        className="accent-[#00f2fe]"
                      />
                      <span className="flex-1 text-slate-300">{tier.name}</span>
                      <span className="text-[10px] text-slate-500">{tier.price}</span>
                      {checked && <Check size={10} className="text-[#00f2fe]" />}
                    </label>
                  );
                })}
              </div>
            )}

            {selectedTiers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {selectedTiers.map(name => (
                  <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#00f2fe]/15 border border-[#00f2fe]/30 text-[10px] font-mono text-[#00f2fe]">
                    {name}
                    <button type="button" onClick={() => toggleTier(name)} className="hover:text-red-400 cursor-pointer">
                      <X size={8} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {tiers.length === 0 && !fetchError && !fetching && (
              <p className="text-[10px] font-mono text-slate-500 italic">Click "Fetch from Patreon" to load available tiers.</p>
            )}
          </div>

          {/* Patreon Tag */}
          <div className="border border-gray-800/50 rounded-lg p-3 bg-[#1e293b]/30">
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Patreon Collection / Tag</label>
            {collections && collections.selected.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-2">
                {collections.selected.map((col, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-[#1e293b] border border-gray-700 text-[10px] font-mono text-slate-400">
                    {col}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                type="text"
                value={selectedTag}
                onChange={e => setSelectedTag(e.target.value)}
                placeholder="Sinner's World"
                className="flex-1 px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00f2fe]"
              />
              {selectedTag && (
                <button type="button" onClick={() => setSelectedTag('')} className="px-2 py-1 rounded bg-[#1e293b] hover:bg-red-400/20 border border-gray-700 text-[10px] font-mono text-slate-400 hover:text-red-400 transition-all cursor-pointer">
                  <X size={12} />
                </button>
              )}
            </div>
            {collections && !collections.hasSelectButton ? (
              <p className="mt-1 text-[10px] font-mono text-amber-400/70">Collections section not found on the Patreon page. You may type a tag name manually.</p>
            ) : null}
          </div>

          {/* Ko-fi URL & Tag */}
          <details className="text-[10px] font-mono text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">Ko-fi Advanced</summary>
            <div className="mt-2 space-y-3">
              <div>
                <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Ko-fi URL</label>
                <input
                  type="text"
                  name="kofi_url"
                  defaultValue={config.kofi_url || ''}
                  placeholder="https://ko-fi.com/manage/posts"
                  className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00f2fe]"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Ko-fi Tag</label>
                <input
                  type="text"
                  name="kofi_tag"
                  defaultValue={config.kofi_tag || ''}
                  placeholder="tag_name"
                  className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00f2fe]"
                />
              </div>
            </div>
          </details>

          {/* Ko-fi Audience Selector */}
          <div className="border border-gray-800/50 rounded-lg p-3 bg-[#1e293b]/30">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Ko-fi Audience</label>
              <button
                type="button"
                onClick={fetchKofiAudience}
                disabled={kofiFetching}
                className="flex items-center gap-1 px-2 py-1 rounded bg-[#1e293b] hover:bg-[#00f2fe]/20 border border-[#00f2fe]/30 text-[10px] font-mono text-[#00f2fe] transition-all disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw size={10} className={kofiFetching ? 'animate-spin' : ''} />
                {kofiFetching ? 'Fetching...' : 'Fetch from Ko-fi'}
              </button>
            </div>

            {kofiFetchError && (
              <div className="flex items-center gap-1 text-[10px] font-mono text-red-400 mb-2">
                <X size={10} /> {kofiFetchError}
              </div>
            )}

            {kofiAudiences.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {kofiAudiences.map((a, i) => {
                  const checked = kofiAudienceName === a.label;
                  return (
                    <label
                      key={i}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors text-xs font-mono ${
                        checked ? 'bg-[#00f2fe]/10 border border-[#00f2fe]/30' : 'hover:bg-[#1e293b] border border-transparent'
                      }`}
                    >
                      <input
                        type="radio"
                        name="kofi_audience"
                        checked={checked}
                        onChange={() => setKofiAudienceName(a.label)}
                        className="accent-[#00f2fe]"
                      />
                      <span className="flex-1 text-slate-300">{a.label}</span>
                      {checked && <Check size={10} className="text-[#00f2fe]" />}
                    </label>
                  );
                })}
              </div>
            )}

            {kofiAudiences.length === 0 && !kofiFetchError && !kofiFetching && !kofiAudienceName && (
              <p className="text-[10px] font-mono text-slate-500 italic">Click "Fetch from Ko-fi" to load audience tiers.</p>
            )}

            {kofiAudienceName && (
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#00f2fe]/15 border border-[#00f2fe]/30 text-[10px] font-mono text-[#00f2fe]">
                  <Users size={10} /> {kofiAudienceName}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between p-2 rounded bg-[#1e293b]/50 border border-gray-800/50">
              <span className="text-xs text-slate-300 font-mono">
                <Tooltip text="Auto-fill sequence gaps with local chapters during resequence.">
                  <span className="inline-flex items-center gap-1">Auto-fill Gaps <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </span>
              <select
                name="auto_fill_gaps"
                defaultValue={String(config.auto_fill_gaps ?? true)}
                className="bg-transparent text-xs text-[#00f2fe] font-mono focus:outline-none"
              >
                <option value="true" className="bg-[#1e293b]">On</option>
                <option value="false" className="bg-[#1e293b]">Off</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                <Tooltip text="Timezone offset for Inkstone (e.g. 5.75 for Nepal, 8 for CST). Used in Inkstone API URL.">
                  <span className="inline-flex items-center gap-1">Timezone <HelpCircle size={10} className="text-slate-600" /></span>
                </Tooltip>
              </label>
              <input
                type="text"
                name="timezone"
                defaultValue={config.timezone || '5.75'}
                placeholder="5.75"
                className="w-full px-3 py-1.5 rounded bg-[#1e293b] border border-gray-800 text-sm font-mono text-[#00f2fe] focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex items-center justify-between p-2 rounded bg-[#1e293b]/50 border border-gray-800/50">
              <span className="text-xs text-slate-300 font-mono">Webnovel (Inkstone)</span>
              <select
                name="inkstone_enabled"
                defaultValue={String(config.inkstone_enabled)}
                className="bg-transparent text-xs text-[#00f2fe] font-mono focus:outline-none"
              >
                <option value="true" className="bg-[#1e293b]">Active</option>
                <option value="false" className="bg-[#1e293b]">Disabled</option>
              </select>
            </div>

            <div className="flex items-center justify-between p-2 rounded bg-[#1e293b]/50 border border-gray-800/50">
              <span className="text-xs text-slate-300 font-mono">Patreon</span>
              <select
                name="patreon_enabled"
                defaultValue={String(config.patreon_enabled)}
                className="bg-transparent text-xs text-[#00f2fe] font-mono focus:outline-none"
              >
                <option value="true" className="bg-[#1e293b]">Active</option>
                <option value="false" className="bg-[#1e293b]">Disabled</option>
              </select>
            </div>

            <div className="flex items-center justify-between p-2 rounded bg-[#1e293b]/50 border border-gray-800/50">
              <span className="text-xs text-slate-300 font-mono">Ko-fi</span>
              <select
                name="kofi_enabled"
                defaultValue={String(config.kofi_enabled ?? false)}
                className="bg-transparent text-xs text-[#00f2fe] font-mono focus:outline-none"
              >
                <option value="true" className="bg-[#1e293b]">Active</option>
                <option value="false" className="bg-[#1e293b]">Disabled</option>
              </select>
            </div>
          </div>

          <button
            type="submit"
            className="w-full mt-2 py-2 rounded bg-[#1e293b] hover:bg-[#00f2fe] hover:text-[#0f1117] border border-[#00f2fe]/40 font-mono text-xs font-bold tracking-wider transition-all cursor-pointer"
          >
            Save Settings
          </button>
        </form>
      ) : (
        <p className="text-xs text-slate-500 font-mono">No active novel configurations.</p>
      )}
    </div>
  );
}

import React from 'react';
import { Globe, ShieldAlert, Chrome } from 'lucide-react';

interface BrowserProfile {
  authenticated: boolean;
  cookie_age_hours?: number;
  profile_path?: string;
  session_expired?: boolean;
  session_max_hours?: number;
}

interface ConnectivityBarProps {
  inkstone: BrowserProfile;
  patreon: BrowserProfile;
  kofi?: BrowserProfile;
  onConnect: (platform: 'inkstone' | 'patreon' | 'kofi') => void;
  onDisconnect: (platform: 'inkstone' | 'patreon' | 'kofi') => void;
}

export default function ConnectivityBar({ inkstone, patreon, kofi = { authenticated: false }, onConnect, onDisconnect }: ConnectivityBarProps) {
  const renderProfile = (platform: 'inkstone' | 'patreon' | 'kofi', label: string, profile: BrowserProfile) => (
    <div className="bg-[#1e293b]/30 border border-gray-800 rounded-lg p-4">
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">{label}</h3>
          <p className="text-[10px] font-mono text-slate-500 mt-0.5 truncate max-w-[200px]" title={profile.profile_path || 'shared/browser_profile/' + platform + '/'}>
            Profile: {profile.profile_path || 'shared/browser_profile/' + platform + '/'}
          </p>
        </div>
        <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
          profile.authenticated
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
        }`}>
          {profile.authenticated ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
      </div>

      {profile.authenticated && profile.session_expired && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded p-2 text-xs font-mono mb-3 flex items-start gap-1.5 animate-pulse">
          <ShieldAlert size={15} className="text-rose-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">SESSION REJECTED</p>
            <p className="text-[10px] text-rose-400">The platform rejected the session. Reconnect to continue.</p>
          </div>
        </div>
      )}

      {profile.authenticated ? (
        <div className="flex items-center justify-between gap-4 mt-3 pt-3 border-t border-gray-800/50">
          <span className="text-xs font-mono text-slate-400">
            Age: {profile.cookie_age_hours ?? 0} hours
          </span>
          <button
            onClick={() => onDisconnect(platform)}
            className="px-2 py-1 rounded bg-rose-950/40 border border-rose-800/40 text-rose-400 hover:bg-rose-900/30 text-[10px] font-mono transition-all cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 mt-3 pt-3 border-t border-gray-800/50">
          <span className="text-xs font-mono text-slate-400">
            {platform === 'inkstone' ? 'Manual login required' : 'Not connected'}
          </span>
          <button
            onClick={() => onConnect(platform)}
            className="px-2.5 py-1 rounded bg-[#1e293b] border border-[#00f2fe]/30 text-[#00f2fe] hover:bg-[#00f2fe]/10 text-[10px] font-mono transition-all cursor-pointer flex items-center gap-1.5"
          >
            <Chrome size={12} className="text-[#00f2fe]" /> Connect
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl relative overflow-hidden">
      <div className="absolute top-0 right-0 h-24 w-24 bg-gradient-to-br from-teal-500/5 to-transparent rounded-full filter blur-xl" />
      <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider mb-4 flex items-center gap-2">
        <Globe size={14} className="animate-spin-slow text-[#00f2fe]" /> Connection Status
      </h2>

      <div className="flex flex-col gap-4">
        {renderProfile('inkstone', 'Webnovel / Inkstone', inkstone)}
        {renderProfile('patreon', 'Patreon', patreon)}
        {renderProfile('kofi', 'Ko-fi', kofi)}
      </div>
    </div>
  );
}

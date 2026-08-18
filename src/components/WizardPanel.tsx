import React from 'react';
import { Check, ChevronRight, ChevronLeft, Activity } from 'lucide-react';
import ConnectivityBar from './ConnectivityBar';
import ConfigForm from './ConfigForm';
import ExecutionControls from './ExecutionControls';
import TerminalConsole from './TerminalConsole';
import { NovelConfig, ProgressInfo } from '../types';

interface WizardPanelProps {
  step: number;
  onStepChange: (step: number) => void;
  inkstone: { authenticated: boolean; cookie_age_hours?: number; profile_path?: string };
  patreon: { authenticated: boolean; cookie_age_hours?: number; profile_path?: string };
  kofi?: { authenticated: boolean; cookie_age_hours?: number; profile_path?: string };
  onConnect: (platform: 'inkstone' | 'patreon' | 'kofi') => void;
  onDisconnect: (platform: 'inkstone' | 'patreon' | 'kofi') => void;
  config: NovelConfig;
  slug: string;
  name: string;
  onSaveConfig: (config: Partial<NovelConfig>) => void;
  isRunning: boolean;
  progress: ProgressInfo | null;
  onScrape: () => void;
  onPublish: (mode: 'single' | 'all', dryRun: boolean) => void;
  onResequence: () => void;
  onCleanup: (platform: string) => void;
  lastScrapedAt?: string | null;
  hasInkstoneAuth: boolean;
  hasPatreonAuth: boolean;
  hasKofiAuth?: boolean;
  terminalLogs: string[];
}

const steps = ['Connect', 'Configure', 'Execute', 'Monitor'];

export default function WizardPanel(props: WizardPanelProps) {
  const { step, onStepChange, ...rest } = props;

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div>
            <p className="text-xs font-mono text-slate-400 mb-4">Connect your platform profiles to enable scraping and publishing.</p>
            <ConnectivityBar
              inkstone={rest.inkstone}
              patreon={rest.patreon}
              kofi={rest.kofi}
              onConnect={rest.onConnect}
              onDisconnect={rest.onDisconnect}
            />
          </div>
        );
      case 1:
        return (
          <div>
            <p className="text-xs font-mono text-slate-400 mb-4">Configure publishing parameters for this novel.</p>
            <ConfigForm
              config={rest.config}
              slug={rest.slug}
              name={rest.name}
              onSave={rest.onSaveConfig}
            />
          </div>
        );
      case 2:
        return (
          <div>
            <p className="text-xs font-mono text-slate-400 mb-4">Scrape the current state and publish chapters.</p>
            <ExecutionControls
              isRunning={rest.isRunning}
              progress={rest.progress}
              onScrape={rest.onScrape}
              onPublish={rest.onPublish}
              onResequence={rest.onResequence}
              onCleanup={rest.onCleanup}
              lastScrapedAt={rest.lastScrapedAt}
              hasInkstoneAuth={rest.hasInkstoneAuth}
              hasPatreonAuth={rest.hasPatreonAuth}
            />
          </div>
        );
      case 3:
        return (
          <div>
            <p className="text-xs font-mono text-slate-400 mb-4">Live automation output and terminal stream.</p>
            <TerminalConsole logs={rest.terminalLogs} isRunning={rest.isRunning} />
          </div>
        );
    }
  };

  return (
    <div className="bg-[#131722] border border-gray-800 rounded-xl p-5 shadow-xl">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={14} className="text-[#00f2fe]" />
        <h2 className="text-xs font-mono font-bold text-[#00f2fe] uppercase tracking-wider">Quick Wizard</h2>
      </div>

      <div className="flex items-center gap-0 mb-6 mt-3">
        {steps.map((s, i) => (
          <React.Fragment key={s}>
            <button
              onClick={() => onStepChange(i)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                i === step
                  ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30'
                  : i < step
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-gray-800/30 text-slate-500 border border-gray-800/60'
              }`}
            >
              {i < step ? <Check size={10} /> : <span className="w-3 h-3 rounded-full border flex items-center justify-center text-[8px]">{i + 1}</span>}
              <span className="hidden sm:inline">{s}</span>
            </button>
            {i < steps.length - 1 && <ChevronRight size={12} className="text-slate-600 shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      <div className="min-h-[200px]">
        {renderStep()}
      </div>

      <div className="flex justify-between mt-4 pt-4 border-t border-gray-800/60">
        <button
          onClick={() => onStepChange(Math.max(0, step - 1))}
          disabled={step === 0}
          className="px-3 py-1.5 rounded bg-[#1e293b] border border-slate-700 text-slate-400 hover:text-slate-200 text-[10px] font-mono font-bold flex items-center gap-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <ChevronLeft size={12} /> Back
        </button>
        <div className="flex items-center gap-2">
          {step === 0 && !rest.inkstone.authenticated && !rest.patreon.authenticated && (
            <span className="text-[9px] text-amber-400/70 font-mono">Authenticate at least one platform first</span>
          )}
          <button
            onClick={() => onStepChange(Math.min(steps.length - 1, step + 1))}
            disabled={step === steps.length - 1 || (step === 0 && !rest.inkstone.authenticated && !rest.patreon.authenticated)}
            className="px-3 py-1.5 rounded bg-[#00f2fe]/10 border border-[#00f2fe]/30 text-[#00f2fe] hover:bg-[#00f2fe]/20 text-[10px] font-mono font-bold flex items-center gap-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Next <ChevronRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, LayoutDashboard, Wand2, Trash2, Calendar } from 'lucide-react';
import { NovelDetail, NovelConfig, Chapter, SequenceAudit, ProgressInfo, FailedPublish, LogEntry } from './types';
import KofiSupport from './components/KofiSupport';
import NovelTabs from './components/NovelTabs';
import ConnectivityBar from './components/ConnectivityBar';
import PlatformSummary from './components/PlatformSummary';
import SequenceAuditPanel from './components/SequenceAudit';
import ConfigForm from './components/ConfigForm';
import AuthorNotePanel from './components/AuthorNotePanel';
import ExecutionControls from './components/ExecutionControls';
import ChaptersTable from './components/ChaptersTable';
import TerminalConsole from './components/TerminalConsole';
import WelcomePanel from './components/WelcomePanel';
import StatusCards from './components/StatusCards';
import DashboardPanel from './components/DashboardPanel';
import ScheduledQueue from './components/ScheduledQueue';
import WizardPanel from './components/WizardPanel';
import FailedPublishesPanel from './components/FailedPublishesPanel';
import AlertModal from './components/modals/AlertModal';
import ConfirmModal from './components/modals/ConfirmModal';
import ToastContainer from './components/ToastContainer';
import CreateChapterModal from './components/modals/CreateChapterModal';
import RegisterNovelModal from './components/modals/RegisterNovelModal';import ChapterEditorModal from './components/modals/ChapterEditorModal';
import BrowserLoginModal from './components/modals/BrowserLoginModal';
import SessionLogsModal from './components/modals/SessionLogsModal';
import CleanupPreviewModal from './components/modals/CleanupPreviewModal';
import PublishPreview from './components/modals/PublishPreview';
import { apiFetch, bootstrapApiKey } from './lib/apiKey';
import { useUI } from './context/UIContext';

function extractErrorMessage(logs: string[]): string {
  const markers = ['[CRITICAL ERROR]', '[FAILED]', '[ERROR:'];
  for (const line of logs) {
    for (const marker of markers) {
      const idx = line.indexOf(marker);
      if (idx !== -1) return line.slice(idx + marker.length).trim();
    }
  }
  return 'Automation failed. Check terminal logs for details.';
}

export default function App() {
  const { addToast, clearToasts, triggerAlert, setModalConfirm, setToastReconnect, setToastAbort } = useUI();
  const [novels, setNovels] = useState<NovelDetail[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>(() => localStorage.getItem('activeNovelSlug') || '');
  const [loading, setLoading] = useState<boolean>(true);
  
  const [selectedChapters, setSelectedChapters] = useState<Set<number>>(new Set());
  const [showCreateChapter, setShowCreateChapter] = useState<boolean>(false);
  const [showRegisterModal, setShowRegisterModal] = useState<boolean>(false);
  const [newChapNum, setNewChapNum] = useState<number>(4);
  const [newChapTitle, setNewChapTitle] = useState<string>('');
  const [newChapBody, setNewChapBody] = useState<string>('');

  // Chromium manual login states
  const [showChromiumInkstone, setShowChromiumInkstone] = useState<boolean>(false);
  const [connectPlatform, setConnectPlatform] = useState<'inkstone' | 'patreon' | 'kofi'>('inkstone');
  const [connectStatus, setConnectStatus] = useState<string>('disconnected');
  const [connectLogs, setConnectLogs] = useState<string[]>([]);
  const connectLogsEndRef = useRef<HTMLDivElement>(null);

  // Chapter editor states
  const [showEditChapter, setShowEditChapter] = useState<boolean>(false);
  const [editingChapter, setEditingChapter] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editBody, setEditBody] = useState<string>('');
  const [editLoading, setEditLoading] = useState<boolean>(false);
  const [editFrontmatter, setEditFrontmatter] = useState<Record<string, any>>({});
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session logs states
  const [showSessionLogs, setShowSessionLogs] = useState<boolean>(false);
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedLogFile, setSelectedLogFile] = useState<string>('');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);

  // Wizard mode
  const [wizardMode, setWizardMode] = useState<boolean>(false);
  const [showDashboard, setShowDashboard] = useState<boolean>(false);
  const [showQueue, setShowQueue] = useState<boolean>(false);
  const [rollbackLoading, setRollbackLoading] = useState<boolean>(false);
  const [wizardStep, setWizardStep] = useState<number>(0);

  // Failed publishes dismiss
  const [dismissFailed, setDismissFailed] = useState<boolean>(false);

  // Cleanup preview (mirrors publish pattern: raw state + excluded set)
  const [cleanupPlan, setCleanupPlan] = useState<{ platform: string; plan: any[] } | null>(null);
  const [cleanupExcluded, setCleanupExcluded] = useState<Set<number>>(new Set());

  // Publish preview
  const [publishPlan, setPublishPlan] = useState<any>(null);
  const [publishPreviewLoading, setPublishPreviewLoading] = useState<boolean>(false);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // Auto-save chapter draft to localStorage (debounced 2s)
  useEffect(() => {
    if (!showEditChapter || !activeSlug || editingChapter === null) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const draft = { title: editTitle, body: editBody, frontmatter: editFrontmatter };
      localStorage.setItem(`draft_${activeSlug}_${editingChapter}`, JSON.stringify(draft));
    }, 2000);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [editTitle, editBody, editFrontmatter, showEditChapter, activeSlug, editingChapter]);

  const openChromiumInkstone = async (platform: 'inkstone' | 'patreon' | 'kofi' = 'inkstone') => {
    if (typeof platform !== 'string' || (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi')) {
      platform = 'inkstone';
    }
    setConnectPlatform(platform);
    setConnectStatus('launching');
    setConnectLogs([`Launching ${platform} browser...`]);
    setShowChromiumInkstone(true);
    try {
      const res = await apiFetch(`/api/v1/connect/${platform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: activeSlug || undefined }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 300) : ''}`);
      }
      const data = await res.json();
      if (data.success) {
        setConnectLogs(prev => [...prev, 'Browser launched! ...']);
        setConnectStatus('waiting_login');
        startConnectPolling(platform, activeSlug || undefined);
      } else {
        setConnectLogs(prev => [...prev, `Error: ${data.error || 'Failed to launch browser'}`]);
        setConnectStatus('error');
      }
    } catch (err: any) {
      setConnectLogs(prev => [...prev, `Connection error: ${err.message}`]);
      setConnectStatus('error');
    }
  };

  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    setToastReconnect(() => (platform: 'inkstone' | 'patreon' | 'kofi') => openChromiumInkstone(platform));
    setToastAbort(() => handleAbort);
  }, []);

  const startConnectPolling = (platform: string, slug?: string) => {
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/v1/connect/${platform}/status${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setConnectStatus(data.status);
        if (data.logs && data.logs.length > 0) {
          setConnectLogs(prev => {
            const prevSet = new Set(prev);
            const newLogs = data.logs.filter((l: unknown): l is string => typeof l === 'string' && !prevSet.has(l));
            return newLogs.length > 0 ? [...prev, ...newLogs] : prev;
          });
        }
        if (data.status === 'connected') {
          setConnectLogs(prev => [...prev, 'Login complete! Cookies saved. Browser is ready for scraping.']);
          if (activeSlug) await loadNovelDetails(activeSlug);
          await fetchGlobalBrowserStatus();
          return;
        }
        if (data.status === 'error' || data.status === 'disconnected') {
          return;
        }
        pollTimeoutRef.current = setTimeout(poll, 2000);
      } catch {
        setConnectLogs(prev => [...prev, '[Poll] Status check failed, retrying...']);
        pollTimeoutRef.current = setTimeout(poll, 3000);
      }
    };
    poll();
  };

  // Global browser profile connections (essential for empty-state and scraping flows)
  const [globalBrowserStatus, setGlobalBrowserStatus] = useState<{
    inkstone: { authenticated: boolean; user?: string; cookie_age_hours?: number; profile_path?: string; session_expired?: boolean } | null;
    patreon: { authenticated: boolean; user?: string; cookie_age_hours?: number; profile_path?: string; session_expired?: boolean } | null;
    kofi: { authenticated: boolean; user?: string; cookie_age_hours?: number; profile_path?: string; session_expired?: boolean } | null;
  }>({ inkstone: null, patreon: null, kofi: null });

  // Registration state
  const [registerUrlSlug, setRegisterUrlSlug] = useState<string>('');

  // Interactive Live log streaming
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [showEditTracker, setShowEditTracker] = useState<boolean>(false);
  const [inkstoneAudit, setInkstoneAudit] = useState<SequenceAudit | null>(null);
  const [patreonAudit, setPatreonAudit] = useState<SequenceAudit | null>(null);
  const [kofiAudit, setKofiAudit] = useState<SequenceAudit | null>(null);
  const [sequenceCheck, setSequenceCheck] = useState<any>(null);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch novels and global status on mount
  const novelDetailsCache = useRef<Map<string, { timestamp: number }>>(new Map());
  const sequenceCache = useRef<Map<string, { timestamp: number }>>(new Map());
  const CACHE_TTL = 30000;

  useEffect(() => {
    // Bootstrap the API key before any authenticated request (same-origin SPA).
    bootstrapApiKey();
    fetchNovels();
    const sendShutdown = () => navigator.sendBeacon('/api/v1/shutdown', '');
    window.addEventListener('beforeunload', sendShutdown);
    return () => window.removeEventListener('beforeunload', sendShutdown);
  }, []);

  // Periodically poll browser connection status
  useEffect(() => {
    const interval = setInterval(() => {
      fetchGlobalBrowserStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchGlobalBrowserStatus = async () => {
    try {
      const res = await apiFetch('/api/v1/browser/status');
      if (res.ok) {
        const data = await res.json();
        setGlobalBrowserStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch global browser status', e);
    }
  };

  const fetchNovels = async (preserveActiveSlug?: string) => {
    try {
      setLoading(true);
      const [novelsRes] = await Promise.all([
        apiFetch('/api/v1/novels'),
        fetchGlobalBrowserStatus(),
      ]);
      const data = await novelsRes.json();
      setNovels(data);
      setLoading(false);
      if (data.length > 0) {
        const nextSlug = preserveActiveSlug || activeSlug || localStorage.getItem('activeNovelSlug') || data[0].slug;
        setActiveSlug(nextSlug);
        loadNovelDetails(nextSlug);
      }
    } catch (e) {
      console.error('Failed to fetch novels registry', e);
      setLoading(false);
    }
  };

  const loadNovelDetails = async (slug: string) => {
    const cached = novelDetailsCache.current.get(slug);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const details = await res.json();
      novelDetailsCache.current.set(slug, { timestamp: Date.now() });
      setNovels(prev => prev.map(n => n.slug === slug ? { ...n, ...details } : n));
      
      if (details.tracker) {
        const staleRunning = details.tracker.execution_status === 'running' && details.tracker.auth_error;
        setIsRunning(details.tracker.execution_status === 'running' && !staleRunning);
        setTerminalLogs(details.tracker.last_run_logs || []);
        if (details.tracker.execution_status !== 'running' || staleRunning) setProgress(null);
      }
      sequenceCache.current.delete(slug);
      fetchSequence(slug);
    } catch (e) {
      console.error(`Failed to load details for ${slug}`, e);
    }
  };

  const fetchSequence = async (slug: string, force?: boolean) => {
    const cached = sequenceCache.current.get(slug);
    if (!force && cached && Date.now() - cached.timestamp < CACHE_TTL) return;
    try {
      const [auditRes, checkRes] = await Promise.all([
        apiFetch(`/api/v1/novels/${slug}/sequence`),
        apiFetch(`/api/v1/novels/${slug}/sequence-check`),
      ]);
      if (auditRes.ok) {
        const data = await auditRes.json();
        setInkstoneAudit(data.inkstone);
        setPatreonAudit(data.patreon);
        setKofiAudit(data.kofi);
      }
      if (checkRes.ok) {
        setSequenceCheck(await checkRes.json());
      }
      sequenceCache.current.set(slug, { timestamp: Date.now() });
    } catch (e) {
      console.error('Failed to fetch sequence data', e);
    }
  };

  const activeNovel = novels.find(n => n.slug === activeSlug);
  const inkstoneExpired = activeNovel?.browser?.inkstone?.session_expired ?? globalBrowserStatus.inkstone?.session_expired ?? false;
  const patreonExpired = activeNovel?.browser?.patreon?.session_expired ?? globalBrowserStatus.patreon?.session_expired ?? false;
  const failedPublishes = ((sequenceCheck?.failed_publishes || []) as FailedPublish[]).filter(
    f => !dismissFailed
  );

  // Background polling for terminal logs during executions
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isRunning && activeSlug) {
      interval = setInterval(async () => {
        try {
          const res = await apiFetch(`/api/v1/novels/${activeSlug}/logs`);
          const data = await res.json();
          setTerminalLogs(data.logs || []);
          setProgress(data.progress || null);
          if (data.pending_decision) {
            setPendingDecision(data.pending_decision);
          } else {
            setPendingDecision(null);
          }
          if (data.auth_error && !showChromiumInkstone) {
            addToast(data.auth_error.platform, data.auth_error.message);
            openChromiumInkstone(data.auth_error.platform);
            setIsRunning(false);
          } else if (!data.auth_error) {
            clearToasts();
          }
          if (data.execution_status !== 'running') {
            setIsRunning(false);
            if (data.execution_status === 'failed') {
              const errMsg = extractErrorMessage(data.logs || []);
              triggerAlert(errMsg, 'error');
            }
            novelDetailsCache.current.delete(activeSlug);
            loadNovelDetails(activeSlug);
          }
        } catch (e) {
          console.error('Error polling active logs', e);
          setIsRunning(false);
          triggerAlert('Connection lost while automation was running.', 'error');
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRunning, activeSlug]);

  // Autoscroll terminal during runs; scroll to top when done
  const prevLogsRef = useRef<string[]>([]);
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    if (!isRunning && prevRunningRef.current) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (isRunning && (prevLogsRef.current.length !== terminalLogs.length || prevLogsRef.current.some((v, i) => v !== terminalLogs[i]))) {
      logEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
    prevLogsRef.current = terminalLogs;
  }, [terminalLogs, isRunning]);

  // Save Config parameters asynchronously
  const handleSaveConfig = async (updatedConfig: Partial<NovelConfig>) => {
    if (!activeNovel) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      const data = await res.json();
      setNovels(prev => prev.map(n => n.slug === activeSlug ? { ...n, config: data } : n));
      triggerAlert('Cascading configuration updated successfully.', 'success');
    } catch (e) {
      triggerAlert('Failed to update config parameters.', 'error');
    }
  };

  // Toggle Physical OS Lock
  const handleToggleLock = async (chapterNum: number, currentLocked: boolean) => {
    if (!activeNovel) return;
    try {
      const endpoint = currentLocked 
        ? `/api/v1/novels/${activeSlug}/chapters/${chapterNum}/unlock`
        : `/api/v1/novels/${activeSlug}/chapters/${chapterNum}/lock`;
      
      const res = await apiFetch(endpoint, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      if (data.success) {
        setNovels(prev => prev.map(n => {
          if (n.slug === activeSlug && n.chapters) {
            return {
              ...n,
              chapters: n.chapters.map(ch => ch.chapter_number === chapterNum ? { ...ch, is_locked: data.is_locked } : ch)
            };
          }
          return n;
        }));
      }
    } catch (e) {
      console.error('Lock modification failure', e);
      triggerAlert('Lock operation failed.', 'error');
    }
  };

  const handleDeleteChapter = async (chapterNum: number) => {
    if (!activeSlug) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/${chapterNum}`, { method: 'DELETE' });
      if (res.ok) {
        triggerAlert(`Chapter ${chapterNum} deleted.`, 'success');
        setSelectedChapters(prev => { const n = new Set(prev); n.delete(chapterNum); return n; });
        await loadNovelDetails(activeSlug);
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Failed to delete chapter.', 'error');
      }
    } catch {
      triggerAlert('Error deleting chapter.', 'error');
    }
  };

  const handleBatchDelete = async () => {
    const nums = [...selectedChapters].sort((a, b) => b - a);
    let ok = 0;
    for (const num of nums) {
      try {
        const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/${num}`, { method: 'DELETE' });
        if (res.ok) ok++;
      } catch {}
    }
    setSelectedChapters(new Set());
    triggerAlert(`${ok}/${nums.length} chapters deleted.`, ok > 0 ? 'success' : 'error');
    if (ok > 0) await loadNovelDetails(activeSlug);
  };

  // Create Novel
  const handleRegisterNovel = async (slug: string, name: string, patreonTierId?: string, patreonTag?: string, kofiUrl?: string, kofiTierId?: string, kofiTag?: string) => {
    try {
      const res = await apiFetch('/api/v1/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name, patreon_tier_id: patreonTierId, patreon_tag: patreonTag, kofi_url: kofiUrl, kofi_tier_id: kofiTierId, kofi_tag: kofiTag }),
      });
      if (res.ok) {
        await fetchNovels(slug);
        setShowRegisterModal(false);
        triggerAlert(`Novel "${name}" registered.`, 'success');
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Failed to register novel.', 'error');
      }
    } catch (e: any) {
      const msg = e?.message === 'Failed to fetch' ? 'Cannot reach server. Is the app running?' : (e?.message || 'Failed to register novel.');
      triggerAlert(msg, 'error');
    }
  };

  // Resequence scheduled chapters
  const handleResequence = async () => {
    if (!activeNovel) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeNovel.slug}/resequence`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setIsRunning(true);
      } else {
        triggerAlert(data.error || 'Resequence failed to start.', 'error');
      }
    } catch (e) {
      console.error('Resequence error', e);
      triggerAlert('Error during resequence.', 'error');
    }
  };

  // Create Chapter File
  const handleCreateChapter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChapNum || !newChapTitle || !newChapBody || !activeSlug) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapter_number: Number(newChapNum),
          title: newChapTitle,
          body: newChapBody
        }),
      });
      if (res.ok) {
        setShowCreateChapter(false);
        setNewChapTitle('');
        setNewChapBody('');
        await loadNovelDetails(activeSlug);
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Failed to create chapter file.', 'error');
      }
    } catch (e) {
      triggerAlert('Error creating chapter file.', 'error');
    }
  };

  // Dispatch Scraper
  const handleTriggerScrape = async () => {
    if (!activeSlug || isRunning) return;
    try {
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Dispatching scraping worker thread...`]);
      setIsRunning(true);
      const scrapeRes = await apiFetch(`/api/v1/novels/${activeSlug}/scrape`, { method: 'POST' });
      if (!scrapeRes.ok) throw new Error(`Server returned ${scrapeRes.status}`);
    } catch (e) {
      setIsRunning(false);
      triggerAlert('Scrape failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  const handleAbort = async () => {
    if (!activeSlug) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/abort`, { method: 'POST' });
      const data = await res.json();
      if (data.was_running) triggerAlert('Automation aborted.', 'info');
    } catch (e) {
      triggerAlert('Abort failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  const handleDecision = async (choice: 'bulk' | 'limit') => {
    if (!activeSlug) return;
    setPendingDecision(null);
    try {
      await apiFetch(`/api/v1/novels/${activeSlug}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
    } catch (e) {
      triggerAlert('Failed to send decision: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  const handleResetStuckStatus = async () => {
    if (!activeSlug) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/reset-status`, { method: 'POST' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setIsRunning(false);
      setProgress(null);
      await loadNovelDetails(activeSlug);
      triggerAlert('Tracker status reset to idle.', 'success');
    } catch (e) {
      triggerAlert('Reset failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  // Show preview, then publish on confirm
  const handlePublishPreview = async () => {
    if (!activeSlug || isRunning || publishPreviewLoading) return;
    setPublishPreviewLoading(true);
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/publish-preview`, { method: 'POST' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const plan = await res.json();
      setPublishPlan(plan);
    } catch (e: any) {
      triggerAlert('Failed to generate preview: ' + e.message, 'error');
    } finally {
      setPublishPreviewLoading(false);
    }
  };

  const handleConfirmPublish = async () => {
    if (!activeSlug || isRunning || publishPreviewLoading || !publishPlan) return;
    const previousPlan = publishPlan;
    setPublishPlan(null);
    setPublishPreviewLoading(false);
    try {
      const pubRes = await apiFetch(`/api/v1/novels/${activeSlug}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all', dry_run: false, previous_plan: previousPlan })
      });
      const data = await pubRes.json();
      if (data.stale) {
        // Plan changed since preview — show updated version
        setPublishPlan(data.plan);
        triggerAlert('Publish plan changed since preview. Review and confirm again.', 'info');
        return;
      }
      if (!pubRes.ok) throw new Error(`Server returned ${pubRes.status}`);
      setTerminalLogs([
        `[${new Date().toLocaleTimeString()}] Initiating publishing sequence...`
      ]);
      setIsRunning(true);
    } catch (e) {
      setIsRunning(false);
      triggerAlert('Publish failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  // Single-chapter publish (direct, no preview)
  const handlePublishSingleChapter = async (chapterNumber: number) => {
    if (!activeSlug || isRunning) return;
    try {
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Publishing Ch ${chapterNumber}...`]);
      setIsRunning(true);
      const pubRes = await apiFetch(`/api/v1/novels/${activeSlug}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', chapter_number: chapterNumber, dry_run: false })
      });
      if (!pubRes.ok) throw new Error(`Server returned ${pubRes.status}`);
      triggerAlert(`Publishing Chapter ${chapterNumber}...`, 'info');
    } catch (e) {
      setIsRunning(false);
      triggerAlert('Publish failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    }
  };

  // Dispatch Publisher (direct — used for dry-run only now)
  const handleTriggerPublish = async (mode: 'single' | 'all', dryRun: boolean) => {
    if (dryRun) {
      // Direct dry-run
      if (!activeSlug || isRunning) return;
      try {
        setTerminalLogs([
          `[${new Date().toLocaleTimeString()}] Initiating publishing sequence. Mode: ${mode.toUpperCase()}, DryRun: ${dryRun}...`
        ]);
        setIsRunning(true);
        const pubRes = await apiFetch(`/api/v1/novels/${activeSlug}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, dry_run: dryRun })
        });
        if (!pubRes.ok) throw new Error(`Server returned ${pubRes.status}`);
      } catch (e) {
        setIsRunning(false);
        triggerAlert('Publish failed: ' + (e instanceof Error ? e.message : 'Unknown error'), 'error');
      }
    } else {
      // Live publish — show preview first
      await handlePublishPreview();
    }
  };

  const handleCleanup = async (platform: string = 'inkstone') => {
    if (!activeSlug || isRunning) return;
    try {
      setIsRunning(true);
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Running ${platform} cleanup (preview)...`]);
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/cleanup?platform=${platform}&dryRun=true`, { method: 'POST' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      const planEntries = data.plan || [];
      setCleanupPlan({ platform, plan: planEntries });
      setCleanupExcluded(new Set());
    } catch (e) {
      triggerAlert(`${platform} cleanup failed: ` + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleCleanupConfirm = async () => {
    if (!activeSlug || !cleanupPlan) return;
    const { platform } = cleanupPlan;
    const exclude = [...cleanupExcluded];
    setCleanupPlan(null);
    try {
      setIsRunning(true);
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Running ${platform} cleanup...`]);
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/cleanup?platform=${platform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclude: exclude.length ? exclude : undefined }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const result = await res.json();
      triggerAlert(`[${platform}] Cleanup: ${result.deletedDuplicates ?? 0} dups, ${result.deletedOutOfOrder ?? 0} ooo, ${result.deletedTitleRegex ?? 0} regex, ${result.deletedOutliers ?? 0} outliers, ${result.deletedEmptyTitle ?? 0} empty, ${result.deletedUnscheduled ?? 0} unsched`, 'success');
      await loadNovelDetails(activeSlug);
    } catch (e) {
      triggerAlert(`${platform} cleanup failed: ` + (e instanceof Error ? e.message : 'Unknown error'), 'error');
    } finally {
      setIsRunning(false);
    }
  };

  // Rollback last failed batch
  const handleRollbackLastBatch = async () => {
    if (!activeSlug) return;
    setRollbackLoading(true);
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/rollback-last-batch`, { method: 'POST' });
      if (res.ok) {
        triggerAlert('Rollback completed. Refreshing...', 'success');
        await loadNovelDetails(activeSlug);
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Rollback failed.', 'error');
      }
    } catch {
      triggerAlert('Rollback request failed.', 'error');
    } finally {
      setRollbackLoading(false);
    }
  };

  // Disconnect credentials
  const handleProfileLogout = async (platform: 'inkstone' | 'patreon' | 'kofi') => {
    setModalConfirm({
      title: 'Disconnect Profile',
      message: `Are you sure you want to disconnect your sandboxed browser profile for ${platform === 'inkstone' ? 'Webnovel/Inkstone' : platform === 'patreon' ? 'Patreon' : 'Ko-fi'}?`,
      onConfirm: async () => {
        try {
          const res = await apiFetch('/api/v1/browser/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, slug: activeSlug || undefined }),
          });
          const data = await res.json();
          if (data.success) {
            if (activeSlug) {
              await loadNovelDetails(activeSlug);
            }
            await fetchGlobalBrowserStatus();
            triggerAlert(`Successfully disconnected ${platform === 'inkstone' ? 'Webnovel/Inkstone' : platform === 'patreon' ? 'Patreon' : 'Ko-fi'} profile.`, 'success');
          }
        } catch (e) {
          triggerAlert('Logout simulator failed.', 'error');
        }
      }
    });
  };

  // Delete the currently active novel and its workspace directory
  const handleDeleteNovel = async (slug: string, name: string) => {
    setModalConfirm({
      title: 'Delete Novel',
      message: `Are you sure you want to delete "${name}"? This will permanently remove its local directories, all chapter drafts, configuration, and execution logs.`,
      onConfirm: async () => {
        try {
          const res = await apiFetch(`/api/v1/novels/${slug}`, {
            method: 'DELETE'
          });

          if (res.ok) {
            triggerAlert(`Novel "${name}" was successfully deleted.`, 'success');
            setNovels(prev => prev.filter(n => n.slug !== slug));
            const remainingNovels = novels.filter(n => n.slug !== slug);
            if (remainingNovels.length > 0) {
              const newActive = remainingNovels[0].slug;
              setActiveSlug(newActive);
              localStorage.setItem('activeNovelSlug', newActive);
              await loadNovelDetails(newActive);
            } else {
              setActiveSlug('');
              localStorage.removeItem('activeNovelSlug');
            }
          } else {
            const err = await res.json();
            triggerAlert(err.error || 'Failed to delete the novel.', 'error');
          }
        } catch (err: any) {
          console.error('Delete error', err);
          triggerAlert('Error occurred while deleting the novel.', 'error');
        }
      }
    });
  };

  // Upload parsed chapter file directly
  const handleChapterFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeSlug) return;

    setUploadProgress(0);
    const maxSize = 10 * 1024 * 1024;
    const formData = new FormData();
    let skipped = 0;
    for (const file of files) {
      if (file.size > maxSize) { skipped++; continue; }
      formData.append('files', file);
    }
    if (skipped > 0) triggerAlert(`${skipped} file(s) skipped (>10MB).`, 'error');

    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/upload`, {
        method: 'POST',
        body: formData,
      });

      setUploadProgress(null);
      const data = await res.json();
      if (res.ok && data.success) {
        const ok = data.processed || 0;
        const errs = data.errors || [];
        const lines = [`${ok}/${files.length} files uploaded`];
        if (errs.length > 0) lines.push(errs.map((x: { file_name: string; error: string }) => `${x.file_name}: ${x.error}`).join('; '));
        triggerAlert(lines.join('. '), ok > 0 ? 'success' : 'error');
        if (ok > 0) await loadNovelDetails(activeSlug);
        setUploadProgress(100);
      } else {
        triggerAlert(data.error || 'Upload failed.', 'error');
      }
    } catch (err: any) {
      setUploadProgress(null);
      triggerAlert('Error uploading files.', 'error');
    } finally {
      setTimeout(() => setUploadProgress(null), 2000);
      if (e.target) e.target.value = '';
    }
  };

  const toNum = (val: FormDataEntryValue | null, fallback = 0): number => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };

  // Manual save for platform tracker state
  const handleSaveTracker = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeSlug) return;

    const formData = new FormData(e.currentTarget);
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/tracker`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webnovel_last: toNum(formData.get('webnovel_last')),
          patreon_last: toNum(formData.get('patreon_last')),
          inkstone_scheduled_count: toNum(formData.get('inkstone_scheduled_count')),
          patreon_scheduled_count: toNum(formData.get('patreon_scheduled_count')),
          next_schedule_date: formData.get('next_schedule_date') ? String(formData.get('next_schedule_date')) : null,
        })
      });

      if (res.ok) {
        const data = await res.json();
        setNovels(prev => prev.map(n => n.slug === activeSlug ? { ...n, tracker: data.tracker } : n));
        setShowEditTracker(false);
        triggerAlert('Platform status and scheduled tracking details updated.', 'success');
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Failed to update sync tracker status.', 'error');
      }
    } catch (err) {
      console.error('Tracker save error', err);
      triggerAlert('Error updating tracker.', 'error');
    }
  };

  // Update chapter content on platform
  const handleUpdatePlatform = async (chapterNum: number) => {
    if (!activeSlug) return;
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/${chapterNum}/update-platform`, { method: 'POST' });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      const data = await res.json();
      if (data.success) {
        triggerAlert(`Chapter ${chapterNum} updated on platform.`, 'success');
      } else {
        const errors = (data.results as { platform: string; success: boolean; error?: string }[])?.filter(r => !r.success).map(r => `${r.platform}: ${r.error}`).join('; ') || 'Unknown error';
        triggerAlert(`Chapter ${chapterNum} update failed: ${errors}`, 'error');
      }
    } catch (e: any) {
      triggerAlert('Failed to update chapter on platform: ' + e.message, 'error');
    }
  };

  // Chapter editor handlers
  const handleOpenChapterEditor = async (chapterNum: number) => {
    if (!activeSlug) return;
    setEditingChapter(chapterNum);
    setEditLoading(true);
    setShowEditChapter(true);
    setEditFrontmatter({});
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/${chapterNum}`);
      if (res.ok) {
        const data = await res.json();
        setEditTitle(data.title || '');
        setEditBody(data.body || '');
        setEditFrontmatter(data.frontmatter || {});
        const saved = localStorage.getItem(`draft_${activeSlug}_${chapterNum}`);
        if (saved) {
          try {
            const draft = JSON.parse(saved);
            if (draft.title || draft.body) {
              setEditTitle(draft.title || '');
              setEditBody(draft.body || '');
              setEditFrontmatter(draft.frontmatter || {});
            }
          } catch {}
        }
      } else {
        triggerAlert('Failed to load chapter content.', 'error');
        setShowEditChapter(false);
      }
    } catch {
      triggerAlert('Error loading chapter.', 'error');
      setShowEditChapter(false);
      setEditingChapter(null);
    } finally {
      setEditLoading(false);
    }
  };

  const handleSaveChapter = async () => {
    if (!activeSlug || editingChapter === null) return;
    setEditLoading(true);
    try {
      const res = await apiFetch(`/api/v1/novels/${activeSlug}/chapters/${editingChapter}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, body: editBody, frontmatter: editFrontmatter }),
      });
      if (res.ok) {
        localStorage.removeItem(`draft_${activeSlug}_${editingChapter}`);
        triggerAlert(`Chapter ${editingChapter} saved.`, 'success');
        setShowEditChapter(false);
        setEditingChapter(null);
        await loadNovelDetails(activeSlug);
      } else {
        const err = await res.json();
        triggerAlert(err.error || 'Failed to save chapter.', 'error');
      }
    } catch {
      triggerAlert('Error saving chapter.', 'error');
    } finally {
      setEditLoading(false);
    }
  };

  // Session logs handlers
  const handleLoadLogFiles = async () => {
    setLogsLoading(true);
    try {
      const res = await apiFetch('/api/v1/logs');
      if (res.ok) {
        const data = await res.json();
        setLogFiles(data.files || []);
      }
    } catch {
      triggerAlert('Failed to load log files.', 'error');
    } finally {
      setLogsLoading(false);
    }
  };

  const handleLoadLogFile = async (filename: string) => {
    setSelectedLogFile(filename);
    setLogsLoading(true);
    try {
      const res = await apiFetch(`/api/v1/logs/${filename}`);
      if (res.ok) {
        const data = await res.json();
        setLogEntries(data.entries as LogEntry[] || []);
      }
    } catch {
      triggerAlert('Failed to load log entries.', 'error');
    } finally {
      setLogsLoading(false);
    }
  };

  const isInkstoneAuth = activeNovel?.browser?.inkstone?.authenticated ?? globalBrowserStatus.inkstone?.authenticated ?? false;
  const inkstoneProfile = activeNovel?.browser?.inkstone?.profile_path ?? globalBrowserStatus.inkstone?.profile_path ?? 'shared/browser_profile/inkstone/';
  const inkstoneAge = activeNovel?.browser?.inkstone?.cookie_age_hours ?? globalBrowserStatus.inkstone?.cookie_age_hours ?? 0;
  const isPatreonAuth = activeNovel?.browser?.patreon?.authenticated ?? globalBrowserStatus.patreon?.authenticated ?? false;
  const patreonProfile = activeNovel?.browser?.patreon?.profile_path ?? globalBrowserStatus.patreon?.profile_path ?? 'shared/browser_profile/patreon/';
  const patreonAge = activeNovel?.browser?.patreon?.cookie_age_hours ?? globalBrowserStatus.patreon?.cookie_age_hours ?? 0;
  const kofiExpired = activeNovel?.browser?.kofi?.session_expired ?? globalBrowserStatus.kofi?.session_expired ?? false;
  const kofiProfile = activeNovel?.browser?.kofi?.profile_path ?? globalBrowserStatus.kofi?.profile_path ?? 'shared/browser_profile/kofi/';
  const kofiAge = activeNovel?.browser?.kofi?.cookie_age_hours ?? globalBrowserStatus.kofi?.cookie_age_hours ?? 0;
  const isKofiAuth = activeNovel?.browser?.kofi?.authenticated ?? globalBrowserStatus.kofi?.authenticated ?? false;
  return (
    <div className="min-h-screen bg-[#0f1117] text-[#e2e8f0] font-sans selection:bg-[#00f2fe] selection:text-[#0f1117]">
      <KofiSupport className="fixed bottom-4 right-4 z-50" />
      {/* Upper Glowing Frame */}
      <div className="h-1 bg-gradient-to-r from-blue-500 via-teal-400 to-purple-600 animate-pulse" />

      {/* Main Container */}
      <div className="max-w-7xl mx-auto px-4 py-6 md:py-10">
        
        <NovelTabs
          novels={novels}
          activeSlug={activeSlug}
          onSelect={(slug) => { setActiveSlug(slug); localStorage.setItem('activeNovelSlug', slug); setShowDashboard(false); loadNovelDetails(slug); }}
          onShowLogs={() => { setShowSessionLogs(true); handleLoadLogFiles(); }}
          onRegister={() => setShowRegisterModal(true)}
          onDelete={(slug, name) => handleDeleteNovel(slug, name)}
        />

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowDashboard(!showDashboard); setShowQueue(false); if (!showDashboard) { setWizardMode(false); setShowQueue(false); } }}
              className={`px-3 py-1.5 rounded text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                showDashboard
                  ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30'
                  : 'bg-[#1e293b] text-slate-400 border border-slate-700 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard size={12} /> Dashboard
            </button>
            <button
              onClick={() => { setWizardMode(false); setShowDashboard(false); setShowQueue(false); }}
              className={`px-3 py-1.5 rounded text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                !wizardMode && !showDashboard && !showQueue
                  ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30'
                  : 'bg-[#1e293b] text-slate-400 border border-slate-700 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard size={12} /> Detail
            </button>
            <button
              onClick={() => { setWizardMode(true); setShowDashboard(false); setShowQueue(false); }}
              className={`px-3 py-1.5 rounded text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                wizardMode
                  ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30'
                  : 'bg-[#1e293b] text-slate-400 border border-slate-700 hover:text-slate-200'
              }`}
            >
              <Wand2 size={12} /> Wizard
            </button>
            <button
              onClick={() => { setShowQueue(!showQueue); setShowDashboard(false); setWizardMode(false); }}
              className={`px-3 py-1.5 rounded text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                showQueue
                  ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30'
                  : 'bg-[#1e293b] text-slate-400 border border-slate-700 hover:text-slate-200'
              }`}
            >
              <Calendar size={12} /> Queue
            </button>

            {activeNovel && (
              <button
                onClick={() => handleDeleteNovel(activeNovel.slug, activeNovel.config?.name || activeNovel.slug)}
                className="ml-auto px-3 py-1.5 rounded bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/60 hover:text-red-300 text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <Trash2 size={12} /> Delete Selected Novel
              </button>
            )}
          </div>
        </div>

        {activeNovel && !wizardMode && (
          <StatusCards
            inkstoneAuth={isInkstoneAuth}
            inkstoneAge={inkstoneAge}
            patreonAuth={isPatreonAuth}
            patreonAge={patreonAge}
            chaptersCount={activeNovel?.chapters?.length ?? 0}
            lockedCount={activeNovel?.chapters?.filter(c => c.is_locked).length ?? 0}
            leadBuffer={(activeNovel?.config?.patreon_enabled
              ? (activeNovel?.tracker?.patreon_last ?? 0)
              : (activeNovel?.config?.kofi_enabled ? (activeNovel?.tracker?.kofi_last ?? 0) : 0)) - (activeNovel?.tracker?.webnovel_last ?? 0)}
            targetLead={activeNovel?.config?.target_lead ?? 15}
            lastScrapedAt={activeNovel?.tracker?.last_scraped_at}
            isRunning={isRunning}
            executionStatus={activeNovel?.tracker?.execution_status}
          />
        )}

        {activeNovel && !wizardMode && failedPublishes.length > 0 && (
          <FailedPublishesPanel
            failed={failedPublishes}
            onRetryAll={() => handleTriggerPublish('all', false)}
            onDismiss={() => setDismissFailed(true)}
            onRollback={handleRollbackLastBatch}
            rollbackLoading={rollbackLoading}
          />
        )}

        {showDashboard ? (
          <DashboardPanel />
        ) : showQueue && activeNovel ? (
          <div className="bg-[#131722] border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Calendar size={16} className="text-[#00f2fe]" /> Scheduled Queue — {activeNovel.config?.name}
            </h3>
            <ScheduledQueue
              slug={activeSlug}
              inkstone={activeNovel.tracker?.inkstone_scheduled || []}
              patreon={activeNovel.tracker?.patreon_scheduled || []}
              inkstoneAudit={inkstoneAudit}
              patreonAudit={patreonAudit}
              onUpdate={() => loadNovelDetails(activeSlug)}
            />
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="animate-spin text-[#00f2fe]" size={40} />
            <p className="text-sm text-slate-500 mt-4 font-mono">Initializing local workspace connections...</p>
          </div>
        ) : wizardMode && activeNovel ? (
          <WizardPanel
            step={wizardStep}
            onStepChange={setWizardStep}
            inkstone={{ authenticated: isInkstoneAuth, cookie_age_hours: inkstoneAge, profile_path: inkstoneProfile }}
            patreon={{ authenticated: isPatreonAuth, cookie_age_hours: patreonAge, profile_path: patreonProfile }}
            onConnect={(platform) => openChromiumInkstone(platform)}
            onDisconnect={(platform) => handleProfileLogout(platform)}
            config={activeNovel?.config as NovelConfig}
            slug={activeSlug}
            name={activeNovel?.config?.name || ''}
            onSaveConfig={handleSaveConfig}
            isRunning={isRunning}
            progress={progress}
            onScrape={handleTriggerScrape}
            onPublish={handleTriggerPublish}
            onResequence={handleResequence}
            onCleanup={handleCleanup}
            lastScrapedAt={activeNovel?.tracker?.last_scraped_at}
            hasInkstoneAuth={isInkstoneAuth}
            hasPatreonAuth={isPatreonAuth}
            hasKofiAuth={isKofiAuth}
            terminalLogs={terminalLogs}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* LEFT / CENTRAL CONNECTIVITY & CONFIG: 5 Columns */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              
              <ConnectivityBar
                inkstone={{ authenticated: isInkstoneAuth, cookie_age_hours: inkstoneAge, profile_path: inkstoneProfile, session_expired: inkstoneExpired, session_max_hours: activeNovel?.browser?.inkstone?.session_max_hours ?? 336 }}
                patreon={{ authenticated: isPatreonAuth, cookie_age_hours: patreonAge, profile_path: patreonProfile, session_expired: patreonExpired, session_max_hours: activeNovel?.browser?.patreon?.session_max_hours ?? 336 }}
                kofi={{ authenticated: isKofiAuth, cookie_age_hours: kofiAge, profile_path: kofiProfile, session_expired: kofiExpired, session_max_hours: activeNovel?.browser?.kofi?.session_max_hours ?? 336 }}
                onConnect={(platform) => openChromiumInkstone(platform)}
                onDisconnect={(platform) => handleProfileLogout(platform)}
              />

              <PlatformSummary
                novel={activeNovel ?? null}
                showEdit={showEditTracker}
                onToggleEdit={() => setShowEditTracker(!showEditTracker)}
                onSaveTracker={handleSaveTracker}
                triggerAlert={triggerAlert as (msg: string, type?: string) => void}
              />

              <SequenceAuditPanel
                inkstone={inkstoneAudit}
                patreon={patreonAudit}
                kofi={kofiAudit}
                check={sequenceCheck}
                isRunning={isRunning}
                progress={progress}
                onRefresh={() => activeSlug && fetchSequence(activeSlug, true)}
                onResequence={handleResequence}
              />

              <AuthorNotePanel
                config={activeNovel?.config as NovelConfig}
                slug={activeSlug}
                onSave={handleSaveConfig}
              />

              <ConfigForm
                key={activeSlug}
                config={activeNovel?.config as NovelConfig}
                slug={activeSlug}
                name={activeNovel?.config?.name || ''}
                onSave={handleSaveConfig}
              />

            </div>

            {/* RIGHT WORKSPACE, CONTROLS & TERMINAL: 7 Columns */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              
              {activeNovel ? (
                <>
                  <ExecutionControls
                    isRunning={isRunning}
                    progress={progress}
                    onScrape={handleTriggerScrape}
                    onPublish={handleTriggerPublish}
                    onResequence={handleResequence}
                    onCleanup={handleCleanup}
                    lastScrapedAt={activeNovel?.tracker?.last_scraped_at}
                    hasInkstoneAuth={isInkstoneAuth}
                    hasPatreonAuth={isPatreonAuth}
                    hasKofiAuth={isKofiAuth}
                    inkstoneSessionExpired={inkstoneExpired}
                    patreonSessionExpired={patreonExpired}
                    onReconnect={(platform) => openChromiumInkstone(platform)}
                    onResetStatus={handleResetStuckStatus}
                  />

                  {uploadProgress !== null && (
                    <div className="mb-2">
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                        <span>Uploading...</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[#1e293b] rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-[#00f2fe] to-emerald-400 rounded-full transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
                      </div>
                    </div>
                  )}
                  <ChaptersTable
                    chapters={activeNovel?.chapters}
                    selected={selectedChapters}
                    onSelect={(s) => setSelectedChapters(s)}
                    onToggleLock={handleToggleLock}
                    onDelete={(num) => handleDeleteChapter(num)}
                    onEdit={(num) => handleOpenChapterEditor(num)}
                    onBatchDelete={handleBatchDelete}
                    onUpload={handleChapterFileUpload}
                    onAddChapter={() => {
                      if (activeNovel?.chapters) {
                        const nextNum = activeNovel.chapters.length > 0
                          ? Math.max(...activeNovel.chapters.map(c => c.chapter_number)) + 1
                          : 1;
                        setNewChapNum(nextNum);
                      }
                      setShowCreateChapter(true);
                    }}
                    onUpdatePlatform={handleUpdatePlatform}
                    onPublishSingle={handlePublishSingleChapter}
                    slug={activeSlug}
                    tracker={activeNovel?.tracker}
                    config={activeNovel?.config}
                    sequenceCheck={sequenceCheck}
                    onShowConfirm={(c) => setModalConfirm(c)}
                  />

                  <TerminalConsole
                    logs={terminalLogs}
                    isRunning={isRunning}
                  />
                </>
              ) : (
                <WelcomePanel
                  onOpenRegister={() => setShowRegisterModal(true)}
                />
              )}

            </div>

          </div>
        )}
      </div>

      <RegisterNovelModal
        show={showRegisterModal}
        onClose={() => setShowRegisterModal(false)}
        onRegister={handleRegisterNovel}
      />

      <CreateChapterModal
        show={showCreateChapter}
        onClose={() => setShowCreateChapter(false)}
        onSubmit={handleCreateChapter}
        chapterNum={newChapNum}
        onChapterNumChange={setNewChapNum}
        title={newChapTitle}
        onTitleChange={setNewChapTitle}
        body={newChapBody}
        onBodyChange={setNewChapBody}
      />

      <AlertModal />
      <ToastContainer />
      <ConfirmModal />

      <BrowserLoginModal
        show={showChromiumInkstone}
        platform={connectPlatform}
        status={connectStatus}
        logs={connectLogs}
        onClose={() => { setShowChromiumInkstone(false); if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current); }}
        onLaunch={(platform) => openChromiumInkstone(platform)}
      />

      <ChapterEditorModal
        show={showEditChapter}
        onClose={() => { setShowEditChapter(false); setEditingChapter(null); }}
        onSave={handleSaveChapter}
        title={editTitle}
        onTitleChange={setEditTitle}
        body={editBody}
        onBodyChange={setEditBody}
        frontmatter={editFrontmatter}
        onFrontmatterChange={setEditFrontmatter}
        loading={editLoading}
      />

      <SessionLogsModal
        show={showSessionLogs}
        onClose={() => { setShowSessionLogs(false); setLogFiles([]); setLogEntries([]); setSelectedLogFile(''); }}
        logFiles={logFiles}
        selectedFile={selectedLogFile}
        onSelectFile={handleLoadLogFile}
        entries={logEntries}
        loading={logsLoading}
        onLoadFiles={handleLoadLogFiles}
      />

      <PublishPreview
        plan={publishPlan}
        loading={publishPreviewLoading}
        onConfirm={handleConfirmPublish}
        onCancel={() => setPublishPlan(null)}
      />

      {pendingDecision && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[95] flex items-center justify-center p-4">
          <div className="bg-[#131722] border border-amber-500/40 rounded-xl p-6 max-w-md w-full shadow-2xl font-mono text-xs">
            <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-2">Catch-up needed</h3>
            <p className="text-slate-300 font-sans leading-relaxed text-xs mb-4">{pendingDecision}</p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => handleDecision('limit')}
                className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider"
                title="Schedule only the next batch, respecting 1 chapter/day"
              >
                Limit (1/day)
              </button>
              <button
                onClick={() => handleDecision('bulk')}
                className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white font-bold transition-all cursor-pointer text-[10px] uppercase tracking-wider shadow-lg shadow-amber-900/20"
                title="Schedule the full catch-up batch now"
              >
                Bulk
              </button>
            </div>
          </div>
        </div>
      )}

      <CleanupPreviewModal
        plan={cleanupPlan}
        exclude={cleanupExcluded}
        onToggleExclude={(num) => {
          const next = new Set(cleanupExcluded);
          if (next.has(num)) next.delete(num); else next.add(num);
          setCleanupExcluded(next);
        }}
        onSelectAll={(nums, selected) => {
          const next = new Set(cleanupExcluded);
          for (const n of nums) { if (selected) next.delete(n); else next.add(n); }
          setCleanupExcluded(next);
        }}
        onConfirm={handleCleanupConfirm}
        onCancel={() => setCleanupPlan(null)}
        loading={isRunning}
      />
    </div>
  );
}

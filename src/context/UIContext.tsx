import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { Toast } from '../components/ToastContainer';

interface UIContextValue {
  toasts: Toast[];
   addToast: (platform: 'inkstone' | 'patreon' | 'kofi', message: string) => void;
   dismissToast: (id: number) => void;
   clearToasts: () => void;
   modalAlert: { message: string; type?: 'success' | 'error' | 'info' } | null;
   triggerAlert: (message: string, type?: 'success' | 'error' | 'info') => void;
   dismissAlert: () => void;
   modalConfirm: { title?: string; message: string; onConfirm: () => void } | null;
   setModalConfirm: (c: { title?: string; message: string; onConfirm: () => void } | null) => void;
   toastReconnect: ((platform: 'inkstone' | 'patreon' | 'kofi') => void) | null;
   setToastReconnect: (fn: ((platform: 'inkstone' | 'patreon' | 'kofi') => void) | null) => void;
  toastAbort: (() => void) | null;
  setToastAbort: (fn: (() => void) | null) => void;
}

const UIContext = createContext<UIContextValue>(null!);

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const addToast = useCallback((platform: 'inkstone' | 'patreon' | 'kofi', message: string) => {
    const id = ++toastIdRef.current;
    setToasts(prev => {
      const already = prev.some(t => t.platform === platform && t.message === message);
      if (already) return prev;
      return [...prev, { id, platform, message, timestamp: new Date().toISOString() }];
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const [modalAlert, setModalAlert] = useState<{ message: string; type?: 'success' | 'error' | 'info' } | null>(null);
  const triggerAlert = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setModalAlert({ message, type });
  }, []);
  const dismissAlert = useCallback(() => setModalAlert(null), []);

  const [modalConfirm, setModalConfirm] = useState<{ title?: string; message: string; onConfirm: () => void } | null>(null);

  const [toastReconnect, setToastReconnect] = useState<((platform: 'inkstone' | 'patreon' | 'kofi') => void) | null>(null);
  const [toastAbort, setToastAbort] = useState<(() => void) | null>(null);

  return (
    <UIContext.Provider value={{ toasts, addToast, dismissToast, clearToasts, modalAlert, triggerAlert, dismissAlert, modalConfirm, setModalConfirm, toastReconnect, setToastReconnect, toastAbort, setToastAbort }}>
      {children}
    </UIContext.Provider>
  );
}

export function useUI() {
  return useContext(UIContext);
}

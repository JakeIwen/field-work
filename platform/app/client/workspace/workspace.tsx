import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { AppState } from '../../shared/types';
import type { Context } from "../agents/task-context";
import type { Go, Mutate, Notify } from "./workspace-actions";

type Personal = (id: string, fields: Parameters<Mutate>[1]) => ReturnType<Mutate>;

export type WorkspaceValue = {
  state: AppState;
  selected: string;
  go: Go;
  personal: Personal;
  mutate: Mutate;
  agent: (context: Partial<Context>, preset?: string) => void;
  notify: Notify;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export const useOptionalWorkspace = () => useContext(WorkspaceContext);

export function WorkspaceProvider({ value, children }: { value: WorkspaceValue; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return value;
}

type ActionOptions = {
  clearError?: boolean;
  recordError?: boolean;
  onError?: (error: unknown) => void;
};

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>('');
  const run = useCallback(async <T,>(operation: () => Promise<T>, options: ActionOptions = {}): Promise<T | undefined> => {
    setBusy(true);
    if (options.clearError !== false) setError('');
    try {
      return await operation();
    } catch (caught) {
      if (options.recordError !== false) {
        // Preserve the replaced handlers' direct .message access: a missing
        // message stays undefined, and null/undefined still throw on access.
        setError((caught as { message?: string }).message);
      }
      options.onError?.(caught);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ModelCatalogStatus } from "../../shared/codex-models";
import { api } from "./api";

const initial: ModelCatalogStatus = { models: [], refreshedAt: null, refreshing: true, error: null };
const CatalogContext = createContext({ catalog: initial, refresh: async () => {} });

export function CodexModelCatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState(initial);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api<ModelCatalogStatus>("/api/agent/models");
        if (disposed) return;
        setCatalog(next);
        if (next.refreshing) timer = setTimeout(read, 750);
      } catch (error) {
        if (!disposed) setCatalog((old) => ({ ...old, refreshing: false, error: (error as Error).message }));
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [revision]);
  const refresh = async () => {
    setCatalog((old) => ({ ...old, refreshing: true, error: null }));
    try { await api("/api/agent/connect", {}); }
    finally { setRevision((value) => value + 1); }
  };
  return <CatalogContext.Provider value={{ catalog, refresh }}>{children}</CatalogContext.Provider>;
}

export const useCodexModelCatalog = () => useContext(CatalogContext);

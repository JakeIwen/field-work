import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../workspace/api";

type CursorPage = { nextCursor?: string };
type ReadRequest = { cursor?: string; refreshPages?: number; position?: { left: number; top: number } };
type LoadState<Page> = { path: string; page?: Page; loading: boolean; error: string; request?: ReadRequest; position?: ReadRequest["position"] };

async function readLoadedPages<Page extends CursorPage>(path: string, count: number, append: (previous: Page, next: Page) => Page, current: () => boolean) {
  let page: Page | undefined;
  let cursor: string | undefined;
  for (let pages = 1; pages <= count; pages++) {
    const next = await api<Page>(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!current()) return;
    page = page ? append(page, next) : next;
    if (!next.nextCursor || pages === count) return { page, pages };
    cursor = next.nextCursor;
  }
}

/** Rebuild loaded pages from fresh cursors after mutations; keep the old DOM until the complete replacement is ready. */
export function usePagedRecords<Page extends CursorPage>(path: string, append: (previous: Page, next: Page) => Page) {
  const [state, setState] = useState<LoadState<Page>>({ path, loading: true, error: "" });
  const generation = useRef(0);
  const inFlight = useRef(false);
  const loadedPages = useRef(1);
  const read = useCallback(async (options: ReadRequest = {}) => {
    if (inFlight.current && !options.refreshPages) return;
    inFlight.current = true;
    const request = ++generation.current;
    setState(previous => ({ path, page: (options.cursor || options.refreshPages) && previous.path === path ? previous.page : undefined,
      loading: true, error: "", request: options }));
    try {
      const result = options.refreshPages
        ? await readLoadedPages(path, options.refreshPages, append, () => request === generation.current)
        : { page: await api<Page>(`${path}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ""}`), pages: 1 };
      if (request !== generation.current || !result) return;
      loadedPages.current = options.cursor ? loadedPages.current + 1 : result.pages;
      setState(previous => ({ path, page: options.cursor && previous.page ? append(previous.page, result.page) : result.page,
        loading: false, error: "", position: options.position }));
    } catch (error) {
      if (request === generation.current) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (request === generation.current) inFlight.current = false;
    }
  }, [path, append]);
  useEffect(() => {
    inFlight.current = false; loadedPages.current = 1;
    void read();
    return () => { generation.current++; inFlight.current = false; };
  }, [read]);
  useLayoutEffect(() => {
    if (state.path === path && state.position) window.scrollTo({ ...state.position, behavior: "instant" });
  }, [state.position, state.path, path]);
  const current: LoadState<Page> = state.path === path ? state : { path, loading: true, error: "" };
  return { ...current, load: (cursor?: string) => read({ cursor }), retry: () => void read(current.request),
    refresh: () => read({ refreshPages: loadedPages.current, position: { left: window.scrollX, top: window.scrollY } }) };
}

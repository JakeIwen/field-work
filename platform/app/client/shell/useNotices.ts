import { tunables } from "../../shared/tunables";
import { useCallback, useRef, useState } from "react";
import type { Notify } from "../workspace/workspace-actions";
import type { Notice } from "./Toast";


export function useNotices(noticeLimit: number = tunables["browser.noticeStack"].default) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);
  const notify: Notify = useCallback((text, content) => {
    const notice = { ...content, id: ++nextId.current, text };
    setNotices(current => [...current, notice].slice(-noticeLimit));
  }, [noticeLimit]);
  const closeNotice = useCallback((id: number) => {
    setNotices(current => current.filter(notice => notice.id !== id));
  }, []);
  return { notices, notify, closeNotice };
}

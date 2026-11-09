import React from "react";

type AppLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  page: string;
  id?: string;
  go: (page: string, id?: string) => void;
};

export function routeHref(page: string, id?: string): string {
  return `#${page}${id ? "/" + encodeURIComponent(id) : ""}`;
}

/** Ordinary left clicks only; modified and middle clicks keep the browser's own link behavior. */
export function isPlainClick(event: React.MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Keep browser link gestures native; only ordinary clicks use app navigation. */
export default function AppLink({ page, id, go, className, onClick, ...props }: AppLinkProps) {
  return <a {...props} href={routeHref(page, id)} className={`app-link ${className || ""}`}
    onClick={event => {
      if (event.defaultPrevented || !isPlainClick(event) ||
          (props.target && props.target !== "_self") || props.download !== undefined) return;
      onClick?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      go(page, id);
    }} />;
}

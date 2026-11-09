import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { clientSecurityHeaders } from "../server/client-security.js";
import { platformBuild } from "../server/paths.js";

/** The demo shell prevents external navigation without branching product client code. */
export const demoNavigationGuard = `
(() => {
  const doc = document;
  const open = window.open.bind(window);
  window.open = (url, ...args) => {
    if (url && new URL(String(url), location.href).origin !== location.origin) return null;
    return open(url, ...args);
  };
  const disableExternalLinks = () => {
    doc.querySelectorAll('a[href]').forEach(link => {
      const url = new URL(link.getAttribute('href'), location.href);
      if (url.origin !== location.origin) {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.title = 'External navigation is disabled in this synthetic demo';
        link.setAttribute('aria-disabled', 'true');
      }
    });
  };
  new MutationObserver(disableExternalLinks).observe(doc.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['href']});
  disableExternalLinks();
})();`;

export function registerDemoShell(app: Express, staticDir = platformBuild) {
  app.get("/demo-navigation.js", (_req, res) => {
    clientSecurityHeaders(res);
    res.type("js").send(demoNavigationGuard);
  });
  app.get(["/", "/index.html", "/{*path}"], (req, res, next) => {
    // Leave API routes and real assets to the workspace, but never let its
    // static index or SPA fallback serve an unguarded document.
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    if (
      req.path !== "/" &&
      req.path !== "/index.html" &&
      path.extname(req.path).toLowerCase() !== ".html" &&
      statSync(path.join(staticDir, req.path), {
        throwIfNoEntry: false,
      })?.isFile()
    )
      return next();
    clientSecurityHeaders(res);
    const html = readFileSync(path.join(staticDir, "index.html"), "utf8")
      .replace(/<title>[^<]*<\/title>/, "<title>Fieldwork Demo</title>")
      .replace("<head>", '<head><script src="/demo-navigation.js"></script>');
    res.type("html").send(html);
  });
}

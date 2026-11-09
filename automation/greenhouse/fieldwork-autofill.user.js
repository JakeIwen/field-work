// ==UserScript==
// @name         Fieldwork Greenhouse autofill
// @namespace    fieldwork-greenhouse
// @version      1.0.4
// @description  Runs Fieldwork's saved autofill script in a Greenhouse application tab opened from Fieldwork. It never submits the form.
// @match        https://job-boards.greenhouse.io/*
// @match        https://boards.greenhouse.io/*
// @grant        none
// @sandbox      raw
// @run-at       document-start
// @noframes
// ==/UserScript==

// Fieldwork's posting link opens this tab with window.open and keeps the
// handle. This script greets that opener as the page starts, announces the
// form once it is ready, accepts one script from a Fieldwork origin, and runs
// it as the console paste would. Message names match
// platform/app/client/openings/autofill/greenhouse-tab-autofill.ts.
(function fieldworkGreenhouseAutofill() {
  'use strict';
  const protocol = 1;
  const messages = {
    present: 'fieldwork-autofill-present',
    ready: 'fieldwork-autofill-ready',
    script: 'fieldwork-autofill-script',
    accepted: 'fieldwork-autofill-accepted',
  };
  const opener = window.opener;
  if (!opener || window.top !== window) return;
  // Add your deployed Fieldwork origin to this allowlist; see README.md.
  const fieldworkOrigin = origin =>
    /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);

  // The opener may be any site; these messages carry only the public form URL. The first
  // goes out at once so Fieldwork can tell a missing userscript from a slow page.
  opener.postMessage({ type: messages.present, protocol, url: location.href }, '*');
  formReady().then(ready => {
    if (!ready) return;
    window.addEventListener('message', onMessage);
    opener.postMessage({ type: messages.ready, protocol, url: location.href }, '*');
  });

  async function onMessage(event) {
    const data = event.data;
    if (event.source !== opener || !fieldworkOrigin(event.origin) || data?.type !== messages.script ||
        data.protocol !== protocol || typeof data.script !== 'string') return;
    window.removeEventListener('message', onMessage);
    opener.postMessage({ type: messages.accepted, protocol }, event.origin);
    window.opener = null;
    let panel = null;
    try {
      panel = statusPanel(typeof data.label === 'string' ? data.label : '');
      // The saved script is one expression whose value is the helper's report promise.
      panel.finished(await (0, eval)(data.script));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Fieldwork autofill stopped:', message);
      panel?.failed(message);
    }
  }

  // The server renders the form and React then hydrates the whole page, discarding nodes added
  // before it finishes, so answer only once React owns the form. It marks the nodes it owns with
  // __react* properties, which are visible because this runs in the page. The wait starts as
  // the page starts, so it also covers a slow download.
  async function formReady() {
    for (let waited = 0; waited < 60000; waited += 100) {
      const form = document.getElementById('application-form');
      if (form && Object.keys(form).some(key => key.startsWith('__react'))) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !!document.getElementById('application-form');
  }

  function statusPanel(label) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      section { box-sizing: border-box; width: min(360px, calc(100vw - 32px)); max-height: 50vh; overflow: auto;
        padding: 12px 14px; border: 1px solid #c8c8c8; border-radius: 8px; background: #fff; color: #1f1f1f;
        font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, .18); }
      header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      button { border: 1px solid #c8c8c8; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
      p { margin: 8px 0 0; } ul { margin: 6px 0 0; padding-left: 18px; }
      @media (prefers-color-scheme: dark) { section { background: #1f1f1f; color: #eee; border-color: #555; } button { border-color: #555; } }
    </style><section role="status" aria-live="polite"><header><strong></strong><button type="button" aria-label="Close">×</button></header>` +
      '<p class="status"></p><ul hidden></ul><p class="note" hidden></p></section>';
    root.querySelector('strong').textContent = `Fieldwork autofill${label ? ' ' + label : ''}`;
    root.querySelector('button').addEventListener('click', () => host.remove());
    const status = root.querySelector('.status'), list = root.querySelector('ul'), note = root.querySelector('.note');
    status.textContent = 'Filling the form…';
    document.documentElement.append(host);
    const show = (text, items, remark) => {
      status.textContent = text;
      list.replaceChildren(...items.map(item => Object.assign(document.createElement('li'), { textContent: item })));
      list.hidden = !items.length;
      note.textContent = remark;
      note.hidden = false;
    };
    return {
      finished(result) {
        const missing = Array.isArray(result?.missingRequired) ? result.missingRequired.map(String) : [];
        const review = Array.isArray(result?.review) ? result.review.length : 0;
        show(missing.length ? 'Finished. Still required:' : 'Finished. Required fields are filled.', missing,
          (review ? `${review} optional ${review === 1 ? 'field is' : 'fields are'} left for you. ` : '') +
          'Check every answer and attachment, then submit the form yourself. Nothing was submitted.');
      },
      failed(message) {
        show(`Stopped: ${message}`, [], 'Nothing was submitted. The console has the details.');
      },
    };
  }
})();

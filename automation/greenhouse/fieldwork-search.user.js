// ==UserScript==
// @name         Fieldwork Greenhouse search
// @namespace    fieldwork-greenhouse
// @version      1.2.1
// @description  Loads one validated MyGreenhouse search page per Fieldwork command. Never opens or submits applications.
// @match        https://my.greenhouse.io/jobs/search*
// @grant        none
// @sandbox      raw
// @run-at       document-start
// @noframes
// ==/UserScript==

// Block scope keeps the standalone userscript out of the site's global namespace.
{
  const commandId = 'fieldwork-search-command';
  const commandMaxLength = 4096;
  const pageDataWaitMs = 30000;
  const pageDataPollMs = 100;
  const noticePollMs = 250;
  const noticeSelector = '[role="alert"], [role="status"], [aria-live], [class*="toast" i], [class*="notification" i], [class*="snackbar" i]';
  const ratePattern = /\b(?:api|rate|request)[\s-]*limit|\btoo many requests\b/i;
  const allowedParameters = new Set(['query', 'date_posted', 'work_type[]', 'employment_type[]', 'page']);
  const employmentTypes = new Set(['full_time', 'part_time', 'contract', 'temporary']);

  function activation() {
    if (window.top !== window) return;
    const start = new URL(location.href);
    const config = new URLSearchParams(start.hash.slice(1));
    const nonce = config.get('fieldwork-pull');
    if (start.origin !== 'https://my.greenhouse.io' || start.pathname !== '/jobs/search' ||
        !/^[A-Za-z0-9-]{8,64}$/.test(nonce || '') || config.getAll('fieldwork-pull').length !== 1) return;
    return { start, nonce };
  }
  function commandUrl(text, nonce) {
    if (!text || text.length > commandMaxLength) return undefined;
    try {
      const command = JSON.parse(text);
      if (!command || Array.isArray(command) || Object.keys(command).sort().join() !== 'nonce,url' ||
          command.nonce !== nonce || typeof command.url !== 'string') return undefined;
      const url = new URL(command.url);
      if (url.origin !== 'https://my.greenhouse.io' || url.pathname !== '/jobs/search' || url.username || url.password || url.hash ||
          [...url.searchParams.keys()].some(key => !allowedParameters.has(key))) return undefined;
      const params = url.searchParams;
      const query = params.get('query');
      const page = params.get('page');
      const types = params.getAll('employment_type[]');
      if (params.getAll('query').length !== 1 || !query?.trim() || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) ||
          params.getAll('date_posted').join() !== 'past_ten_days' || params.getAll('work_type[]').join() !== 'remote' ||
          params.getAll('page').length !== 1 || !/^[1-9]\d*$/.test(page || '') || !Number.isSafeInteger(Number(page)) ||
          !types.length || new Set(types).size !== types.length || types.some(type => !employmentTypes.has(type))) return undefined;
      return url;
    } catch { return undefined; }
  }
  function notice() {
    for (const node of document.querySelectorAll(noticeSelector)) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      // A focused location select fills a 1x1 screen-reader live region. It is
      // not a visible error notice and must not stop search commands.
      if (node.textContent.trim() && !node.closest('[hidden], [aria-hidden="true"]') &&
          style.display !== 'none' && style.visibility !== 'hidden' && box.width > 4 && box.height > 4) return true;
    }
    return ratePattern.test(document.body?.innerText || '');
  }
  // Mirror the site's axios configuration; the session cookie is never read.
  function xsrfToken() {
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('MYGREENHOUSE-XSRF-TOKEN='));
    if (!cookie) return undefined;
    try { return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)); } catch { return undefined; }
  }

  class SearchDriver {
    constructor({ start, nonce }) {
      this.start = start;
      this.nonce = nonce;
      this.busy = false;
      this.check = () => {
        if (location.href !== this.start.href) this.stop();
        else if (this.busy && notice()) this.fail();
      };
      this.receive = () => { void this.execute(); };
      this.leave = () => this.stop();
    }
    mount() {
      if (location.href !== this.start.href || document.getElementById(commandId)) return;
      const input = document.createElement('input');
      input.id = commandId;
      input.type = 'text';
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      input.autocomplete = 'off';
      input.maxLength = commandMaxLength;
      // Nonzero size/opacity lets Kapture fill it without adding a visible UI
      // control or a keyboard/screen-reader stop to MyGreenhouse.
      input.style.cssText = 'position:fixed;bottom:0;left:0;width:8px;height:8px;opacity:.01;padding:0;margin:0;border:0;z-index:2147483647;';
      input.addEventListener('input', this.receive);
      input.addEventListener('change', this.receive);
      document.body.append(input);
      this.input = input;
      this.observer = new MutationObserver(this.check);
      this.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
      this.watcher = setInterval(this.check, noticePollMs);
      window.addEventListener('hashchange', this.check);
      window.addEventListener('pagehide', this.leave);
    }
    stop() {
      this.controller?.abort();
      clearInterval(this.watcher);
      this.observer?.disconnect();
      this.input?.remove();
      window.removeEventListener('hashchange', this.check);
      window.removeEventListener('pagehide', this.leave);
    }
    fail() {
      document.documentElement.setAttribute('data-fieldwork-search-error', this.nonce);
      this.controller?.abort();
    }
    async version() {
      for (let waited = 0; waited < pageDataWaitMs && !this.controller.signal.aborted; waited += pageDataPollMs) {
        const raw = document.querySelector('[data-page]')?.getAttribute('data-page');
        if (raw) {
          const page = JSON.parse(raw);
          if (page.component === 'jobs' && typeof page.version === 'string' && page.version) return page.version;
        }
        await new Promise(resolve => setTimeout(resolve, pageDataPollMs));
      }
      throw Error('Page data unavailable');
    }
    async execute() {
      if (this.busy || !this.input || location.href !== this.start.href) return;
      const url = commandUrl(this.input.value, this.nonce);
      if (!url) { this.input.value = ''; return; }
      this.busy = true;
      this.controller = new AbortController();
      document.documentElement.removeAttribute('data-fieldwork-search-error');
      try {
        this.check();
        const version = await this.version();
        const csrf = xsrfToken();
        if (!csrf || this.controller.signal.aborted) throw Error('Search unavailable');
        const response = await fetch(url.href, {
          method: 'GET', credentials: 'include', redirect: 'error', signal: this.controller.signal,
          headers: {
            Accept: 'text/html, application/xhtml+xml',
            'X-Inertia': 'true',
            'X-Inertia-Partial-Component': 'jobs',
            'X-Inertia-Partial-Data': 'jobPosts,moreResultsAvailable,page',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia-Version': version,
            'X-CSRF-TOKEN': csrf,
          },
        });
        if (response.status !== 200) throw Error('Search response failed');
        await response.json();
        this.check();
      } catch {
        if (location.href === this.start.href) this.fail();
      } finally {
        this.input.value = '';
        this.busy = false;
      }
    }
  }

  const config = activation();
  if (config) {
    const driver = new SearchDriver(config);
    if (document.body) driver.mount();
    else document.addEventListener('DOMContentLoaded', () => driver.mount(), { once: true });
  }
}

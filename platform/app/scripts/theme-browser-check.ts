import { themeSwatchBrowserChecks } from "./theme-swatch-browser-check";

/** Executed by browser-check.ts in the existing browser_clean context. Read-only
 * workflow checks; only appearance and local view preferences are changed. */
export const themeBrowserChecks = String.raw`
    const contrastAudit = () => {
      // Palette tokens compute to oklch(), not rgb(); a canvas converts any
      // computed color to sRGB with its alpha before compositing.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      const srgb = new Map();
      const rgba = value => {
        if (!srgb.has(value)) {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = 'transparent';
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          srgb.set(value, [r, g, b, a / 255]);
        }
        return srgb.get(value);
      };
      const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
      const background = node => {
        const chain = [];
        for (let n = node; n; n = n.parentElement) chain.unshift(n);
        return chain.reduce((bg, n) => over(rgba(getComputedStyle(n).backgroundColor), bg), [255, 255, 255, 1]);
      };
      const luminance = rgb => rgb.slice(0, 3).map(c => {
        c /= 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const failures = [];
      let checked = 0;
      for (const node of document.querySelectorAll('body *')) {
        if (node.closest('.pdf-selectable-text,[inert],[disabled],script,style,option') ||
            !node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
        const style = getComputedStyle(node), bg = background(node);
        if (node.matches(':focus-visible') && parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') {
          const surround = background(node.parentElement);
          const a = luminance(over(rgba(style.outlineColor), surround)), b = luminance(surround);
          const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          if (ratio < 3) failures.push({selector: node.tagName.toLowerCase() + ':focus-visible', ratio: Math.round(ratio * 100) / 100});
        }
        const text = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        const control = node.matches('input:not([type=checkbox]):not([type=radio]),textarea,select');
        if (!text && !control) continue;
        const fg = over(rgba(getComputedStyle(node, control && !node.value && node.placeholder ? '::placeholder' : null).color), bg);
        const a = luminance(fg), b = luminance(bg);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        checked++;
        if (ratio < (large ? 3 : 4.5)) failures.push({
          selector: node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).trim().replace(/\s+/g, '.') : ''),
          ratio: Math.round(ratio * 100) / 100,
        });
      }
      return {checked, failures};
    };
    const themeReport = {views: [], minimumTextContrast: 4.5, minimumLargeTextContrast: 3};
    const themeButton = mode => page.getByRole('button', {name: mode === 'soft' ? 'Soft' : 'Dark', exact: true});
    const auditThemes = async name => {
      await page.locator('.pdf-render-state').waitFor({state: 'detached'});
      // Let independent page reads settle before comparing the same data in
      // both modes. SSE stays connected, so networkidle is inappropriate.
      await page.waitForFunction(() => {
        const text = document.querySelector('main').innerText;
        const prior = window.__themeAuditStable;
        if (!prior || prior.text !== text) {
          window.__themeAuditStable = {text, at: performance.now()};
          return false;
        }
        return performance.now() - prior.at >= 250;
      });
      for (const mode of ['soft', 'dark']) {
        // Compare within one browser task so unrelated polling/SSE responses
        // cannot be mistaken for a theme-induced data change.
        const unchanged = await page.evaluate(mode => {
          const main = document.querySelector('main');
          const data = () => JSON.stringify({text: main.innerText, fields: [...main.querySelectorAll('input,textarea,select')].map(n => [n.type, n.value, n.checked])});
          const before = data();
          [...document.querySelectorAll('.theme-switch button')].find(n => n.textContent.trim().toLowerCase() === mode).click();
          return data() === before;
        }, mode);
        assert(await page.locator('html').getAttribute('data-theme') === mode, name + ': theme not applied');
        assert(await themeButton(mode).getAttribute('aria-pressed') === 'true', name + ': selected theme is not announced');
        assert(unchanged, name + ': switching theme changed visible data or form values');
        const audit = await page.evaluate(contrastAudit);
        assert(audit.checked > 0, name + ': no rendered text checked');
        assert(audit.failures.length === 0, name + ' (' + mode + ') low contrast: ' + JSON.stringify(audit.failures.slice(0, 10)));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': page overflows');
        themeReport.views.push({name, mode, textNodes: audit.checked});
      }
    };
    const visit = async route => {
      await page.goto(origin + '/#' + route);
      await page.locator('main .panel, main .stat-grid, main .agent-status').first().waitFor();
    };
    await page.setViewportSize({width: 1440, height: 1000});
    for (const route of ['overview', 'openings', 'scans', 'companies', 'applications', 'documents', 'questions', 'agents', 'health', 'settings']) {
      await visit(route);
      if (route === 'scans') await page.getByRole('button', {name: 'Scan all monitored companies', exact: true}).waitFor();
      if (route === 'documents') await page.locator('.pdf-page-surface canvas').waitFor();
      await auditThemes('desktop ' + route);
    }

    await visit('openings');
    await page.locator('.opening-filters > summary').click();
    // Technical fit is a checkbox popup that closes on page scroll; scroll it into view first.
    const fitFilter = page.getByRole('button', {name: 'Technical fit', exact: true});
    await fitFilter.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await fitFilter.click();
    const clearFit = page.getByRole('dialog', {name: 'Technical fit', exact: true}).getByRole('button', {name: 'Clear selection', exact: true});
    if (await clearFit.isEnabled()) await clearFit.click();
    await page.keyboard.press('Escape');
    await auditThemes('opening filters');
    if (await page.locator('tbody .checkbox-cell input').count() >= 2) {
      await page.locator('tbody .checkbox-cell input').nth(0).check();
      await page.locator('tbody .checkbox-cell input').nth(1).check();
      await page.getByRole('button', {name: 'Compare (2/3)', exact: true}).click();
      await auditThemes('opening bulk selection and comparison');
    }
    const detailRoutes = [
      ['openings', state.openings.find(o => !o.closed)?.id],
      ['companies', state.companies[0]?.id],
      ['applications', state.applications.find(a => a.stage === 'applied')?.id || state.applications[0]?.id],
      ['questions', state.tasks.find(t => t.preset === 'questions' && t.messages?.some(m => m.role === 'assistant'))?.id],
      ['agents', state.tasks.find(t => t.preset === 'job-fit' && t.messages?.some(m => m.role === 'assistant'))?.id],
    ];
    for (const [route, id] of detailRoutes) {
      if (!id) continue;
      await visit(route + '/' + encodeURIComponent(id));
      // Expand research, notes, saved answers, event logs and provenance without
      // clicking action buttons or writing any personal/workflow metadata.
      await page.locator('main details').evaluateAll(nodes => nodes.forEach(n => {n.open = true;}));
      await auditThemes(route + ' detail and expanded sections');
    }

    await visit('companies');
    await page.getByRole('button', {name: 'Add company', exact: true}).click();
    await page.getByPlaceholder('Company name', {exact:true}).fill('Unsaved appearance check');
    await auditThemes('company form');
    await visit('applications');
    await page.getByRole('button', {name: 'New application', exact: true}).click();
    await auditThemes('application form');
    await page.getByRole('button', {name: 'Board', exact: true}).click();
    await auditThemes('application board');
    await page.getByRole('button', {name: 'List', exact: true}).click();
    const outcomeReport = page.locator('.variant-report > summary');
    if (await outcomeReport.count()) {
      await outcomeReport.click();
      await page.getByRole('button', {name: 'Refresh report', exact: true}).waitFor();
      await auditThemes('application outcome report');
    }

    const browserFixtureDocument = state.documents.find(d => d.id === 'browser-fixture-resume-current');
    await visit('documents' + (browserFixtureDocument ? '/' + encodeURIComponent(browserFixtureDocument.id) : ''));
    const pdfCanvas = page.locator('.pdf-page-surface canvas');
    if (browserFixtureDocument || (await pdfCanvas.count())) {
      await pdfCanvas.waitFor();
      await page.locator('.pdf-render-state').waitFor({state: 'detached'});
      const pdfFingerprint = () => {
        const canvas = document.querySelector('.pdf-page-surface canvas');
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
        return {hash, width: canvas.width, height: canvas.height,
          paper: getComputedStyle(canvas.closest('.pdf-page-surface')).backgroundColor,
          filters: [canvas, ...function*(n) {while(n) {yield n; n=n.parentElement;}}(canvas.parentElement)].map(n => getComputedStyle(n).filter)};
      };
      await themeButton('soft').click();
      const paper = await page.evaluate(pdfFingerprint);
      await themeButton('dark').click();
      assert(JSON.stringify(await page.evaluate(pdfFingerprint)) === JSON.stringify(paper), 'Theme altered PDF pixels, paper, dimensions or filters');
      assert(paper.paper === 'rgb(255, 255, 255)' && paper.filters.every(f => f === 'none'), 'PDF was recolored');
      for (const tab of ['Readable source', 'Version history', 'Compare']) {
        await page.locator('.document-tabs').getByRole('button', {name: tab, exact: true}).click();
        if (tab === 'Compare') {
          const name = await page.locator('.document-view-header h2').innerText();
          const chosen = state.documents.find(d => d.name === name);
          const older = state.documents.find(d => d.kind === chosen?.kind && d.scope === chosen.scope && d.privacy === chosen.privacy && d.versionNumber < chosen.versionNumber && d.text?.trim());
          if (older) {
            await page.getByLabel('Compare against document').selectOption(older.id);
            await page.getByRole('button', {name: 'Compare versions', exact: true}).click();
            await page.locator('.diff-content').waitFor();
          }
        }
        await auditThemes('document ' + tab);
      }
    }
    await page.locator('.global-search input').fill('engineer');
    await page.locator('.search-results').waitFor();
    await auditThemes('global search');
    await page.locator('.global-search input').fill('');
    await page.locator('.global-search input').blur();
    await page.keyboard.press('?');
    await page.locator('.shortcut-dialog[open]').waitFor();
    // The modal deliberately makes the appearance switch inert. Change the
    // actual control before opening it for each mode.
    for (const mode of ['soft', 'dark']) {
      await page.keyboard.press('Escape');
      await themeButton(mode).click();
      await page.keyboard.press('?');
      const audit = await page.evaluate(contrastAudit);
      assert(audit.failures.length === 0, 'Shortcut dialog has low contrast: ' + JSON.stringify(audit.failures));
      themeReport.views.push({name: 'keyboard dialog', mode, textNodes: audit.checked});
    }
    await page.keyboard.press('Escape');

    // Rare warning/error/approval states are sampled without provoking a failed
    // operation, an agent turn, an employer submission or a live browser action.
    await page.evaluate(() => {
      const sample = document.createElement('section');
      sample.id = 'theme-samples';
      sample.innerHTML = '<div class="panel panel-body">' +
        ['green', 'amber', 'red', 'blue', 'muted'].map(t => '<span class="badge '+t+'">Status '+t+'</span>').join(' ') +
        '<p class="banner warning">Warning <a href="#overview">Details</a></p><p class="banner danger">Error <button class="icon-button">×</button></p>' +
        '<div class="approval-request"><p>Review required</p><pre>Requested command</pre></div>' +
        '<pre class="diff-content"><span class="added">Added text</span><span class="removed">Removed text</span></pre>' +
        '<div class="preparation-line is-stale"><span class="preparation-line-status">Stale preparation</span></div>' +
        '<div class="preparation-line is-failed"><span class="preparation-line-status">Preparation failed</span></div>' +
        '<p class="intake-error">Posting error</p>' +
        '<div class="markdown"><blockquote>Source quote</blockquote><pre><code>Code sample</code></pre></div>' +
        '<div class="toast shell-toast" style="position:static">Saved notification <button class="toast-close icon-button">×</button></div></div>';
      document.querySelector('main').append(sample);
    });
    await auditThemes('status, error, approval, diff, Markdown and toast samples');
    for (const mode of ['soft', 'dark']) {
      await themeButton(mode).click();
      for (const selector of ['.sidebar .nav-item.active', '#theme-samples .toast-close', '.theme-switch button[aria-pressed="true"]']) {
        await page.locator(selector).focus();
        const audit = await page.evaluate(contrastAudit);
        assert(audit.failures.length === 0, mode + ' focus contrast: ' + JSON.stringify(audit.failures));
      }
    }
    await page.locator('#theme-samples').evaluate(n => n.remove());

    await page.setViewportSize({width: 390, height: 844});
    for (const route of ['overview', 'openings', 'scans', 'companies', 'applications', 'documents', 'questions', 'agents', 'health', 'settings']) {
      await visit(route);
      await auditThemes('mobile ' + route);
    }
    await page.getByRole('button', {name: 'Toggle navigation', exact: true}).click();
    const menuAudit = await page.evaluate(contrastAudit);
    assert(menuAudit.failures.length === 0, 'Mobile menu contrast failed');
    await page.keyboard.press('Escape');
    for (const width of [320, 760, 1024]) {
      await page.setViewportSize({width, height: 900});
      await auditThemes('header width ' + width);
    }

    // Themes recolor every themed token. The route pass above ran in the saved
    // theme; each built-in theme is chosen in the Appearance & Theme Editor pane
    // and audited in both modes on a dense route and on Settings. Theme writes
    // go to settingsWrites (browser-check.ts keeps settings read-only); the
    // page's theme cache is restored afterwards.
    const savedPalette = await page.evaluate(() => localStorage.getItem('fieldwork.palette'));
    const untilSaved = async (test, message) => {
      for (let tries = 0; tries < 50 && !settingsWrites.some(test); tries++) await page.waitForTimeout(100);
      assert(settingsWrites.some(test), message + ': ' + JSON.stringify(settingsWrites.slice(-3)));
    };
    const pane = page.getByRole('dialog', {name: 'Appearance & Theme Editor'});
    const openEditor = async () => {
      if (!await pane.isVisible()) await page.getByRole('button', {name: 'Appearance & Theme Editor'}).click();
      await pane.waitFor();
    };
    // The pane's own Soft/Dark buttons would match the header switch's names during an audit.
    const closeEditor = async () => {
      await pane.getByRole('button', {name: 'Close'}).click();
      await pane.waitFor({state: 'hidden'});
    };
    const rootStyle = () => page.evaluate(() => ({
      primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      brand: document.documentElement.style.getPropertyValue('--hue-brand'),
    }));
    try {
      await page.setViewportSize({width: 1440, height: 1000});
      await openEditor();
      ${themeSwatchBrowserChecks}
      await closeEditor();
      const primaries = new Map();
      for (const [id, label] of [['sage', 'Sage'], ['slate', 'Slate'], ['clay', 'Clay'], ['plum', 'Plum'], ['teal', 'Teal']]) {
        await visit('settings');
        await openEditor();
        const writes = settingsWrites.length;
        await pane.locator('[data-action="pick"][data-id="' + id + '"]').click();
        // An active theme no saved theme matches loads as unsaved; switching asks first.
        if (await pane.getByRole('alertdialog').isVisible()) await pane.getByRole('button', {name: 'Discard'}).click();
        const chosen = () => pane.locator('.theme-row.active [data-action="pick"]').getAttribute('data-id');
        for (let tries = 0; tries < 50 && await chosen() !== id; tries++) await page.waitForTimeout(100);
        assert(await chosen() === id, label + ' theme not marked active');
        // Choosing the theme already active changes nothing and saves nothing.
        if (settingsWrites.length > writes) await untilSaved(write => write.palette?.id === id, label + ' theme was not saved to settings');
        await page.waitForTimeout(300);
        primaries.set(id, (await rootStyle()).primary);
        assert(await page.locator('#settings-appearance p').innerText() === 'Theme: ' + label, label + ' theme not named in Settings');
        await closeEditor();
        await auditThemes('settings theme ' + id);
        await visit('openings');
        await auditThemes('openings theme ' + id);
      }
      assert(new Set(primaries.values()).size === primaries.size, 'Built-in themes should recolor the page differently: ' + JSON.stringify([...primaries]));

      // A slider previews without saving; Revert restores the theme, and
      // closing with unsaved changes asks before discarding them.
      await visit('settings');
      await openEditor();
      const writes = settingsWrites.length;
      const brandHue = pane.getByRole('slider', {name: 'Brand hue'});
      await brandHue.focus();
      await page.keyboard.press('End');
      assert((await rootStyle()).brand === '360', 'Brand hue preview not applied');
      assert((await rootStyle()).primary !== primaries.get('teal'), 'Brand hue preview did not recolor the page');
      assert(settingsWrites.length === writes, 'A slider preview must not save');
      await pane.getByRole('button', {name: 'Revert'}).click();
      assert((await rootStyle()).primary === primaries.get('teal'), 'Revert did not restore the theme colors');
      await brandHue.focus();
      await page.keyboard.press('End');
      await pane.getByRole('button', {name: 'Close'}).click();
      assert(await pane.getByRole('alertdialog').isVisible(), 'Closing with unsaved changes did not ask first');
      await pane.getByRole('button', {name: 'Discard'}).click();
      await pane.waitFor({state: 'hidden'});
      assert((await rootStyle()).primary === primaries.get('teal'), 'Discard did not restore the theme colors');

      // Save as new stores the edited knobs and activates them.
      await openEditor();
      await brandHue.focus();
      await page.keyboard.press('Home');
      await pane.getByRole('button', {name: 'Save as new'}).click();
      await pane.getByLabel('New theme name').fill('Browser check theme');
      await pane.getByRole('button', {name: 'Create'}).click();
      await untilSaved(write => write.theme?.id === 'browser-check-theme' && write.theme.knobs.hueBrand === 0, 'New theme was not saved');
      await untilSaved(write => write.palette?.id === 'browser-check-theme', 'New theme was not activated');
      await closeEditor();
      await auditThemes('settings saved theme');

      // At phone width the pane fills the screen and stacks its columns.
      await page.setViewportSize({width: 390, height: 844});
      await openEditor();
      const layout = await pane.evaluate(node => ({width: node.getBoundingClientRect().width, overflow: node.scrollWidth > node.clientWidth}));
      assert(layout.width <= 390 && !layout.overflow, 'Theme editor overflows at phone width: ' + JSON.stringify(layout));
      await closeEditor();
    } finally {
      await page.evaluate(saved => {
        if (saved === null) localStorage.removeItem('fieldwork.palette');
        else localStorage.setItem('fieldwork.palette', saved);
      }, savedPalette);
      await page.reload();
    }

    await page.setViewportSize({width:1440,height:1000});
    await themeButton('soft').focus();
    await page.keyboard.press('Space');
    assert(await page.locator('html').getAttribute('data-theme') === 'soft', 'Keyboard could not select Soft');
    await themeButton('dark').focus();
    await page.keyboard.press('Space');
    assert(await page.locator('html').getAttribute('data-theme') === 'dark', 'Keyboard could not select Dark');
    await page.reload();
    await page.locator('.theme-switch').waitFor();
    assert(await page.locator('html').getAttribute('data-theme') === 'dark', 'Theme did not survive reload');
    const sibling = await page.context().newPage();
    try {
      await sibling.goto(origin);
      await sibling.locator('.theme-switch').waitFor();
      assert(await sibling.locator('html').getAttribute('data-theme') === 'dark', 'New tab did not inherit theme');
      await themeButton('soft').click();
      await sibling.waitForFunction(() => document.documentElement.dataset.theme === 'soft');
      await sibling.getByRole('button', {name:'Dark',exact:true}).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await sibling.evaluate(() => localStorage.removeItem('fieldwork.theme'));
      await sibling.emulateMedia({colorScheme:'dark'});
      await sibling.reload();
      await sibling.locator('.theme-switch').waitFor();
      assert(await sibling.locator('html').getAttribute('data-theme') === 'dark', 'Initial system preference ignored');
      await sibling.emulateMedia({colorScheme:'light'});
      await sibling.waitForFunction(() => document.documentElement.dataset.theme === 'soft');
      await sibling.getByRole('button', {name:'Dark',exact:true}).click();
      await sibling.emulateMedia({colorScheme:'dark'});
      await sibling.emulateMedia({colorScheme:'light'});
      assert(await sibling.locator('html').getAttribute('data-theme') === 'dark', 'System preference overwrote explicit choice');
      await sibling.evaluate(() => localStorage.setItem('fieldwork.theme', 'invalid'));
      await sibling.reload();
      await sibling.locator('.theme-switch').waitFor();
      assert(await sibling.locator('html').getAttribute('data-theme') === 'soft', 'Invalid preference did not fall back to the system');
      await sibling.addInitScript(() => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function(key) { if(key === 'fieldwork.theme') throw new DOMException('Storage blocked'); return get.call(this,key); };
        Storage.prototype.setItem = function(key,value) { if(key === 'fieldwork.theme') throw new DOMException('Storage blocked'); return set.call(this,key,value); };
      });
      await sibling.reload();
      await sibling.getByRole('button', {name:'Dark',exact:true}).click();
      assert(await sibling.locator('html').getAttribute('data-theme') === 'dark', 'Switch failed without storage');
    } finally { await sibling.close(); }
    await themeButton('soft').click();
    report.checks.push({name:'Soft/dark contrast and unchanged visible data across routes, details, controls and palettes', status:'passed', ...themeReport});
    report.checks.push({name:'PDF pixels/paper unchanged, keyboard switch, reload, cross-tab, system preference, blocked storage, theme editor choices, preview, revert, discard prompt and save as new', status:'passed'});
`;

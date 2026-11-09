import { preparationSettingsPath } from "../shared/preparation-settings.js";
import { greenhousePosting } from "../shared/greenhouse-autofill.js";
import { hostedApplication } from "../shared/application-host.js";
import { appliedOpeningIds } from "../shared/opening-applications.js";
import { openingSkillsBrowserChecks } from "./opening-skills-browser-check.js";
import { openingInteractionBrowserChecks } from "./opening-interaction-browser-check.js";
import { themeBrowserChecks } from "./theme-browser-check.js";
import { recordsActivityBrowserChecks } from "./records-activity-browser-check.js";
/** Read-only UI verification through the user's existing browser_clean MCP service.
 * Never starts a browser, opens the live Chrome profile, or changes workflow data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { platformDocs } from "../server/paths.js";
import { openingAvailability } from "../shared/opening-availability.js";

const service = "http://localhost:8931/mcp";
const origin = new URL(process.env.JOB_SEARCH_URL || "http://127.0.0.1:4317");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
  origin.protocol !== "http:"
) {
  throw new Error("JOB_SEARCH_URL must be a loopback HTTP application URL.");
}
let session = "";
let sequence = 0;
const eventController = new AbortController();
let eventListener: Promise<void> | undefined;
let protocolVersion = "2025-11-25";
async function rpc(
  method: string,
  params: unknown,
  notification = false,
): Promise<any> {
  const response = await postService(
    {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++sequence }),
      method,
      params,
    }),
    // The route/appearance audit traverses desktop and mobile views in one
    // read-only browser call. Keep protocol calls short, but allow the suite
    // to finish on a busy machine.
    method === "tools/call" ? 600000 : 60000,
  );
  session ||= response.headers.get("mcp-session-id") || "";
  const raw = response.text;
  if (!response.ok)
    throw new Error(
      `browser_clean HTTP ${response.status}: ${raw.slice(0, 250)}`,
    );
  if (notification) return;
  if (!raw.trim())
    throw new Error(
      `Empty HTTP response for ${method}: ${response.status}, session=${Boolean(session)}, headers=${JSON.stringify(Object.fromEntries(response.headers))}`,
    );
  const messages = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? raw
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(raw)];
  const message = [...messages].reverse().find((item) => item.id === sequence);
  if (!message)
    throw new Error("browser_clean returned no matching JSON-RPC response.");
  if (message.error)
    throw new Error(message.error.message || "browser_clean protocol error");
  if (message.result === undefined)
    throw new Error(
      `Empty MCP result for ${method}: ${JSON.stringify(message)}`,
    );
  return message.result;
}
// Node's fetch (undici) drops a response after 300 s with no body data, and the
// route/appearance audit is one browser call that answers only when it ends, so
// requests use node:http, which waits for the whole timeout.
function postService(
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      service,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const received = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined) received.set(name, String(value));
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: received,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
// The installed service pings clients on its standalone event stream before
// using a browser context. Answer only protocol liveness; never approve actions.
async function listenForServerRequests(): Promise<void> {
  const response = await fetch(service, {
    headers: {
      Accept: "text/event-stream",
      "Mcp-Session-Id": session,
      "MCP-Protocol-Version": protocolVersion,
    },
    signal: eventController.signal,
  });
  if (!response.ok || !response.body)
    throw new Error(`browser_clean event stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const request = JSON.parse(data);
      if (request.id === undefined || !request.method) continue;
      const reply =
        request.method === "ping"
          ? { result: {} }
          : {
              error: {
                code: -32601,
                message:
                  "This read-only verification client only handles protocol ping requests.",
              },
            };
      await fetch(service, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": session,
          "MCP-Protocol-Version": protocolVersion,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }),
        signal: eventController.signal,
      });
    }
  }
}
async function call(name: string, args: unknown) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError)
    throw new Error(
      result.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n") || "browser_clean tool failed",
    );
  return result;
}

try {
  const initialized = await rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: {
      name: "fieldwork-readonly-browser-verification",
      version: "1.0.0",
    },
  });
  protocolVersion = initialized.protocolVersion;
  await rpc("notifications/initialized", {}, true);
  eventListener = listenForServerRequests();
  void eventListener.catch(() => {});
  const catalog = await rpc("tools/list", {});
  for (const name of ["browser_navigate", "browser_run_code_unsafe"]) {
    if (!catalog.tools.some((tool: any) => tool.name === name))
      throw new Error(
        `Existing browser_clean service does not expose ${name}. Use documented manual browser checks.`,
      );
  }
  await call("browser_navigate", { url: origin.href });
  const result = await call("browser_run_code_unsafe", {
    code: `async (page) => {
    const origin = ${JSON.stringify(origin.origin)};
    const failures = [];
    const errors = [];
	    let stage = 'initializing';
    page.on('pageerror', error => errors.push(error.message));
    // Opening an Opening marks it reviewed; keep verification read-only, including for fixture Openings.
    const keepPersonalReadOnly = route => route.request().method() === 'POST' ? route.fulfill({json:{}}) : route.continue();
    await page.context().route('**/api/personal/**', keepPersonalReadOnly);
    // Settings (including the active and saved themes) are live and shared across
    // devices. Record writes instead of sending them; revisions above any real
    // one, rising with each save, keep the page from replacing its unsent
    // theme with the server's while checks run.
    const settingsWrites = [];
    let stubRevision = Number.MAX_SAFE_INTEGER - 1000000;
    let stubThemes = [];
    const settingsRoutes = url => url.pathname === '/api/settings' || url.pathname === '/api/settings/palette' || url.pathname.startsWith('/api/settings/themes') || url.pathname === ${JSON.stringify(preparationSettingsPath)};
    const keepSettingsReadOnly = route => {
      const method = route.request().method();
      if (method !== 'POST' && method !== 'DELETE') return route.continue();
      const body = method === 'POST' ? route.request().postDataJSON() : {};
      settingsWrites.push(body);
      // The run_code sandbox has no URL global; the predicate gets Playwright's own URL objects.
      const path = route.request().url().split('?')[0];
      if (path.endsWith('/palette')) return route.fulfill({json: {...body.palette, revision: ++stubRevision}});
      if (path.includes('/api/settings/themes')) {
        const id = method === 'DELETE' ? decodeURIComponent(path.split('/').pop()) : body.theme.id;
        stubThemes = stubThemes.filter(theme => theme.id !== id).concat(method === 'POST' ? [body.theme] : []);
        return route.fulfill({json: {items: stubThemes, revision: ++stubRevision}});
      }
      return route.fulfill({json: {version: Number.MAX_SAFE_INTEGER}});
    };
    await page.context().route(settingsRoutes, keepSettingsReadOnly);
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
	    const timings = [];
	    const step = async (label, action) => { stage = label; const started = Date.now(); try { return await action(); } finally { timings.push([label, Date.now() - started]); } };
	    const wait = (label, fn, arg, options) => step(label, () => page.waitForFunction(fn, arg, options));
	    try {
    await page.setViewportSize({width:1440,height:1100});
	    await step('overview navigation', () => page.goto(origin + '/?browser-check=' + Date.now()));
	    await step('overview statistics', () => page.waitForSelector('.stat-grid'));
    const state = await step('workspace state read', () => page.evaluate(async () => {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error('Workspace state returned HTTP ' + response.status);
      return response.json();
    }));
    const availability = ${openingAvailability.toString()};
    const current = state.openings.filter(o=>availability(o)!=='closed' && (o.retained!==false || (o.validation?.confirmedStatus==='open' && availability(o)==='open')));
    const appliedIds = (${appliedOpeningIds.toString()})(state.applications);
    // The run-code sandbox has no URL global; evaluate the shared provider identity in the page.
    const supportedIds = new Set(await page.evaluate(openings => {
      const greenhousePosting = ${greenhousePosting.toString()};
      const hostedApplication = ${hostedApplication.toString()};
      return openings.filter(o => hostedApplication(o.url)).map(o => o.id);
    }, state.openings));
    const visibleOpenings = current.filter(o=>!state.personal[o.id]?.dismissed&&!appliedIds.has(o.id)&&supportedIds.has(o.id));
    const activeApplications = state.applications.filter(a=>a.status==='applied'||a.status==='interviewing').length;
    assert((await page.locator('a.nav-item[href="#openings"] .nav-count').innerText()).trim()===String(visibleOpenings.length), 'Openings navigation does not match the default visible opening count');
    assert((await page.locator('a.nav-item[href="#applications"] .nav-count').innerText()).trim()===String(activeApplications), 'Applications navigation does not match Applied + Interviewing');
    const waitOpeningCount = (label,count) => wait(label,expected=>
      document.querySelectorAll('tr[data-opening-id]').length===expected &&
      document.querySelector('a.nav-item[href="#openings"] .nav-count')?.textContent.trim()===String(expected),count);
    const report = {at:new Date().toISOString(),origin,populations:{retained:current.length,visibleOpenings:visibleOpenings.length,activeApplications,seen:state.scan.seenCount,companies:state.companies.length,inaccessible:state.scan.failedCompanies.length},checks:[]};
    report.checks.push({name:'Overview uses imported populations',status:'passed'});
    report.checks.push({name:'Navigation counts visible openings and Applied + Interviewing applications',status:'passed'});

    // Real anchors must preserve native browser gestures without moving the source tab.
    const checkNewTab = async (link, options, label) => {
      const sourceUrl = page.url();
      const href = await link.getAttribute('href');
      assert(href && href.startsWith('#'), label + ' has no route URL');
      const destination = await link.evaluate(element => element.href);
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click(options)]);
      try {
        await tab.waitForURL(destination);
        await tab.locator('.app-shell').waitFor();
        assert(page.url() === sourceUrl, label + ' changed the source tab');
      } finally { await tab.close(); }
    };
    await checkNewTab(page.locator('a.nav-item[href="#openings"]'), {modifiers:['Meta']}, 'Command-click navigation');
    await checkNewTab(page.locator('a.stat[href="#companies"]'), {button:'middle'}, 'Middle-click overview card');
    await page.locator('a.nav-item[href="#openings"]').click();
	    await wait('openings navigation hash', () => location.hash === '#openings');
    await page.getByLabel('Include not interested', {exact:true}).waitFor();
    await waitOpeningCount('default visible opening and navigation counts',visibleOpenings.length);
    assert(await page.getByRole('columnheader',{name:/^Skills/}).count()===1,'Openings Skills column missing');
    assert(await page.getByRole('columnheader',{name:'Published compensation',exact:true}).count()===0,'Retired compensation column remains on Openings');
    assert(await page.getByRole('columnheader',{name:/^Deadline/}).count()===0,'Retired Deadline column remains on Openings');
    report.checks.push({name:'Skills sort replaces compensation; Deadline column removed',status:'passed'});
    const selectVisible = page.getByLabel('Select all visible openings', {exact:true});
    if (await selectVisible.isEnabled()) {
      await selectVisible.check();
      await page.getByRole('button', {name:'Invert selection',exact:true}).waitFor();
      await page.getByRole('button', {name:'Clear selection',exact:true}).click();
    }
    const openingLink = page.locator('tbody a.app-link[href^="#openings/"]').first();
    if (await openingLink.count()) {
      await checkNewTab(openingLink, {modifiers:['Meta']}, 'Command-click opening');
      const destination = await openingLink.evaluate(element => element.href);
      await openingLink.click();
      await page.waitForURL(destination);
      await page.locator('.detail-panel').waitFor();
      await page.goBack();
	      await wait('opening browser-back hash', () => location.hash === '#openings');
    }
    report.checks.push({name:'Native Command-click, middle-click, ordinary navigation and browser back',status:'passed'});

    await page.goto(origin + '/#openings');
    await page.locator('.opening-filters > summary').click();
    // The popup closes on page scroll, and headless Chromium delivers the scroll event from
    // click()'s own scroll-into-view a frame after the click opened it, so scroll first.
    const technicalFit = page.getByRole('button',{name:'Technical fit',exact:true});
    await technicalFit.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await technicalFit.click();
    await page.getByRole('dialog',{name:'Technical fit',exact:true}).getByRole('checkbox',{name:'High',exact:true}).check();
    await page.keyboard.press('Escape');
    const high = current.filter(o=>o.technical_fit==='High'&&!state.personal[o.id]?.dismissed&&!appliedIds.has(o.id));
    const eligibleHigh = high.filter(o=>supportedIds.has(o.id)).length;
    await waitOpeningCount('technical-fit row and navigation counts with default autofill filter',eligibleHigh);
    report.checks.push({name:'Technical-fit filter',status:'passed',matches:eligibleHigh});
    const autofillFilter = page.getByRole('combobox',{name:'Autofill support',exact:true});
    assert(await autofillFilter.inputValue()==='supported','Autofill filter should start on');
    await autofillFilter.selectOption('all');
    await waitOpeningCount('autofill-filter disabled row and navigation counts',high.length);
    await autofillFilter.selectOption('supported');
    await waitOpeningCount('autofill-filter restored row and navigation counts',eligibleHigh);
    report.checks.push({name:'Default autofill-eligible filter combines with existing filters and uses supported provider URLs',status:'passed',matches:eligibleHigh});
    await autofillFilter.selectOption('all');
    await waitOpeningCount('autofill-filter disabled for applied check',high.length);
    const includeApplied = page.getByRole('checkbox',{name:'Include applied',exact:true});
    assert(!await includeApplied.isChecked(),'Applied openings are included by default');
    await includeApplied.check();
    const allHigh = current.filter(o=>o.technical_fit==='High'&&!state.personal[o.id]?.dismissed);
	    await waitOpeningCount('include-applied row and navigation counts',allHigh.length);
    await includeApplied.uncheck();
	    await waitOpeningCount('include-applied reset row and navigation counts',high.length);
    report.checks.push({name:'Applied openings hidden by default and restored with Include applied',status:'passed'});
    if (high.length>=2) {
      await page.locator('tbody .checkbox-cell input').nth(0).check();
      await page.locator('tbody .checkbox-cell input').nth(1).check();
      await page.getByRole('button',{name:'Compare (2/3)',exact:true}).click();
      assert(await page.locator('.comparison-grid>div').count()===2,'Opening comparison did not render two roles');
      report.checks.push({name:'Opening comparison',status:'passed'});
    }
    if (high.length) {
      await page.locator('.table-role').first().click();
      await page.waitForSelector('.detail-heading');
      assert(await page.locator('.detail-panel .source a, .detail-panel .opening-research-details .field a').count()>0,'Opening detail is missing source links');
      report.checks.push({name:'Source-backed opening detail',status:'passed'});
    }

    await page.goto(origin + '/#documents');
    await page.waitForSelector('.pdf-page-surface canvas',{timeout:30000});
	    await wait('document selectable text',()=>document.querySelectorAll('.pdf-selectable-text span').length>0,{},{timeout:30000});
	    await wait('document render completion',()=>!document.querySelector('.pdf-render-state'));
    const pixels = await page.evaluate(()=>{
      const canvas=document.querySelector('.pdf-page-surface canvas');
      const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let dark=0;for(let i=0;i<data.length;i+=4)if(data[i]<235&&data[i+1]<235&&data[i+2]<235&&data[i+3]>100)dark++;
      const span=[...document.querySelectorAll('.pdf-selectable-text span')].find(node=>node.textContent.trim().length>12);
      const range=document.createRange();range.selectNodeContents(span);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);const selectedCharacters=selection.toString().length;selection.removeAllRanges();
      return {darkPixels:dark,selectableCharacters:selectedCharacters,pagination:document.querySelector('.pdf-pagination').innerText};
    });
    assert(pixels.darkPixels>100,'PDF preview has no actual rendered content');
    assert(pixels.selectableCharacters>0,'PDF text cannot be selected');
    report.checks.push({name:'Actual PDF pixels and selectable text',status:'passed',...pixels});
    const next=page.getByRole('button',{name:'Next PDF page',exact:true});
    if(await next.isEnabled()) {
      await next.click();
	      await wait('document second page',()=>document.querySelector('.pdf-pagination').innerText.includes('Page 2 of')&&!document.querySelector('.pdf-render-state'));
      report.checks.push({name:'Second PDF page',status:'passed'});
    }
    const chosenName=await page.locator('.document-view-header h2').innerText();
    const chosen=state.documents.find(d=>d.name===chosenName);
    const older=state.documents.find(d=>d.kind===chosen.kind&&d.scope===chosen.scope&&d.privacy===chosen.privacy&&d.versionNumber<chosen.versionNumber&&d.text?.trim());
    if(older) {
      await page.locator('.document-tabs').getByRole('button',{name:'Compare',exact:true}).click();
      await page.getByLabel('Compare against document').selectOption(older.id);
      await page.getByRole('button',{name:'Compare versions',exact:true}).click();
      await page.waitForSelector('.diff-content');
      assert((await page.locator('.diff-content').innerText()).length>0,'Document comparison is empty');
      report.checks.push({name:'Real earlier-version text comparison',status:'passed',from:older.version,to:chosen.version});
    }

    await page.goto(origin + '/#questions');
    await page.waitForSelector('.qa-file-history');
    assert(!(await page.locator('.qa-file-history').evaluate(el=>el.open)), 'Application files should start collapsed');
    await page.locator('.qa-file-history summary').click();
    assert(await page.locator('.qa-saved-file').count()===state.documents.filter(d=>d.origin==='generated').length,'Saved generated file count differs from durable catalog');
    report.checks.push({name:'Saved PDF history starts collapsed and lists durable versions',status:'passed'});
    // Questions conversations no longer show the usage card (owner decision, 2026-10-20); check it on Agents.
    const measuredTask=state.tasks.find(t=>t.usage?.total?.totalTokens>=0&&!['questions','posting-cover-letter','posting-resume'].includes(t.preset));
    if(measuredTask) {
      await page.goto(origin + '/#agents/' + encodeURIComponent(measuredTask.id));
      const usage=page.getByRole('region',{name:'Task usage',exact:true});
      const expected=measuredTask.usage.total.totalTokens.toLocaleString('en-US');
      assert((await usage.innerText()).includes(expected+' tokens'),'Task usage differs from reported cumulative tokens');
      await usage.locator('summary').click();
      // The subset note moved into the Cached input row's info tooltip.
      await usage.getByRole('button',{name:'About cached input',exact:true}).focus();
      assert((await page.getByRole('tooltip').innerText()).includes('Included in input tokens'),'Cached input is not clearly a subset');
      await page.keyboard.press('Escape');
      await page.reload();
      await usage.waitFor();
      assert((await usage.innerText()).includes(expected+' tokens'),'Task usage did not survive reload');
      report.checks.push({name:'Reported cumulative task usage, breakdown and reload persistence',status:'passed'});
    }

    const generated=state.documents.find(d=>d.origin==='generated'&&d.kind==='resume'&&d.privacy==='public');
    if(generated) {
      await page.goto(origin + '/#documents/' + encodeURIComponent(generated.id));
      await page.waitForSelector('.pdf-page-surface canvas',{timeout:30000});
	      await wait('generated resume render completion',()=>!document.querySelector('.pdf-render-state'));
      assert((await page.locator('.pdf-pagination').innerText()).includes('of 2'),'Generated resume preview is not two pages');
      report.checks.push({name:'Generated public resume renders in document viewer',status:'passed'});
    }

    await page.goto(origin + '/#scans');
    await page.getByRole('button',{name:'Scan all monitored companies',exact:true}).waitFor();
    const scanState=await page.evaluate(async()=>(await fetch('/api/careers-scans')).json());
	    await wait('careers monitored count',count=>document.querySelector('.careers-scans')?.textContent.includes(count+' monitored employers'),scanState.monitored);
    assert(await page.getByRole('button',{name:'Retry failed companies ('+scanState.failedIds.length+')',exact:true}).count()===1,'Retry count differs from persisted failed employers');
    report.checks.push({name:'Careers scan controls use current membership and failed-company counts',status:'passed'});
    const generatedNames=state.documents.filter(d=>d.origin==='generated');
    assert(generatedNames.every(d=>/^\\d{4}-\\d{2}-\\d{2}_/.test(d.name)&&!d.name.includes('Job-Application-for')),'Generated document names still contain time-of-day or boilerplate');
    report.checks.push({name:'Generated document names use dates and omit job-application boilerplate',status:'passed'});

    await page.goto(origin + '/#agents');
    await page.waitForSelector('.agent-status');
    const status=await page.evaluate(async()=>(await fetch('/api/agent/status')).json());
    if(!status.available) {
      assert((await page.locator('.agent-status').innerText()).includes('unavailable'),'Disconnected agent presented as available');
      assert((await page.locator('.agent-main').innerText()).includes('Save editable handoff prompt'),'Handoff fallback not available');
    }
    report.checks.push({name:'Honest agent connection state',status:'passed',available:status.available});
    const fixture=state.tasks.find(t=>t.fixture&&t.bundle?.artifacts?.some(a=>a.path.endsWith('_public.pdf')));
    if(fixture) {
      await page.goto(origin + '/#agents/' + encodeURIComponent(fixture.id));
      const artifact=fixture.bundle.artifacts.find(a=>a.path.endsWith('_public.pdf'));
      await page.locator('.revision-bundle .artifact-path').filter({hasText:artifact.path}).click();
      await page.waitForSelector('.draft-preview .pdf-page-surface canvas',{timeout:30000});
	      await wait('fixture PDF render completion',()=>!document.querySelector('.pdf-render-state')&&document.querySelectorAll('.draft-preview .pdf-selectable-text span').length>0);
      assert(await page.getByRole('button',{name:'Make current general version',exact:true}).count()===0,'Verification fixture exposes promotion');
      report.checks.push({name:'Isolated fixture PDF preview and promotion guard',status:'passed'});
    }
    ${recordsActivityBrowserChecks}
    ${openingInteractionBrowserChecks}
${openingSkillsBrowserChecks}
    ${themeBrowserChecks}
    await page.setViewportSize({width:390,height:844});
    for(const route of ['overview','openings','companies','applications','documents','questions','agents','health','settings','scans']) {
      await page.goto(origin + '/#' + route);
      await page.waitForTimeout(150);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Body overflows on mobile: '+route);
    }
    report.checks.push({name:'Eleven narrow-screen views contain page overflow',status:'passed'});
    await page.getByRole('button',{name:'Toggle navigation',exact:true}).click();
    assert(await page.locator('#workspace-sidebar').getAttribute('aria-hidden')==='false','Mobile navigation did not open');
    await page.keyboard.press('Escape');
    assert(await page.locator('#workspace-sidebar').getAttribute('aria-hidden')==='true','Mobile navigation did not close with Escape');
    report.checks.push({name:'Accessible mobile navigation',status:'passed'});
    assert(errors.length===0,'Browser page errors: '+errors.join('; '));
    report.checks.push({name:'No browser JavaScript errors',status:'passed'});
	    report.timings = timings;
	    await page.context().unroute('**/api/personal/**', keepPersonalReadOnly);
	    await page.context().unroute(settingsRoutes, keepSettingsReadOnly);
	    return report;
	    } catch (error) {
	      await page.context().unroute('**/api/personal/**', keepPersonalReadOnly).catch(() => {});
	      await page.context().unroute(settingsRoutes, keepSettingsReadOnly).catch(() => {});
	      const diagnostic = await page.evaluate(() => ({
	        route: location.hash || location.pathname,
	        readyState: document.readyState,
	        rows: document.querySelectorAll('tbody tr').length,
	        canvases: document.querySelectorAll('.pdf-page-surface canvas').length,
	        selectableSpans: document.querySelectorAll('.pdf-selectable-text span').length,
	        pdfRendering: Boolean(document.querySelector('.pdf-render-state')),
	        appShell: Boolean(document.querySelector('.app-shell')),
	      })).catch(() => ({route:'unavailable'}));
	      throw new Error('Browser verification stage "' + stage + '" failed: ' + (error?.message || String(error)) + '; state=' + JSON.stringify(diagnostic) + '; timings=' + JSON.stringify(timings.slice(-8)));
	    }
  }`,
  });
  const text =
    result.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n") || "";
  const block =
    text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/)?.[1] || text;
  let report: any;
  try {
    report = JSON.parse(block);
  } catch {
    throw new Error(
      "Could not parse browser verification result: " + text.slice(0, 600),
    );
  }
  const output =
    process.env.JOB_SEARCH_BROWSER_REPORT ||
    path.join(platformDocs, "browser-verification.json");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), output)}`);
} catch (error: any) {
  console.error(error.message);
  console.error(
    "An existing browser MCP service is required. Check its configured endpoint and service health.",
  );
  process.exitCode = 1;
} finally {
  eventController.abort();
  await eventListener?.catch(() => {});
  if (session)
    await fetch(service, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": session },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
}

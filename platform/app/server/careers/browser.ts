import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
import { retiredJobBoard } from "../../shared/posting-url.js";
import {
  browserTransportHeaders,
  cleanBrowserMcpUrl,
} from "../browser-service.js";
import { postingUrl } from "../job-posting.js";
import type { CareersResponse } from "./http.js";
const service = cleanBrowserMcpUrl();
/** Render only public HTTPS career pages in browser_clean; no login state or submissions. */
export async function renderCareerPage(
  value: string,
  settings: () => TunableSettings = () => ({}),
): Promise<CareersResponse> {
  if (retiredJobBoard(value))
    throw Error("Ashby/Lever integrations are retired");
  const target = postingUrl(value);
  if (target.protocol !== "https:" || (target.port && target.port !== "443"))
    throw Error(
      "Browser career fallback only supports HTTPS on the default port",
    );
  const hosts = [
    target.hostname.replace(/^www\./, ""),
    "greenhouse.io",
    "workable.com",
    "workablecdn.com",
    "applytojob.com",
    "jobvite.com",
    "icims.com",
    "oraclecloud.com",
    "website-files.com",
    "webflow.com",
    "jsdelivr.net",
    "cloudfront.net",
    "cloudflare.com",
  ];
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
    const response = await fetch(service, {
      method: "POST",
      headers: {
        ...browserTransportHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocolVersion,
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++sequence }),
        method,
        params,
      }),
      signal: AbortSignal.timeout(
        tunableValue(settings(), "careers.browserRequestTimeoutS") * 1000,
      ),
    });
    session ||= response.headers.get("mcp-session-id") || "";
    const raw = await response.text();
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
    const message = [...messages]
      .reverse()
      .find((item) => item.id === sequence);
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
  // The installed service pings clients on its standalone event stream before
  // using a browser context. Answer only protocol liveness; never approve actions.
  async function listenForServerRequests(): Promise<void> {
    const response = await fetch(service, {
      headers: {
        ...browserTransportHeaders(),
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
            ...browserTransportHeaders(),
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
      clientInfo: { name: "fieldwork-careers-reader", version: "1.0.0" },
    });
    protocolVersion = initialized.protocolVersion;
    await rpc("notifications/initialized", {}, true);
    eventListener = listenForServerRequests();
    void eventListener.catch(() => {});
    const result = await call("browser_run_code_unsafe", {
      code: `async(page)=>{
      const hosts=${JSON.stringify(hosts)};let blockedEssential=0;
      await page.context().route('**/*',route=>{const r=route.request(),url=r.url();const authority=url.startsWith('https://')?url.slice(8).split('/')[0]:'';const host=(authority.endsWith(':443')?authority.slice(0,-4):authority).toLowerCase();const allowed=!host.includes('@')&&!host.includes(':')&&hosts.some(h=>host===h||host.endsWith('.'+h));if(!allowed||!['GET','HEAD'].includes(r.method())){if(['document','xhr','fetch'].includes(r.resourceType()))blockedEssential++;return route.abort();}return route.continue();});
      const response=await page.goto(${JSON.stringify(target.href)},{waitUntil:'domcontentloaded',timeout:${tunableValue(settings(), "careers.pageLoadWaitS") * 1000}});let settled=true;try{await page.waitForLoadState('networkidle',{timeout:${tunableValue(settings(), "careers.networkSettleS") * 1000}})}catch{settled=false}await page.waitForTimeout(${tunableValue(settings(), "careers.captureDelayMs")});
      const html=await page.evaluate(()=>{const copy=document.documentElement.cloneNode(true);copy.querySelectorAll('script:not([type="application/ld+json"]),style,noscript').forEach(e=>e.remove());return copy.outerHTML.slice(0,${tunableValue(settings(), "careers.captureLimitChars")})});
      return {url:page.url(),status:response?.status()||0,html,settled,blockedEssential};
    }`,
    });
    const output = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const data = JSON.parse(
      output.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/)?.[1] || output,
    );
    return {
      requestedUrl: target.href,
      url: data.url,
      status: data.status,
      type: "text/html",
      text: data.html,
      at: new Date().toISOString(),
      browserSettled: data.settled,
      browserBlockedEssential: data.blockedEssential,
    } as CareersResponse;
  } finally {
    eventController.abort();
    await eventListener?.catch(() => {});
    if (session)
      await fetch(service, {
        method: "DELETE",
        headers: {
          ...browserTransportHeaders(),
          "Mcp-Session-Id": session,
        },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
}

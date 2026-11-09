import { tunable } from "../tunables.js";
import { renderCareerPage } from "./browser.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  cpSync,
  renameSync,
  rmSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { Store, HttpError, sha256, atomicWrite, now } from "../storage.js";
import { parseOpenings } from "../importer.js";
import { normalizeFitCriteria } from "../../shared/fit-criteria.js";
import { publicCareersFetch, type CareersFetch } from "./http.js";
import { collectCompany, type CompanyScan } from "./providers.js";
import { ResumableJob } from "../resumable-job.js";
import {
  reconcileScan,
  selectedPostingEvidence,
  openingsMarkdown,
  validateReconciliation,
} from "./reconcile.js";
import type { CareerScan } from "../records.js";
import { errorMessage } from "../import/read-context.js";
import * as scanRecords from "./scan-records.js";
import { monitoredCompanies, collectMonitoredCompany } from "./monitored.js";

type ReconcileInput = Parameters<typeof reconcileScan>[0];
type ScanValue = ReturnType<typeof reconcileScan>;
type ScanValidation = ReturnType<typeof validateReconciliation>;
type ScanRow = CareerScan["rows"][number] & { artifactHash?: string };
type ScanBaseline = {
  previous: ReconcileInput["previous"];
  openings: ReconcileInput["openings"];
  history: string;
};
type CollectionArguments = Parameters<typeof collectCompany>;
type BrowserEvidenceFetch = NonNullable<CollectionArguments[5]>;
type ScanOutput = {
  "company_careers/current_openings.md": string;
  "company_careers/scan_state.json": string;
  "company_careers/scan_history.md": string;
};
type ScanManifest = {
  phase: "prepared";
  snapshot: string;
  files: { path: string; beforeHash: string; afterHash: string }[];
};

function renderScanHistory(
  completedAt: string,
  id: string,
  mode: string,
  summary: ScanValue["summary"],
  snapshot: string,
) {
  const label =
    mode === "all" ? "all monitored companies" : "retry failed companies";
  return (
    `## ${completedAt} — ${label}\n` +
    `<!-- scan_id: ${id} -->\n\n` +
    `- **Coverage:** ${summary.attempted} attempted of ${summary.monitored} monitored; ${summary.successful} complete checks; ${summary.failed} failed or partial.\n` +
    `- **Changes:** ${summary.new} new candidates; ${summary.changed} changed; ${summary.reopened} reopened; ${summary.closed} confirmed closed; ${summary.unconfirmed} unconfirmed retained roles.\n` +
    `- **Populations:** ${summary.retained} retained opportunities; ${summary.seen} historical seen identities.\n` +
    `- **Details:** [Snapshot and limitations](${snapshot}/README.md). Provisional new matches need fit review; company WLB research was not refreshed.\n\n`
  );
}

function renderSnapshotReadme(
  completedAt: string,
  mode: string,
  summary: ScanValue["summary"],
) {
  return (
    `# Explicit careers scan ${completedAt}\n\n` +
    `Mode: ${mode}. ${summary.attempted} employers attempted out of ${summary.monitored} monitored.\n\n` +
    `Public Greenhouse inventories are validated; Workday inventories require complete stable pagination. Career-page links are inspected for supported boards. Historical board hints are used only when their recorded careers URL still matches. Custom/JavaScript-only or blocked boards remain partial/failed; HTTP 200 alone does not prove inventory completeness. Per-company checked_at dates remain intact on retry.\n\n` +
    `New candidates receive conservative title/remote screening and require a resume/evidence fit review. Published salary snippets retain their original currencies and geographic wording. Previous fit/WLB judgments are dated context, not newly verified claims. Direct posting 404/410 establishes closure only with a complete board check; explicit closed messages are retained as evidence. Failed checks preserve roles as unconfirmed.\n\n` +
    `- [Company coverage](company_results.json)\n` +
    `- [Retained openings](qualified_openings.json)\n` +
    `- [Posting descriptions](selected-source-jobs.json)\n` +
    `- [Changes](changes.json)\n` +
    `- [Validation](validation.json)\n\n` +
    `The evidence directory contains gzip-compressed JSON response records with URLs, retrieval timestamps, status and response text. No cookies, account credentials, applications or employer messages were sent.\n`
  );
}

const inputs = [
  "company_careers/companies.md",
  "company_careers/current_openings.md",
  "company_careers/scan_state.json",
  "company_careers/scan_history.md",
];
function sourcePath(store: Store, relative: string) {
  if (
    !relative.startsWith("company_careers/") ||
    relative.split("/").some((p) => p === ".." || p === ".") ||
    relative.includes("\\") ||
    relative.includes("\0")
  )
    throw new HttpError(403, "Invalid careers source path");
  let current = store.root;
  if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)
    throw new HttpError(403, "Source root changed");
  for (const p of relative.split("/")) {
    current = path.join(current, p);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new HttpError(403, "Careers paths cannot use symlinks");
    } catch (e) {
      if (!scanRecords.isMissingCareerPath(e)) throw e;
    }
  }
  return current;
}
export class CareersScanManager extends ResumableJob<"career_scan"> {
  constructor(
    private store: Store,
    private notify: () => void,
    private reindex: () => Promise<unknown>,
    private fetchOverride?: CareersFetch,
  ) {
    super(store, notify, "career_scan");
    this.recoverInterruptedRuns({
      before: (run) => {
        if (run.status === "publishing") this.recover(run);
      },
      reload: (run) => store.get("career_scan", run.id),
      eligibleStatuses: ["running", "pausing"],
      interrupt: (run) =>
        store.put("career_scan", run.id, {
          ...run,
          status: "interrupted",
          error:
            "Server restarted. Resume this scan to continue pending companies; no task was restarted automatically.",
        }),
    });
  }
  private dir(id: string, relative = "") {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      relative.includes("..") ||
      path.isAbsolute(relative)
    )
      throw new HttpError(400, "Invalid scan artifact path");
    let current = this.store.dataDir;
    if (
      lstatSync(current).isSymbolicLink() ||
      realpathSync(current) !== current
    )
      throw new HttpError(403, "Data root changed");
    for (const part of [
      "careers-scans",
      id,
      ...relative.split("/").filter(Boolean),
    ]) {
      current = path.join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new HttpError(403, "Scan artifacts cannot use symlinks");
      } catch (e) {
        if (!scanRecords.isMissingCareerPath(e)) throw e;
      }
    }
    return current;
  }
  private get(id: string) {
    const r = this.store.get("career_scan", id);
    if (!r) throw new HttpError(404, "Careers scan missing");
    return r;
  }
  private save(id: string, values: object) {
    this.saveRun({ ...this.get(id), ...values }, id);
    return this.get(id);
  }
  monitored() {
    return monitoredCompanies(this.store);
  }
  state() {
    const runs = this.store
      .list("career_scan")
      .slice()
      .reverse()
      .map(
        ({ companies, sourceHashes, rows, fitCriteria: _criteria, ...r }) => ({
          ...r,
          rows,
          companyCount: companies.length,
        }),
      );
    return {
      runs: runs.slice(0, tunable(this.store, "careers.recentRuns")),
      monitored: this.monitored().length,
      failedIds: this.failedIds(),
      activeId: this.activeId,
    };
  }
  failedIds() {
    try {
      const value: unknown = JSON.parse(
        readFileSync(sourcePath(this.store, inputs[2]), "utf8"),
      );
      return scanRecords.failedCareerCompanyIds(
        value,
        new Set(this.monitored().map((company) => company.id)),
      );
    } catch {
      return [];
    }
  }
  private readScanSources(): {
    sourceHashes: Record<string, string>;
    previous: ScanBaseline["previous"];
    openings: ScanBaseline["openings"];
  } {
    const sourceHashes = Object.fromEntries(
      inputs.map((p) => [p, sha256(readFileSync(sourcePath(this.store, p)))]),
    );
    const previousValue: unknown = JSON.parse(
      readFileSync(sourcePath(this.store, inputs[2]), "utf8"),
    );
    const openings = parseOpenings(
      readFileSync(sourcePath(this.store, inputs[1]), "utf8"),
    ).map((o) => {
      const cached = this.store.get("cache_opening", o.id);
      return {
        ...o,
        ...(cached?.hash === o.hash
          ? {
              description: cached.description,
              descriptionConfirmedAt: cached.descriptionConfirmedAt,
              descriptionSourcePath: cached.descriptionSourcePath,
              publishedCompensation: cached.publishedCompensation,
            }
          : {}),
      };
    });
    const previous = scanRecords.matchingCareerScanState(
      previousValue,
      openings.map((opening) => opening.id),
    );
    if (!previous)
      throw new HttpError(
        409,
        `${inputs[1]} lists openings that ${inputs[2]} does not match, or ${inputs[2]} is invalid. Reconcile the two files before scanning.`,
      );
    return { sourceHashes, previous, openings };
  }
  start(mode: "all" | "failed", requestId: string) {
    const old = this.store
      .list("career_scan")
      .find((r) => r.requestId === requestId);
    if (old) return old;
    if (this.running)
      throw new HttpError(409, "A careers scan is already running");
    const companies = this.monitored();
    if (!companies.length) throw new HttpError(400, "No monitored companies");
    const { sourceHashes, previous, openings } = this.readScanSources();
    const failed = new Set(this.failedIds()),
      targets =
        mode === "all" ? companies : companies.filter((c) => failed.has(c.id));
    if (!targets.length)
      throw new HttpError(400, "No failed monitored companies to retry");
    const id = randomUUID();
    const run = {
      id,
      requestId,
      mode,
      status: "running",
      startedAt: now(),
      updatedAt: now(),
      companies,
      sourceHashes,
      rows: targets.map((c) => ({
        company_id: c.id,
        company: c.name,
        status: "pending",
        result: null,
      })),
      poolHash: sha256(
        JSON.stringify(companies.map((c) => [c.id, c.name, c.fields])),
      ),
      completed: 0,
      total: targets.length,
      fitCriteria: normalizeFitCriteria(
        this.store.get("settings", "main")?.fitCriteria,
      ),
    };
    atomicWrite(
      this.dir(id, "baseline.json"),
      JSON.stringify(
        {
          previous,
          openings,
          history: readFileSync(sourcePath(this.store, inputs[3]), "utf8"),
        },
        null,
        2,
      ),
    );
    this.store.put("career_scan", id, run);
    this.store.journal(
      "careers_scan_started",
      `Started ${mode === "all" ? "all monitored companies" : "failed-company retry"}: ${targets.length} employers`,
      id,
    );
    this.launch(id);
    return run;
  }
  resume(id: string) {
    if (this.running)
      throw new HttpError(409, "A careers scan is already running");
    const r = this.get(id);
    if (r.status !== "interrupted")
      throw new HttpError(409, "Only interrupted scans can resume");
    this.save(id, {
      status: "running",
      error: null,
      rows: r.rows.map((row) =>
        row.status === "complete" ? row : { ...row, status: "pending" },
      ),
    });
    this.launch(id);
    return this.get(id);
  }
  pause(id: string) {
    if (id !== this.activeId || !this.controller)
      throw new HttpError(409, "This scan is not running");
    this.save(id, { status: "pausing" });
    this.controller.abort();
    return this.get(id);
  }
  private launch(id: string) {
    this.launchRun(
      id,
      (signal) => this.work(id, signal),
      (e, signal) =>
        this.save(id, {
          status: signal.aborted ? "interrupted" : "failed",
          error: String(errorMessage(e) || e),
        }),
      () => {
        this.store.autoExport();
        this.notify();
      },
      () => this.notify(),
    );
  }
  private createEvidenceFetch(
    id: string,
    cid: string,
    signal: AbortSignal,
  ): CareersFetch {
    return async (url, body) => {
      const response = await (this.fetchOverride
        ? this.fetchOverride(url, body)
        : publicCareersFetch(url, signal, body, () => this.store.settings()));
      const name = `${cid}-${sha256(url + JSON.stringify(body) + response.at + response.text).slice(0, 24)}.json.gz`;
      atomicWrite(
        this.dir(id, "evidence/" + name),
        gzipSync(
          Buffer.from(
            JSON.stringify({ ...response, requestBody: body ?? null }),
          ),
        ),
      );
      return response;
    };
  }
  private createBrowserEvidenceFetch(
    id: string,
    cid: string,
  ): BrowserEvidenceFetch {
    return async (url) => {
      const page = await renderCareerPage(url, () => this.store.settings());
      atomicWrite(
        this.dir(
          id,
          "evidence/" +
            cid +
            "-browser-" +
            sha256(page.at + page.text).slice(0, 20) +
            ".json.gz",
        ),
        gzipSync(Buffer.from(JSON.stringify(page))),
      );
      return page;
    };
  }
  private markCompanyRunning(id: string, cid: string) {
    this.save(id, {
      rows: this.get(id).rows.map((r) =>
        r.company_id === cid
          ? { ...r, status: "running", startedAt: now() }
          : r,
      ),
    });
  }
  private saveCompanyResult(
    id: string,
    cid: string,
    company: CollectionArguments[0],
    result: CompanyScan,
  ) {
    const data = JSON.stringify(result);
    atomicWrite(this.dir(id, `companies/${cid}.json`), data);
    const rows = this.get(id).rows.map((r) =>
      r.company_id === cid
        ? {
            company_id: cid,
            company: company.name,
            status: "complete",
            result: result.result,
            checkedAt: result.checked_at,
            inventoryCount: result.inventory_count,
            notes: result.notes,
            sources: result.sources,
            artifactHash: sha256(data),
          }
        : r,
    );
    this.save(id, {
      rows,
      completed: rows.filter((r) => r.status === "complete").length,
    });
  }
  private consumeQueue(
    id: string,
    initial: CareerScan,
    base: ScanBaseline,
    queue: string[],
    signal: AbortSignal,
  ) {
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        const cid = queue.shift()!;
        const company = initial.companies.find((c) => c.id === cid);
        if (!company)
          throw Error(`Monitored company ${cid} is missing from the scan`);
        this.markCompanyRunning(id, cid);
        try {
          let result: CompanyScan;
          try {
            result = await collectMonitoredCompany(
              this.store,
              company,
              base,
              this.createEvidenceFetch(id, cid, signal),
              signal,
              this.fetchOverride
                ? undefined
                : this.createBrowserEvidenceFetch(id, cid),
            );
          } catch (e) {
            if (signal.aborted) throw e;
            result = {
              company_id: cid,
              company: company.name,
              result: "FAILED",
              complete: false,
              inventory_count: null,
              sources: [company.fields?.["Careers URL"] || ""],
              notes: errorMessage(e),
              checked_at: now(),
              jobs: [],
              direct: {},
            };
          }
          signal.throwIfAborted();
          this.saveCompanyResult(id, cid, company, result);
        } catch (e) {
          if (signal.aborted) {
            this.save(id, {
              rows: this.get(id).rows.map((r) =>
                r.company_id === cid ? { ...r, status: "pending" } : r,
              ),
            });
            return;
          }
          throw e;
        }
      }
    };
    return Promise.all(
      Array.from(
        {
          length: Math.min(
            tunable(this.store, "careers.workers"),
            queue.length,
          ),
        },
        worker,
      ),
    );
  }
  private readCompanyResults(id: string): CompanyScan[] {
    return this.get(id).rows.map((row: ScanRow) => {
      const bytes = readFileSync(
        this.dir(id, `companies/${row.company_id}.json`),
      );
      if (sha256(bytes) !== row.artifactHash)
        throw Error(
          "Saved company evidence changed; no results were published",
        );
      return scanRecords.parseCompanyScan(bytes.toString("utf8"));
    });
  }
  private stageSnapshot(
    id: string,
    completedAt: string,
    snapshot: string,
    initial: CareerScan,
    base: ScanBaseline,
    value: ScanValue,
    results: CompanyScan[],
    markdown: string,
    validation: ScanValidation,
  ) {
    const staged = this.dir(id, "snapshot");
    mkdirSync(staged, { recursive: true });
    const write = (p: string, data: unknown) =>
      atomicWrite(
        this.dir(id, "snapshot/" + p),
        typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n",
      );
    write("qualified_openings.json", {
      scan_timestamp: completedAt,
      baseline: false,
      openings: value.openings,
    });
    write("company_results.json", value.coverage);
    write(
      "selected-source-jobs.json",
      selectedPostingEvidence(value.openings, results, base.openings),
    );
    write("validation.json", validation);
    write("changes.json", value.changes);
    write(
      "README.md",
      renderSnapshotReadme(completedAt, initial.mode, value.summary),
    );
    if (existsSync(this.dir(id, "evidence")))
      cpSync(this.dir(id, "evidence"), this.dir(id, "snapshot/evidence"), {
        recursive: true,
      });
    return staged;
  }
  private composeOutput(
    snapshot: string,
    markdown: string,
    history: string,
    value: ScanValue,
    base: ScanBaseline,
  ): ScanOutput {
    return {
      "company_careers/current_openings.md": markdown,
      "company_careers/scan_state.json":
        JSON.stringify({ ...value.state, snapshot_path: snapshot }, null, 2) +
        "\n",
      "company_careers/scan_history.md": base.history.replace(
        /^(#[^\n]*\n)/,
        "$1\n" + history,
      ),
    };
  }
  private assertCurrentInputs(initial: CareerScan) {
    const currentPool = this.monitored()
      .map((c) => c.id)
      .sort()
      .join("|");
    if (
      currentPool !==
        initial.companies
          .map((c) => c.id)
          .sort()
          .join("|") ||
      sha256(
        JSON.stringify(this.monitored().map((c) => [c.id, c.name, c.fields])),
      ) !== initial.poolHash
    )
      throw new HttpError(
        409,
        "The monitored company list changed during this scan. Evidence is saved; start a new scan against the current list.",
      );
    for (const [p, h] of Object.entries(initial.sourceHashes))
      if (sha256(readFileSync(sourcePath(this.store, p))) !== h)
        throw new HttpError(
          409,
          `Source changed during the scan: ${p}. Evidence is saved, and no source was overwritten. Start a new scan from the current sources.`,
        );
  }
  private preparePublication(
    id: string,
    snapshot: string,
    output: ScanOutput,
    initial: CareerScan,
  ): ScanManifest {
    const manifest: ScanManifest = {
      phase: "prepared",
      snapshot,
      files: Object.entries(output).map(([p, text]) => ({
        path: p,
        beforeHash: initial.sourceHashes[p],
        afterHash: sha256(text),
      })),
    };
    for (const [p, text] of Object.entries(output)) {
      atomicWrite(
        this.dir(id, "before/" + path.basename(p)),
        readFileSync(sourcePath(this.store, p)),
      );
      atomicWrite(this.dir(id, "after/" + path.basename(p)), text);
    }
    return manifest;
  }
  private publish(
    id: string,
    staged: string,
    snapshot: string,
    output: ScanOutput,
    initial: CareerScan,
    manifest: ScanManifest,
  ) {
    try {
      const target = sourcePath(this.store, snapshot);
      if (existsSync(target)) throw Error("Scan snapshot already exists");
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(staged, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      for (const [p, h] of Object.entries(initial.sourceHashes))
        if (sha256(readFileSync(sourcePath(this.store, p))) !== h)
          throw Error(`Source changed during publication: ${p}`);
      for (const [p, text] of Object.entries(output)) {
        if (
          sha256(readFileSync(sourcePath(this.store, p))) !==
          initial.sourceHashes[p]
        )
          throw Error(`Source changed during publication: ${p}`);
        atomicWrite(sourcePath(this.store, p), text);
      }
      atomicWrite(
        this.dir(id, "publish.json"),
        JSON.stringify({ ...manifest, phase: "published" }),
      );
    } catch (e) {
      this.recover(this.get(id));
      throw e;
    }
  }
  private prepareScan(id: string, initial: CareerScan, base: ScanBaseline) {
    const results = this.readCompanyResults(id).map((result) => ({
      ...result,
      jobs: result.jobs.filter(
        (job) =>
          !this.store.isDeleted(
            "cache_opening",
            `${result.company_id}:${job.id}`,
          ),
      ),
    }));
    const completedAt = now(),
      snapshot = `company_careers/research/scans/${completedAt.replace(/[:.]/g, "-")}-${id.slice(0, 8)}`;
    const value = reconcileScan({
      companies: initial.companies,
      previous: base.previous,
      openings: base.openings,
      results,
      id,
      completedAt,
      mode: initial.mode,
      descriptionChars: () => tunable(this.store, "careers.descriptionChars"),
      // Criteria are captured at scan start so a resumed scan keeps its filter.
      fitCriteria: normalizeFitCriteria(
        initial.fitCriteria ?? this.store.get("settings", "main")?.fitCriteria,
      ),
    });
    const markdown = openingsMarkdown(
      value.openings,
      completedAt,
      path.relative("company_careers", snapshot),
    );
    const validation = validateReconciliation(value, markdown, base.previous);
    const history = renderScanHistory(
      completedAt,
      id,
      initial.mode,
      value.summary,
      path.relative("company_careers", snapshot),
    );
    const staged = this.stageSnapshot(
      id,
      completedAt,
      snapshot,
      initial,
      base,
      value,
      results,
      markdown,
      validation,
    );
    const output = this.composeOutput(snapshot, markdown, history, value, base);
    return { completedAt, snapshot, value, validation, staged, output };
  }
  private async work(id: string, signal: AbortSignal) {
    const initial = this.get(id);
    const base: ScanBaseline = scanRecords.parseCareerScanBaseline(
      readFileSync(this.dir(id, "baseline.json"), "utf8"),
    );
    const queue = initial.rows
      .filter((r) => r.status !== "complete")
      .map((r) => r.company_id);
    await this.consumeQueue(id, initial, base, queue, signal);
    if (signal.aborted) {
      this.save(id, {
        status: "interrupted",
        interruptedAt: now(),
        error:
          "Paused. Completed company checks are saved; pending companies can resume.",
      });
      return;
    }
    const prepared = this.prepareScan(id, initial, base);
    await this.reindex();
    signal.throwIfAborted();
    this.assertCurrentInputs(initial);
    const { value, validation, staged, snapshot, output, completedAt } =
      prepared;
    const manifest = this.preparePublication(id, snapshot, output, initial);
    this.save(id, {
      status: "publishing",
      summary: value.summary,
      changes: value.changes,
      validation,
      snapshotPath: snapshot,
    });
    atomicWrite(this.dir(id, "publish.json"), JSON.stringify(manifest));
    this.publish(id, staged, snapshot, output, initial, manifest);
    await this.reindex();
    this.store.journal(
      "careers_scan_completed",
      `Careers scan: ${value.summary.new} new candidates, ${value.summary.changed} changed, ${value.summary.closed} closed, ${value.summary.failed} companies need another check`,
      id,
      value.summary,
    );
    this.save(id, {
      status: value.summary.failed ? "completed_with_gaps" : "completed",
      completedAt,
      error: null,
    });
  }
  private recover(run: scanRecords.RecoverableCareerScan) {
    const p = this.dir(run.id, "publish.json");
    if (!existsSync(p)) {
      this.store.put("career_scan", run.id, {
        ...run,
        status: "interrupted",
        error: "Publication was interrupted before writes. Resume to finish.",
      });
      return;
    }
    try {
      const m = scanRecords.parseCareerScanManifest(readFileSync(p, "utf8"));
      if (m.phase === "published") {
        this.store.put(
          "career_scan",
          run.id,
          scanRecords.completedRecoveredCareerScan(run, now()),
        );
        return;
      }
      const conflicts: string[] = [];
      for (const f of m.files) {
        const hash = sha256(readFileSync(sourcePath(this.store, f.path)));
        if (hash === f.afterHash)
          atomicWrite(
            sourcePath(this.store, f.path),
            readFileSync(this.dir(run.id, "before/" + path.basename(f.path))),
          );
        else if (hash !== f.beforeHash) conflicts.push(f.path);
      }
      if (existsSync(sourcePath(this.store, m.snapshot)))
        renameSync(
          sourcePath(this.store, m.snapshot),
          this.dir(run.id, "unpublished-snapshot"),
        );
      this.store.put("career_scan", run.id, {
        ...run,
        status: "failed",
        error: conflicts.length
          ? `Publication rolled back; external edits preserved at ${conflicts.join(", ")}`
          : "Interrupted publication rolled back. Evidence is saved; start a new scan.",
      });
    } catch (e) {
      this.store.put("career_scan", run.id, {
        ...run,
        status: "failed",
        error: errorMessage(e),
      });
    }
    this.store.autoExport();
  }
}

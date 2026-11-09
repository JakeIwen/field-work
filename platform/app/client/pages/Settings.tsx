import "../settings/settings.css";
import Maintenance, { type MaintenanceProps } from "../settings/Maintenance";
import AppearanceSettings from "../settings/AppearanceSettings";
import CodexModels from "../settings/CodexModels";
import GreenhousePacing from "../settings/GreenhousePacing";
import PreparationSettings from "../settings/PreparationSettings";
import Tunables from "../settings/Tunables";
import SettingsNav from "../settings/SettingsNav";
import SettingsSection from "../settings/SettingsSection";
import { settingsSections } from "../settings/settings-sections";
import GmailReplies from "../gmail/GmailReplies";
import { RecordsActivity } from "../settings/records/RecordsActivity";
import { useState } from "react";
import { ArrowDownToLine, History, Lock, RotateCcw, ShieldCheck, Timer, Filter, Wrench } from "lucide-react";
import InfoTooltip from "../ui/InfoTooltip";
import type { AppState } from "../../shared/types";
import { formatDate } from "../ui/dates";
import type { Go, Mutate, Notify } from "../workspace/workspace-actions";
import { Field } from "../ui/Field";
import { Source } from "../ui/Source";
import { defaultSchedules, normalizeSchedules, scheduleLabels, type ScheduleKey, type Schedules } from "../../shared/schedules";
import { defaultFitCriteria, fitCriteriaFields, normalizeFitCriteria, type FitCriteria } from "../../shared/fit-criteria";

const scheduleKeys = Object.keys(scheduleLabels) as ScheduleKey[];
const savedSchedules = (state: AppState): Schedules =>
  state.settings.schedules ? normalizeSchedules(state.settings.schedules) : defaultSchedules;
const savedCriteria = (state: AppState): FitCriteria =>
  state.settings.fitCriteria ? normalizeFitCriteria(state.settings.fitCriteria) : defaultFitCriteria;

function RefreshSchedules({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const current = savedSchedules(state);
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(scheduleKeys.map((k) => [k, { enabled: current[k].enabled, intervalHours: String(current[k].intervalHours) }])) as Record<ScheduleKey, { enabled: boolean; intervalHours: string }>,
  );
  const [saving, setSaving] = useState(false);
  const invalid = scheduleKeys.some((k) => {
    const n = Number(draft[k].intervalHours);
    return !Number.isInteger(n) || n < 1 || n > 168;
  });
  const dirty = scheduleKeys.some((k) => draft[k].enabled !== current[k].enabled || Number(draft[k].intervalHours) !== current[k].intervalHours);
  return (
    <form
      className="panel-body form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        // Merge edits into the latest saved schedules so scheduler timestamps are kept.
        const latest = savedSchedules(state);
        const schedules = Object.fromEntries(
          scheduleKeys.map((k) => [k, { ...latest[k], enabled: draft[k].enabled, intervalHours: Number(draft[k].intervalHours) }]),
        );
        setSaving(true);
        mutate("/api/settings", { schedules })
          .then(() => notify("Automatic refresh saved"))
          .catch(() => {})
          .finally(() => setSaving(false));
      }}
    >
      {!state.settings.schedules && (
        <p className="small muted">No schedule has been saved yet. Both are off by default.</p>
      )}
      <div className="schedule-grid">
        {scheduleKeys.map((k) => {
          const id = `schedule-${k}`;
          return (
            <fieldset key={k} className="schedule-row" aria-describedby={`${id}-help`}>
              <legend>{scheduleLabels[k].label}</legend>
              <span className="schedule-legend-help"><InfoTooltip label={`About ${scheduleLabels[k].label.toLowerCase()}`}>{scheduleLabels[k].help}</InfoTooltip></span>
              <span id={`${id}-help`} className="sr-only">{scheduleLabels[k].help}</span>
              <div className="schedule-controls">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft[k].enabled}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: { ...d[k], enabled: e.target.checked } }))}
                  />
                  Run automatically
                </label>
                <label className="schedule-interval">
                  Every
                  <input
                    type="number"
                    min={1}
                    max={168}
                    step={1}
                    inputMode="numeric"
                    aria-label={`${scheduleLabels[k].label} interval in hours`}
                    value={draft[k].intervalHours}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: { ...d[k], intervalHours: e.target.value } }))}
                    required
                  />
                  hours
                </label>
              </div>
              <dl className="schedule-times">
                <div>
                  <dt>Last started</dt>
                  <dd>{current[k].lastStartedAt ? formatDate(current[k].lastStartedAt, true) : "Never"}</dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>{!current[k].enabled ? "Off" : current[k].nextRunAt ? formatDate(current[k].nextRunAt, true) : "Not scheduled yet"}</dd>
                </div>
              </dl>
            </fieldset>
          );
        })}
      </div>
      {invalid && <p className="small" role="alert">Intervals must be whole hours from 1 to 168.</p>}
      <button className="button primary" disabled={saving || invalid || !dirty}>
        {saving ? "Saving…" : "Save schedules"}
      </button>
    </form>
  );
}

const criteriaText = (c: FitCriteria) =>
  Object.fromEntries(fitCriteriaFields.map((f) => [f.key, c[f.key].join("\n")])) as Record<string, string>;
const criteriaTerms = (text: string) => text.split("\n").map((t) => t.trim()).filter(Boolean);

function FitCriteriaForm({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const current = savedCriteria(state);
  const [draft, setDraft] = useState(() => criteriaText(current)),
    [saving, setSaving] = useState(false),
    [confirmReset, setConfirmReset] = useState(false);
  const saved = criteriaText(current);
  const dirty = fitCriteriaFields.some((f) => criteriaTerms(draft[f.key]).join("\n") !== saved[f.key]);
  const save = (criteria: FitCriteria, message: string) => {
    setSaving(true);
    return mutate("/api/settings", { fitCriteria: criteria })
      .then(() => notify(message))
      .catch(() => {})
      .finally(() => {
        setSaving(false);
        setConfirmReset(false);
      });
  };
  return (
    <form
      className="panel-body form-stack fit-criteria-form"
      onSubmit={(e) => {
        e.preventDefault();
        const next = { ...current } as FitCriteria;
        for (const f of fitCriteriaFields) next[f.key] = criteriaTerms(draft[f.key]);
        void save(next, "Scan fit criteria saved");
      }}
    >
      <div className="fit-criteria-fields">
        {fitCriteriaFields.map((f) => {
          const id = `fit-${f.key}`;
          const help = f.help;
          return <div className="fit-criteria-field" key={f.key}>
            <div className="fit-criteria-label">
              <label htmlFor={id}>{f.label}</label>
              {help && <InfoTooltip label={`About ${f.label.toLowerCase()}`}>{help}</InfoTooltip>}
            </div>
            {help && <span className="sr-only" id={`${id}-help`}>{help}</span>}
            <textarea
              id={id}
              rows={5}
              value={draft[f.key]}
              aria-describedby={help ? `${id}-help` : undefined}
              spellCheck={false}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => ({ ...d, [f.key]: value }));
              }}
            />
          </div>;
        })}
      </div>
      <div className="row-wrap">
        <button className="button primary" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save criteria"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={saving}
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              return;
            }
            setDraft(criteriaText(defaultFitCriteria));
            void save({ ...defaultFitCriteria, version: current.version }, "Scan fit criteria reset to defaults");
          }}
          onBlur={() => setConfirmReset(false)}
        >
          <RotateCcw size={14} aria-hidden="true" /> {confirmReset ? "Confirm reset to defaults" : "Reset to defaults"}
        </button>
      </div>
    </form>
  );
}

export function Settings({ state, mutate, go, notify, maintenance }: { state: AppState; mutate: Mutate; go: Go; notify: Notify; maintenance: MaintenanceProps }) {
  return (
    <div className="settings-layout">
      <SettingsNav sections={settingsSections} />
      <div className="settings-sections">
        <CodexModels state={state} mutate={mutate} notify={notify} />
        <div id="settings-gmail" className="settings-section settings-gmail" tabIndex={-1} aria-label="Gmail">
          <GmailReplies state={state} page="settings" go={go} />
        </div>
        <SettingsSection id="settings-automatic-refresh" title="Automatic refresh" icon={<Timer size={18} aria-hidden="true" />}>
          <RefreshSchedules
            key={JSON.stringify(scheduleKeys.map((k) => [savedSchedules(state)[k].enabled, savedSchedules(state)[k].intervalHours]))}
            state={state}
            mutate={mutate}
            notify={notify}
          />
        </SettingsSection>
        <PreparationSettings state={state} mutate={mutate} notify={notify} />
        <GreenhousePacing state={state} mutate={mutate} notify={notify} />
        <Tunables state={state} mutate={mutate} notify={notify} />
        <SettingsSection
          id="settings-fit-criteria"
          title="Scan fit criteria"
          help={<InfoTooltip label="About scan fit criteria">Controls which careers-scan postings become candidates. Title exclusions also screen newly discovered Greenhouse pull cards. Enter one term per line. Terms match whole words without regard to case; a space also matches a hyphen or no space. Changes apply to the next careers scan.</InfoTooltip>}
          icon={<Filter size={18} aria-hidden="true" />}
        >
          <FitCriteriaForm key={JSON.stringify(savedCriteria(state))} state={state} mutate={mutate} notify={notify} />
        </SettingsSection>
        <AppearanceSettings />
        <SettingsSection id="settings-workspace" title="Workspace" icon={<Wrench size={18} aria-hidden="true" />}>
          <div className="panel-body settings-tools">
            <Maintenance {...maintenance} />
            <section className="settings-tool" aria-labelledby="backup-heading">
              <div className="heading-help">
                <h3 id="backup-heading"><ShieldCheck size={15} aria-hidden="true" /> Backup &amp; portability</h3>
                <InfoTooltip label="About workspace backups">Exports durable personal workflow records, metadata and immutable application packages. Keep repository sources alongside the backup.</InfoTooltip>
              </div>
              <p className="small muted">The export contains private notes and application documents; store it with your private backups.</p>
              <Source path="README.md" />
              <a className="button secondary" href="/api/backup" download>
                <ArrowDownToLine size={15} aria-hidden="true" /> Download private workspace backup
              </a>
            </section>
          </div>
        </SettingsSection>
        <SettingsSection id="settings-records" title="Records & activity" collapsible
          help={<InfoTooltip label="About records and activity">Browse saved records and their associated data, or search workflow activity. Sizes measure stored record JSON only, not attached files or reclaimable space. Deleting activity removes journal entries only, not the records they describe.</InfoTooltip>}
          icon={<History size={18} aria-hidden="true" />}>
          <RecordsActivity go={go} settings={state.settings} />
        </SettingsSection>
        <SettingsSection id="settings-privacy" title="Privacy & access" icon={<Lock size={18} aria-hidden="true" />}>
          <div className="panel-body settings-facts">
            <Field label="Workspace access">
              Private to your Fieldwork sign-in
            </Field>
            <Field label="Network">
              Private cloud backend; Mac companion for local capabilities; no telemetry
            </Field>
            <Field label="Data ownership">
              Research files own imported facts. The application owns your notes,
              workflow and sent-package history.
            </Field>
            <Field label="Agent credentials">
              Agent tasks use the server’s existing Codex and Claude Code sign-ins; the app stores no API keys
            </Field>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplicationFollowUpSummary,
  FollowUpDraft,
  FollowUpTextFields,
  FollowUpView,
} from "../../shared/follow-up-email";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";

export type FollowUpAction =
  | "draft"
  | "save"
  | "revise"
  | "restore"
  | "send"
  | "test"
  | "resolve"
  | "authorize";

const fieldsOf = (draft?: FollowUpDraft): FollowUpTextFields => ({
  to: draft?.to ?? "",
  subject: draft?.subject ?? "",
  body: draft?.body ?? "",
});
const sameFields = (a: FollowUpTextFields, b: FollowUpTextFields) =>
  a.to === b.to && a.subject === b.subject && a.body === b.body;

/** The newer of the state snapshot and the last response; versions only grow. */
const latest = (
  a: ApplicationFollowUpSummary | undefined,
  b: ApplicationFollowUpSummary | undefined,
) => (!a ? b : !b ? a : b.version > a.version ? b : a);

/**
 * The text box. It is dirty whenever it differs from the current saved draft,
 * so saving and sending always act on exactly what is shown. A box the user has
 * not touched follows a newly arrived draft; touched text is never replaced.
 */
function useDraftFields(draft: FollowUpDraft | undefined) {
  const [edit, setEdit] = useState(() => ({ base: draft, fields: fieldsOf(draft) }));
  useEffect(() => {
    if (draft?.id === edit.base?.id) return;
    if (sameFields(edit.fields, fieldsOf(edit.base))) setEdit({ base: draft, fields: fieldsOf(draft) });
  }, [draft?.id]);
  return {
    fields: edit.fields,
    dirty: !!draft && !sameFields(edit.fields, fieldsOf(draft)),
    reset: (next: FollowUpDraft | undefined) => setEdit({ base: next, fields: fieldsOf(next) }),
    setField: (key: keyof FollowUpTextFields, value: string) =>
      setEdit((current) => ({ ...current, fields: { ...current.fields, [key]: value } })),
  };
}

type FollowUpRunner = (
  action: FollowUpAction,
  path: string,
  body?: unknown,
  method?: string,
) => Promise<FollowUpView | undefined>;


async function sendFollowUp(
  testTo: string | undefined,
  save: () => Promise<ApplicationFollowUpSummary | undefined>,
  run: FollowUpRunner,
) {
  const current = await save();
  if (!current?.draft) return undefined;
  return run(testTo === undefined ? "send" : "test", "/send", {
    expectedVersion: current.version,
    draftId: current.draft.id,
    ...(testTo === undefined ? {} : { testTo }),
  });
}

export function useFollowUpEmail(applicationId: string, fromState: ApplicationFollowUpSummary | undefined) {
  const [view, setView] = useState<FollowUpView>();
  const [busy, setBusy] = useState<FollowUpAction | "">("");
  const [error, setError] = useState("");
  const followUp = latest(fromState, view?.followUp);
  const box = useDraftFields(followUp?.draft);
  const shown = useRef(applicationId);
  const url = `${entityUrl("/api/applications", applicationId)}/follow-up`;

  const load = useCallback(async () => {
    try {
      setView(await api<FollowUpView>(url));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [url]);
  useEffect(() => {
    shown.current = applicationId;
    void load();
  }, [load, applicationId, fromState?.version]);

  const run = async (action: FollowUpAction, path: string, body?: unknown, method?: string) => {
    setBusy(action);
    setError("");
    try {
      const result = await api<FollowUpView>(`${url}${path}`, body, method);
      if (shown.current === applicationId) setView(result);
      return result;
    } catch (cause) {
      setError((cause as Error).message);
      return undefined;
    } finally {
      setBusy("");
    }
  };
  /** Saves the box when it differs from the saved draft; resolves to the record to act on, or undefined on failure. */
  const save = async () => {
    if (!followUp || !box.dirty) return followUp;
    const result = await run("save", "", { expectedVersion: followUp.version, ...box.fields }, "PUT");
    if (result?.followUp.draft) box.reset(result.followUp.draft);
    return result?.followUp;
  };
  return {
    followUp,
    history: view?.history ?? [],
    capability: view?.capability,
    busy,
    error,
    fields: box.fields,
    dirty: box.dirty,
    setField: box.setField,
    discard: () => box.reset(followUp?.draft),
    draft: () => run("draft", "/draft", {}),
    save,
    revise: async (instruction: string) => {
      if (!followUp) return undefined;
      const result = await run("revise", "/revise", { expectedVersion: followUp.version, instruction, ...box.fields });
      if (result?.followUp.draft) box.reset(result.followUp.draft);
      return result;
    },
    restore: (draftId: string) => followUp && run("restore", "/restore", { expectedVersion: followUp.version, draftId }),
    send: (testTo?: string) => sendFollowUp(testTo, save, run),
    resolve: (outcome: "sent" | "not-sent") =>
      followUp && run("resolve", "/sending/resolve", { expectedVersion: followUp.version, outcome }),
    /** Unsaved text is saved first; Google's consent page replaces this page. */
    authorize: async () => {
      if (box.dirty && !(await save())) return;
      setBusy("authorize");
      setError("");
      try {
        location.assign((await api<{ url: string }>("/api/gmail/connect", { returnTo: location.hash })).url);
      } catch (cause) {
        setError((cause as Error).message);
        setBusy("");
      }
    },
  };
}
export type FollowUpEmailState = ReturnType<typeof useFollowUpEmail>;

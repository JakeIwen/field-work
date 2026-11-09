import { tunables } from "../../../shared/tunables";
import { useEffect, useState } from "react";
import type { AutofillActivity } from "../../../shared/greenhouse-autofill";
import { api } from "../../workspace/api";
import { useVisiblePoll } from "../../workspace/useVisiblePoll";

export function useAutofillActivity(endpoint: string, enabled: boolean, clientActive: boolean, refreshKey?: string, pollMs: number = tunables["browser.autofillPollMs"].default) {
  const [activity, setActivity] = useState<AutofillActivity | null>(null);
  useEffect(() => { setActivity(null); }, [clientActive, enabled, endpoint, refreshKey]);
  useVisiblePoll<AutofillActivity>({
    enabled, intervalMs: pollMs, continueInitially: clientActive, deps: [endpoint, refreshKey, pollMs],
    poll: async signal => {
      const response = await api(`${endpoint}/status`, undefined, undefined, { responseType: 'response', signal });
      if (!response.ok) throw new Error('Background status unavailable');
      return response.json();
    },
    onResult: status => { setActivity(status); return status.running || clientActive; },
    onError: () => setActivity(null),
  });
  return activity;
}

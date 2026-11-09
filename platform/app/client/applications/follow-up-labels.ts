import {
  followUpDraftSourceLabels,
  type FollowUpDraft,
} from "../../shared/follow-up-email";

export const followUpDraftLabel = (draft: FollowUpDraft) =>
  followUpDraftSourceLabels[draft.source];

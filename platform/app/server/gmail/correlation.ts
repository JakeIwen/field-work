import type { Application, Opening } from "../../shared/types.js";
import type { GmailMessage } from "./api.js";
import {
  classifyPositiveReply,
  isGmailBulkNoise,
  isGmailReceipt,
} from "./positive.js";

export const normalizedGmailText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const containsGmailPhrase = (text: string, phrase: string) =>
  normalizedGmailText(phrase).length >= 3 &&
  ` ${normalizedGmailText(text)} `.includes(` ${normalizedGmailText(phrase)} `);

export function gmailSenderAddress(sender: string) {
  return (
    sender.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ??
    sender.match(/[^\s<>]+@[^\s<>]+/)?.[0] ??
    ""
  ).toLowerCase();
}

export function gmailExactContact(application: Application, sender: string) {
  const addresses: string[] =
    application.contacts
      .toLowerCase()
      .match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  return addresses.includes(sender);
}

function applicationIdentity(
  application: Application,
  openings: Map<string, Opening>,
) {
  const opening = openings.get(application.openingId);
  return {
    company: opening?.company ?? application.company ?? "",
    title: opening?.title ?? application.title ?? "",
  };
}

export function gmailContextApplicationIds(
  message: GmailMessage,
  account: string,
  applications: Application[],
  openings: Opening[],
) {
  const sender = gmailSenderAddress(message.sender);
  if (!sender || sender === account.toLowerCase()) return [];
  const text = `${message.sender}\n${message.subject}\n${message.text}`;
  const byId = new Map(openings.map((opening) => [opening.id, opening]));
  return applications.flatMap((application) => {
    const { company, title } = applicationIdentity(application, byId);
    const explicitPair =
      containsGmailPhrase(text, company) && containsGmailPhrase(text, title);
    return explicitPair || gmailExactContact(application, sender)
      ? [application.id]
      : [];
  });
}

export function needsGmailThreadContext(message: GmailMessage) {
  if (!message.authenticated) return false;
  const sender = gmailSenderAddress(message.sender);
  if (!sender || /^(?:mailer-daemon|postmaster)@/i.test(sender)) return false;
  const current = message.text.split(/\n(?:On .{3,200}wrote:|From:\s)/i)[0];
  const text = `${message.subject}\n${current}`;
  return (
    !!classifyPositiveReply(text) &&
    !isGmailBulkNoise(text) &&
    !isGmailReceipt(current)
  );
}

export function gmailApplicationIdentity(
  application: Application,
  openings: Map<string, Opening>,
) {
  return applicationIdentity(application, openings);
}

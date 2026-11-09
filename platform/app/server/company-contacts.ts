import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "./storage.js";
import type { Company, CompanyContact } from "../shared/types.js";
import { postingUrl } from "./job-posting.js";

export function companyContact(store: Store, company: Company) {
  const saved = store.get("company_contact", company.id);
  if (saved?.contactInfo) return saved;
  const url =
    company.fields?.["Official site"] || company.fields?.["Careers URL"];
  try {
    return {
      companyId: company.id,
      contactInfo: postingUrl(url).href,
      contactType: "url",
      sourceUrl: postingUrl(url).href,
      checkedAt: null,
      notes:
        "Company website fallback; a postal address has not been established.",
    };
  } catch {
    return null;
  }
}

// Research is separate from the source-owned company assessments and survives reindex.
export function importCompanyContacts(store: Store) {
  const companies = [
    ...store.list("cache_company"),
    ...store.list("custom_company"),
  ];
  for (const file of [
    "company-contacts-first.json",
    "company-contacts-second.json",
  ]) {
    const source = path.join(store.root, "company_careers/research", file);
    if (!existsSync(source)) continue;
    let entries: CompanyContact[];
    try {
      entries = JSON.parse(readFileSync(source, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (
        (!companies.some((c) => c.id === entry.companyId) &&
          !store.openings().some((o) => o.company_id === entry.companyId)) ||
        typeof entry.contactInfo !== "string" ||
        !entry.contactInfo.trim() ||
        entry.contactInfo.length > 3000 ||
        !["address", "partial-address", "url"].includes(entry.contactType)
      )
        continue;
      try {
        postingUrl(entry.sourceUrl);
      } catch {
        continue;
      }
      const old = store.get("company_contact", entry.companyId);
      if (old?.checkedAt && old.checkedAt > (entry.checkedAt ?? "")) continue;
      store.put("company_contact", entry.companyId, {
        ...entry,
        researchPath: `company_careers/research/${file}`,
      });
    }
  }
  syncCompanyContacts(store);
}

export function syncCompanyContacts(store: Store) {
  // These fixed registry keys must remain literals rather than widening to arbitrary strings.
  for (const kind of ["cache_company", "custom_company"] as const) {
    for (const c of store.list(kind)) {
      const contact = companyContact(store, c);
      if (!contact) continue;
      if (!store.get("company_contact", c.id))
        store.put("company_contact", c.id, contact);
      store.put(kind, c.id, {
        ...c,
        contactInfo: contact.contactInfo,
        contact,
        fields: {
          ...c.fields,
          "Contact info": contact.contactInfo,
          "Contact source": contact.sourceUrl,
        },
      });
    }
  }
  // These fixed registry keys must remain literals rather than widening to arbitrary strings.
  for (const kind of ["cache_opening", "custom_opening"] as const) {
    for (const o of store.list(kind)) {
      const contact = store.get("company_contact", o.company_id);
      if (contact)
        store.put(kind, o.id, {
          ...o,
          contactInfo: contact.contactInfo,
          contact,
        });
    }
  }
  for (const a of store.list("application")) {
    const o = store.opening(a.openingId);
    if (o?.contactInfo)
      store.put("application", a.id, {
        ...a,
        employerContactInfo: o.contactInfo,
        employerContact: o.contact,
      });
  }
}

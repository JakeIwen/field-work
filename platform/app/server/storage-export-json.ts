import type { Store } from "./storage.js";
import {
  personalExportKinds,
  personalExportMetadata,
  personalExportRows,
} from "./storage-export-snapshot.js";
import type { PersonalExportKind } from "./storage-export-dirty.js";

/** Synchronous iteration retains snapshot semantics without hydrating all histories. */
export function* personalExportChunks(
  store: Pick<Store, "db">,
  kindChunks = (kind: PersonalExportKind): Iterable<string> =>
    personalExportKindChunks(store, kind),
): Generator<string> {
  const metadata = JSON.stringify(personalExportMetadata(), null, 2);
  yield metadata.slice(0, -2) + ',\n  "records": {';
  let kindSeparator = "\n";
  for (const kind of personalExportKinds) {
    yield kindSeparator;
    yield* kindChunks(kind);
    kindSeparator = ",\n";
  }
  yield "\n  }\n}";
}

/** Pretty-print each parsed row to preserve JSON.stringify's exact key/number rules. */
export function* personalExportKindChunks(
  store: Pick<Store, "db">,
  kind: PersonalExportKind,
): Generator<string> {
  yield `    ${JSON.stringify(kind)}: [`;
  let rowSeparator = "\n";
  let populated = false;
  for (const value of personalExportRows(store, kind)) {
    const json = JSON.stringify(value, null, 2);
    yield `${rowSeparator}      ${json.replace(/\n/g, "\n      ")}`;
    rowSeparator = ",\n";
    populated = true;
  }
  yield populated ? "\n    ]" : "]";
}

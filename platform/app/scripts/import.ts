import { repositoryRoot as root, dataDirectory } from "../server/paths.js";
import { Store } from "../server/storage.js";
import { importRepository } from "../server/importer.js";
const store = new Store(root, dataDirectory);
try {
  const data = await importRepository(root, undefined, () => store.settings());
  store.import(data);
  console.log(
    JSON.stringify(
      {
        companies: data.companies.length,
        retainedOpenings: data.openings.length,
        seenIdentities: data.scan.seenCount,
        failedCompanies: data.scan.failedCompanies,
        documents: data.documents.length,
        validSections: data.validSections,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}

# Revision bundle files and validation

The Agent workspace lists files in an isolated task directory, not the live source workspace. Labels compare artifact hashes with captured source hashes. Unchanged references, changed sources, PDFs, reports and revisions remain separate. Missing comparison metadata means “Not compared,” not “Unchanged.” None of these labels authorizes publication.

Validation chooses current artifacts in the bundle's target directory. Nested revisions and reports cannot supply missing current variants. General-master revisions maintain private/public variants; private-only tailored bundles validate only their required output. A private-only bundle's evidence dossier is read-only reference, whereas a general-master revision requires an appropriate evidence update.

Trusted Markdown/HTML and native PDF checks verify source synchronization, selectable text, contact links, privacy and page layout. Missing or ambiguous variants, unreadable PDFs, source conflicts and draft changes fail visibly. Resume and cover-letter validation have distinct layout requirements.

Validation never promotes documents. Only an eligible general-master revision can use explicit promotion, after final source and artifact checks. [Application preparation](application-preparation.md) publishes tailored output through its own guards.

Native validation requires the documented macOS tools. Offline fixtures and successful builds do not establish that native rendering or live agent execution works on a particular installation.

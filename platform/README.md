# Fieldwork platform

Fieldwork is a single-owner job-search workspace with a React client, Node/TypeScript backend, SQLite workflow records, immutable document objects and bounded AI-assisted tasks. This folder contains the application; it does not include a private workspace or credentials.

## Layout

- `app/client/`: feature-oriented React views, shared UI and client tests.
- `app/server/`: storage, workflow managers, adapters and HTTP routes.
- `app/shared/`: wire types, validators and shared rule vocabulary.
- `app/tests/`: isolated backend fixtures and behavior tests; `native/` contains macOS rendering tests.
- `app/scripts/`: application command entry points and verification tools.
- `scripts/`: test orchestration and architecture gates.
- `deploy/`: optional hosting and service tooling; configuration is operator-supplied.
- `docs/`: design and behavior documentation.

## Install and verify

Use a current Node runtime compatible with `package.json`. From this folder:

```sh
npm install
npm test
npm run build
npm run check
```

`npm test` is the fast offline tier. `npm run build` runs structure checks, TypeScript and the client build. `npm run check` is the complete offline gate, including native/release checks where supported. Native Swift/WebKit/PDF validation requires macOS; unsupported environments report their explicit limits. Browser and live-agent acceptance are separate, opt-in checks requiring their configured services or accounts.

## Local demo

Run `npm run demo` to start the local demo with a disposable synthetic sample workspace. It does not load private files, contact live employer forms or start paid agent sessions. Stop it with Ctrl+C.

## Development

The application separates code assets from the configured source workspace and data directory. Keep credentials, personal profiles, generated artifacts and backups out of source control. Development clients use their selected backend; connecting to a live companion is not a sandbox. Use disposable fixture data for mutating tests.

Start with [architecture](docs/architecture.md), [Opening workflow](docs/opening-workflow.md), [application preparation](docs/application-preparation.md), [security](docs/security.md) and [deployment tooling](deploy/README.md). These describe intended behavior and boundaries, not live verification of this public snapshot. No historical screenshots or real record catalogs are included.

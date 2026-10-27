# Stack: water-management

Integrated Catchment - Water Balance Tool (IC-WBT; issue #551 renamed it
from Water Management, and the repo, packages, databases and AWS resources
keep the `water-management` slug) is a multi-project web app for daily
catchment water-balance modelling. It is a
port of the WBT b023 Excel tool (see [model.md](./model.md)). There is a static
SvelteKit frontend, a Hono API (a Node server locally, Lambda in production),
Postgres with row-level security, and one TypeScript model engine that both
sides share.

## Stack

- **packages/engine**: `@water-management/engine`. Pure TypeScript model
  (`runModel`) and shared types (`src/project.ts`). No I/O. Tested with vitest,
  three projects: `unit` and `fuzz` (the random-network soak's shards, run
  after `unit`; both in `pnpm test`) and `perf` (`*.perf.test.ts`, wall-clock
  budgets, `pnpm test:engine:perf` — median of several runs, run serially and alone,
  not part of `pnpm test`/CI since a loaded machine trips a hard budget).
  Imported as source by frontend and backend.
- **backend/**: Hono on Node (`tsx watch`, port `3001`) and AWS Lambda (Function
  URL, esbuild bundle). Uses `pg`, `zod`, `jose` (session JWT), `node:crypto`'s Argon2id for passwords (`bcryptjs` only to check older hashes),
  and for email `nodemailer` (SMTP → Mailpit locally) / `@aws-sdk/client-sesv2`
  (SES in production), picked by `MAIL_TRANSPORT`. Background jobs
  (`src/jobs/`) queue in a Postgres `job` table; a local worker process runs
  them (`JOB_TRANSPORT=inprocess`), and in production a worker Lambda woken
  through SQS (`@aws-sdk/client-sqs`) and a 5-minute schedule. Data feeds
  (`src/feeds/`: CHIRPS, CHIRPS-GEFS, DWS) run on that queue, reading
  synthetic fixtures (`fixtures/feeds/`, `FEED_SOURCE=fixtures`, the
  default; `FEED_FIXTURE_REWRITE=1` serves some finals rewritten in place, to
  watch the re-check of cached CHIRPS finals, architecture.md § Data feeds)
  everywhere but the production fetcher Lambda. Server-side report
  PDFs (`src/reports/`) print the report route in headless Chromium
  (`playwright-core`, the browser e2e installs) and store the PDF through
  `@aws-sdk/client-s3` (MinIO locally, `STORAGE=local`; a private S3 bucket in
  production, where a container-image renderer Lambda does the printing).
  Dam observations (`src/dams/observed/`, issue #604 R5): the tick matches
  traced dams to DE Africa Waterbodies polygons and loads what the fetcher's
  hourly `dams-weekly` passes wrote to the mirror bucket: the Waterbodies
  series, and WOfS summed inside each traced outline (`src/dams/observed/wofs/`;
  with `FEED_SOURCE=fixtures`, the synthetic series under `fixtures/waterbodies/`
  and the synthetic WOfS scenes of `fixtures/feeds/wofs-sample.json`); off unless
  `DAM_OBSERVATIONS=on`; architecture.md § Dam observations).
  Alert emails (`src/alerts/`) are evaluated by an `alert_eval` job and sent
  by the tick, each built as its recipient under RLS (Mailpit locally;
  `ALERTS_ENABLED=false` is the kill switch).
  Catchment delineation from a click on the Map (`src/delineation/`) reads a
  Terrarium DEM (PMTiles, its own WebP/PNG decoders, no dependency) named by
  `DEM_URL`: empty (the default) is off; the committed synthetic DEM
  (`backend/fixtures/dem/`) or the Relief's DEM after `pnpm dev:tiles:terrain`
  ([maps.md § Delineation](./maps.md#delineation)); the same routing divides
  a catchment into units at the map's dams, abstraction points and gauges to
  start an empty model, or to divide one that has nodes (`start.ts`,
  `divide.ts`, `subcatchments.ts`,
  [maps.md § Start from the map](./maps.md#start-from-the-map)).
  Tracing a dam (`src/delineation/damTrace.ts`) reads a water occurrence
  raster through the same readers, named by `WATER_URL`: empty (the default)
  is off; the committed synthetic raster (`backend/fixtures/water/`) or JRC
  Global Surface Water after `pnpm dev:tiles:water` ([maps.md § Assisted
  drawing](./maps.md#assisted-drawing)).
  The rain data copy (`src/mirror/`, issue #604, in progress) reads and
  writes Zarr v3 arrays with `zarrita` 0.7.5 and `@zarrita/storage` 0.2.0
  (exact pins; a `node:zlib` gzip codec for writing) from `MIRROR_URL`
  (`file://` or `s3://`, the latter through `@aws-sdk/client-s3`); the
  committed synthetic copy is `backend/fixtures/mirror/` (`pnpm
  gen:mirror-fixture`; [architecture.md § Data feeds](./architecture.md#data-feeds)).
  Plain SQL migrations live in `backend/migrations/`, run by
  `backend/scripts/migrate.ts`. vitest has four projects: `unit` (no DB),
  `db` (needs Postgres), `perf` (same wall-clock-budget caveat as the
  engine's) and `perf-db` (wall-clock budgets against Postgres,
  `*.db.perf.test.ts`, with the db project's global setup; the portfolio
  query's, the RLS role check's, the Step 2 60-farm load checks, the
  Map search over 150 000 gazetteer places and reading 5,000 allocations).
- **frontend/**: SvelteKit 3 (Svelte 5) **SPA** (`adapter-static` with a fallback
  `index.html`; `ssr = false`, `prerender = false`, except the public landing
  page at `/welcome` and `/welcome/af`, prerendered once per language, architecture.md), Vite, TypeScript, uPlot
  charts, vitest. SvelteKit's config is the `sveltekit({…})` call in
  `vite.config.ts` (the Svelte options in `svelte-options.js`); `#lib/…` is a
  `package.json` `imports` subpath with the file's extension (`#lib/api/index.js`);
  public env vars are declared in `src/env.ts` and read from `$app/env/public`;
  links use `resolve()`/`asset()` from `$app/paths`, and `basePath()`
  (`lib/nav/base.ts`) where code needs the prefix itself. The Map tab draws with MapLibre GL (`maplibre-gl`, BSD-3) and
  reads its self-hosted PMTiles basemap with `pmtiles`, both dynamic imports
  that load only when the map is drawn ([maps.md](./maps.md)). No spreadsheet library ships: the `.xlsx` run export
  writes its own OOXML (`lib/spreadsheet/export/writer.ts`) and the b023
  import reads workbooks with its own streaming reader
  (`lib/spreadsheet/import/`). SheetJS CE 0.20.3 (`xlsx`, Apache-2.0) is a
  dev dependency the tests check both against (`writer.test.ts` fails if app
  code imports it), pinned as a URL dependency on its official CDN tarball
  (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, integrity hash in
  `pnpm-lock.yaml`). Dependabot can't see a URL dependency, so bump it by hand. OSV can't read its version either, so `osv-scanner.toml` records the xlsx advisories 0.20.3 already fixes (with an expiry): update it with the pin. Dev port `7777`. `frontend/.env.production` sets
  `PUBLIC_API_URL=/api`.
- **e2e/**: Playwright, fully local. It uses an isolated
  `water_e2e` database and its own servers on `:3101` (API) and `:7801` (site),
  so it never collides with `pnpm dev`; a git worktree gets its own slot
  (ports, from a registry in the shared `.git`) and database
  (`e2e/support/env.ts`), so two checkouts can run it at once. The site is a production build (`frontend/build-e2e/`, API URL baked
  in), not the Vite dev server. CI runs it as 14 shards on one shared build
  ([e2e/README.md](../e2e/README.md)).
- **Mailpit**: docker-compose, catches all local email (SMTP **1026**, inbox
  http://localhost:8026, `pnpm dev:mail:up`); the e2e specs that read real
  emails (alerts, server reports, a second-factor reset) need it.
- **MinIO**: docker-compose, S3-compatible storage for report PDFs and
  evidence packs' reproduction bundles (issuing a pack needs it; API
  **9002**, console http://localhost:9003, `pnpm dev:s3:up`; the community
  fork's image, since upstream stopped publishing one).
- **Postgres 17**: docker-compose, port **5434**. User/DB `water` owns the
  schema and runs migrations. The backend connects as `water_app`, which is
  bound by RLS. Each checkout has its own dev database: `water` in the main
  checkout, `water_w<tag>` in a git worktree (`<tag>`: 16 hex digits from its path, `backend/src/config/devEnv.ts`,
  created on first `pnpm dev`, empty until `pnpm seed:examples`), so a
  branch's unmerged migrations never reach main's. The `water_test` database is for DB tests (a git worktree uses its own `water_test_w<tag>`, `backend/src/__tests__/test-db.ts`, so worktrees can run them at once; [testing.md § Several checkouts at once](./testing.md#several-checkouts-at-once)).
- **scripts/wbt-import/**: Python 3.14 + openpyxl. Extracts a b023 workbook into
  `data/…/project.json` and regression fixtures. Output is gitignored, except
  the synthetic workbook fixture for the importer parity test and the
  string-decoding fixture that pins the reader to openpyxl
  (`scripts/wbt-import/fixtures/`, invented data).
- **ingest/**: the bulk ingest job (issue #604), Python 3.14 as an arm64
  container-image Lambda (`ingest/Dockerfile`, AWS's Lambda Python base pinned
  by digest; handler `lambda_handler.handler`). It copies CHC's CHIRPS NetCDF
  (read with xarray + h5netcdf/h5py; no netCDF4, no GDAL) into our own Zarr v3
  copy (zarr 3; `MIRROR_URL`: `file://…` locally, `s3://…` in production,
  written through boto3) with a `manifest.json` per product, through one
  polite HTTP client (stdlib `urllib`: a descriptive User-Agent with
  `INGEST_CONTACT`, conditional GETs, 1 request a second, `Retry-After`, and a
  403 that stops the run). Dependencies hash-pinned in
  `ingest/requirements.txt`. `FEED_SOURCE=fixtures` reads a committed
  synthetic NetCDF (`ingest/fixtures/`) and needs no network. Optional
  locally (`pnpm dev:ingest:run`); pnpm dev, the other CI jobs and e2e never
  need Python ([ingest/README.md](../ingest/README.md)).
- **infra/**: Terraform: S3 + CloudFront (+ `/api/*` → Lambda) + WAF + Lambda
  (API, plus a migrate Lambda, `backend/src/lambda-migrate.ts`, and the job
  worker, `backend/src/lambda-worker.ts`, with its SQS queue + DLQ and
  EventBridge tick, and the data feeds' fetcher, `backend/src/lambda-fetcher.ts`,
  outside the VPC with its two queues, and the report renderer,
  `backend/src/lambda-renderer.ts`, a container image in ECR, outside the VPC,
  with its two queues and a private reports bucket) + the map's tiles bucket
  (`/tiles/*`) and private reference bucket, which the migrate Lambda loads
  the allowed reference datasets from (`load-reference.yml`) + RDS Postgres 17
  in a private VPC + SES + Route 53 + ACM + budget/alarms. Deployed 2026-10-05, minimal tier
  ([deployment.md](./deployment.md), [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws)).

pnpm monorepo with four workspaces (`frontend`, `backend`, `packages/*`, `e2e`).
Node 24 (`.tool-versions`), pnpm 10 (`packageManager: pnpm@10.33.2`).

## Commands (run from repo root)

```bash
pnpm setup                  # install, start Postgres, apply migrations, load the synthetic reference data (quaternaries, gauging stations, register of dams, land cover, orchards and vines, evaporation, MAP grid, gazetteer, Waterbodies polygons), start Mailpit and MinIO (one-time)
pnpm dev                    # frontend :7777 + backend :3001 (starts Postgres first via dev:db:up; the backend applies pending migrations)
pnpm dev:full               # dev + the background-job worker (opt-in; JOB_TRANSPORT=inprocess, Postgres only; also starts Postgres)
pnpm dev:all                # everything: Mailpit, MinIO + the map's basemap if cached (never fetched), then dev:full
pnpm dev:down               # after Ctrl+C: stop every container (Postgres, Mailpit, MinIO; data stays)
pnpm dev:run:frontend       # one side only
pnpm dev:run:backend
pnpm dev:run:worker         # the job worker alone: polls every 15 s and on LISTEN job_queued
pnpm dev:jobs:tick          # run every due job once and exit
pnpm dev:feeds:run          # fetch every enabled data feed once (fixtures by default, no network) and exit
pnpm dev:dams:run           # dam observations once: match traced dams, both passes, Waterbodies and WOfS (fixtures by default, no network), load (run-locally.md § Dam observations)
pnpm dev:ingest:push        # push the synthetic logger CSV to /ingest with the API key in WM_INGEST_KEY (run-locally.md § Ingest)
pnpm dev:ingest:run [rnl|sat|era5l|imerg_late]  # the bulk ingest Lambda once in fixtures mode: synthetic files and fake upstreams → local Zarr copy in ingest/.mirror (Python 3.14; makes ingest/.venv on first use; ingest/README.md)

pnpm dev:db:up              # Postgres 17 in docker on :5434
pnpm dev:db:down
pnpm dev:db:status | dev:db:logs
pnpm dev:db:migrate         # apply backend/migrations as `water`
pnpm dev:db:reset           # drop the volume, recreate, migrate (destroys local data)
pnpm dev:db:psql            # psql as the schema owner
pnpm dev:authority:confirm <project-id> <email> --reference "<letter>"   # the operator confirms who acts for a project's responsible authority (the first one is the operator's; security.md § Authorization)
pnpm dev:mail:up            # Mailpit: local inbox for all app email (UI :8026)
pnpm dev:mail:down | dev:mail:status | dev:mail:logs | dev:mail:open
pnpm dev:mail:bounce <email> [--complaint | --transient]   # stand in for an SES bounce: pauses that account's alert emails (run-locally.md § Alerts)
pnpm dev:s3:up              # MinIO: report PDFs (API :9002, console :9003, minioadmin / minioadmin)
pnpm dev:s3:down | dev:s3:status | dev:s3:logs
pnpm dev:tiles:up           # optional basemap for the Map tab, one step, re-runnable: MinIO, tiles + fonts (cached, else fetched), a cached relief DEM, the frontend's URLs; restart pnpm dev
pnpm dev:tiles:fetch        # re-download the SA extract (pmtiles CLI) into MinIO; dev:tiles:terrain (the Relief layer's DEM) | dev:tiles:water (Trace a dam's GSW occurrence; GDAL or docker) | dev:tiles:status | dev:tiles:env (maps.md)

pnpm build                  # all workspaces (frontend/build, backend/dist/lambda.mjs)
pnpm build:frontend | build:backend
pnpm check                  # typecheck all workspaces; the frontend's svelte-check fails on any warning (--fail-on-warnings, a11y lint included; testing.md)
pnpm test:changed           # the fast loop: typecheck + only the tests your change reaches (docs/testing.md)
pnpm test                   # unit tests everywhere (no DB, no wall-clock assertions)
pnpm test:engine | test:frontend | test:backend   # test:backend includes the route-auth inventory
pnpm test:backend:db        # API + RLS tests, catalogue guards (water_test; needs dev:db:up)
pnpm test:coverage          # unit tests with v8 coverage, then a table of what no test reaches (a report, not a gate; testing.md § Coverage)
pnpm test:backend:db:coverage  # the same for the DB tests (needs dev:db:up; the weekly Coverage workflow runs both)
pnpm test:engine:perf       # engine wall-clock budgets (median of 7, serial); run alone, not in CI/pnpm test
pnpm test:backend:perf      # backend wall-clock budgets and the V8 deopt stress run of the assurance of supply (issue #192; same caveat)
pnpm test:backend:perf:db   # backend budgets against Postgres (portfolio: 10 × 60 farms < 500 ms; the no-user role check; 60-farm runs < 10 s; map search over 150 000 places < 40 ms, through its index; ~4 min); needs dev:db:up, alone, never beside test:backend:db
pnpm test:backend:v8-osr    # does this Node still miscompile the pre-fix assurance loop (issue #232)? [--rev <rev>] [--node <bin>] [-- <V8 flags>]; alone, minutes, not in CI
pnpm test:e2e               # Playwright, incl. the new-catchment golden path (first run: test:e2e:install; also test:e2e:ui, check:e2e; server-report.spec.ts needs dev:s3:up + dev:mail:up, alerts-mailpit.spec.ts and mfa-email-mailpit.spec.ts dev:mail:up)

pnpm import:quaternaries    # load the synthetic quaternary dataset the Map's lookup proposes from (pnpm setup runs it);
                             # <boundaries.geojson> --dataset <label> --source "<study>" [--values <csv>] loads your own DWS/WR2012 download (maps.md)
pnpm import:dam-register    # load the synthetic register of dams the Dams page's proposals read (pnpm setup runs it);
                             # <list.csv> <overlay.kml> --dataset <label> --source "<list, edition>" loads your own DSO download, once its licence allows (maps.md § Sources)
pnpm import:rivers          # load the synthetic river network the Map's River network layer draws and proposes rivers from (pnpm setup runs it);
                             # pnpm dev:tiles:rivers fetches HydroRIVERS (GDAL's ogr2ogr) and loads it (maps.md § River network)
pnpm import:land-cover      # load the synthetic cropland grid a unit's planted-areas drawer proposes from (pnpm setup runs it);
                             # <tile.tif> … --dataset <label> [--cell 0.0025] [--bbox w,s,e,n] loads your own ESA WorldCover tiles (maps.md § Cultivated area from land cover)
pnpm import:crop-types      # load the synthetic orchard and vine grid the planted-areas drawer shows beside the land cover (pnpm setup runs it);
                             # <current.tif> --dataset <label> [--baseline <earlier.tif> --baseline-version <name>] loads your own SANLC, warped to EPSG:4326
                             # (its terms are pending: local evaluation only, production refuses it; maps.md § Orchards and vines from SANLC)
pnpm import:evaporation     # load the synthetic evaporation grid Calibration → Evaporation from the map proposes from (pnpm setup runs it);
                             # <file> … --dataset <label> [--bbox w,s,e,n] loads dPET years (.nc, or the totals --reduce <dir> wrote) as monthly means;
                             # [--out <grid.json[.gz]>] writes them for a production load instead (deployment.md § Reference datasets)
pnpm import:evaporation:fetch [first] [last]  # download dPET (CC BY 4.0, ~2.4 GB a year, deleted once reduced) and load it (maps.md § Evaporation from the map)
pnpm import:map-grid        # load the synthetic MAP grid the Map tab's MAP grid layer draws (pnpm setup runs it);
                             # <grid.asc> --dataset <label> --source "<product, author, year>" [--bbox w,s,e,n] loads your own ESRI ASCII grid
                             # in WGS84 degrees; [--out <grid.json[.gz]>] writes it for a production load instead, which takes only the
                             # Southwestern Cape surface (WAAS-SWCape-2007; Lynch and the rest refused; maps.md § MAP grid)
pnpm import:gazetteer       # load the synthetic place names the Map's search finds after its own layers (pnpm setup runs it);
                             # <ZA.txt[.gz]> [<BW.txt[.gz]> …] --dataset <label> [--source "<attribution>"] loads GeoNames' dumps of South Africa and its
                             # neighbours (BW, LS, MZ, NA, SZ, ZW; theirs inside the basemap only), several files as one dataset (CC BY 4.0; maps.md § Gazetteer)
pnpm import:dws <file> --reference "<reply>"   # load a DWS daily flow table (DWS's reply to a data request; --source upload for any other) into the
                             # gauge record store DWS feeds read with DWS_SOURCE=store, as the schema owner; [--station A2H012] [--from … --to …]
                             # (backend/fixtures/dws/ holds an invented reply; deployment.md § DWS gauge records)
pnpm import:waterbodies     # load the synthetic DE Africa Waterbodies polygons the dam observations match traced dams to (pnpm setup runs it);
                             # <file.geojson> --dataset <label> [--bbox w,s,e,n] [--source "…"] loads your clip of the v0.0.3 historical extent (CC BY 4.0; maps.md § Waterbodies)
pnpm seed:examples          # 4 invented example catchments (Oranje: river abstractions) + the Showcase (every feature: runs, scenarios, map, allocations, evidence pack draft, notes, alerts; run-locally.md § The showcase; SEED_SHOWCASE=0 skips it) + the Licence comparison map (every band of the Allocations map, issue #510; skipped with the Showcase) + team + 2 demo users (demo@ / analyst@example.com) + 2 demo farmers (farmer1@ / farmer2@example.com) + a demo applicant (applicant@example.com), password demo-password
pnpm seed:demo              # seed:examples + each client workbook in ../project-water-management-source/Original/ (WBT_SOURCE_DIR), one project each (needs Python + openpyxl)
pnpm seed:demo:fixed        # the same from the fixed workbooks in ../project-water-management-source/Fixed/workbooks/, each as "<Name> (fixed)" (run-locally.md § Import the client catchment)
pnpm import:project <project.json> --email you@example.com [--name …] [--password …] [--run] [--skip-existing]
                             # [--settings <patch.json>] [--transfers <patch.json>] [--fit [--fit-seed n] [--fit-starts n] [--fit-budget n]]:
                             # patch the settings and transfer rules (by end-node names), fit GR4J before importing (model.md §2.10b)
pnpm pan-sensitivity <project.json> [--out <file.md>] [--seed <n>] [--starts <n>] [--budget <n>]
                             # GR4J at a few pan-coefficient choices, fixed vs refitted (no DB; refuses a monthly PE, settings.pe; model.md §2.4a)
pnpm fit-sweep <project.json> --grid <grid.json> [--out <file.md>] [--json <file.json>] [--seed <n>] [--starts <n>] [--budget <n>] [--max-cells <n>]
                             # one GR4J fit per cell of a grid (pan preset × bounds × objective × exclusion set × WR2012 band), with
                             # validation, MAR and EWR days, in one Markdown table; ranks nothing (no DB; ≤ 24 cells unless raised; model.md §2.10b)
pnpm list:ewr-rules <project.json> [--json]
                             # the rules that keep water for the EWR a project has switched on (dam pass inflow, unit or off-take
                             # hands-off flow, drought restriction EWR trigger; all off by default), from a Download project (JSON)
                             # export or the importer's project.json (no DB; run-locally.md § Which rules keep water for the EWR)
pnpm reproduce:pack <bundle.zip> [--expect <manifest hash>] [--no-run] [--json]
                             # check an evidence pack's reproduction bundle and re-run its runs offline; exit 0 when it reproduces
                             # (no DB, no network; scripts/reproduce-pack/, evidence-pack.md § Reproduction)
pnpm test:scripts           # guard: root scripts point at real targets
pnpm check:infra            # Terraform fmt + validate + plan-only tests (mocked providers, no AWS creds; runs in a private copy of infra/, so parallel runs are safe)

pnpm check:workflows        # workflow guard (SHA pins, OIDC-only, production gating incl. every id-token grant, a release preflight before every production-gated job, no PR-head checkout under pull_request_target, a draft skip only with ready_for_review, CI-gate fan-in, no auto-merge for actions, docker or backend/renderer-deps, no pnpm `version:` beside packageManager) + actionlint if installed
pnpm check:env              # committed env files point only at the local stack
pnpm check:claude           # the Claude agents, commands and skills cite only real paths and no template placeholders
pnpm check:bundle           # frontend gzip budget (after build:frontend); ceilings in scripts/guards/check_web_bundle_budget.mjs
pnpm gen:bundle-budget <slug> <kb> "<why>"  # raise the total ceiling: one new entry file in scripts/guards/bundle-budget/ (never edit BUDGET.totalCodeKb)
pnpm check:compliance       # advisory: privacy-doc drift vs origin/main
pnpm check:terms            # no client-identifying term in any tracked file (needs the terms list in ../infra-secrets; else a no-op)
pnpm check:migrations       # every migration this branch adds sorts after origin/main's highest (git fetch first; data-model.md § Migrations)
pnpm check:pins             # the Playwright pins agree (backend, e2e, the renderer image's tag and npm lock), and the renderer image's base digest and apt versions + snapshot are pinned, the ingest image's arm64 Lambda base by digest and its pip install by hash, bin/tiles-dev.sh's GDAL image and docker-compose.yml's images (Postgres, Mailpit, MinIO) by digest, and every URL tarball in pnpm-lock.yaml (SheetJS) by its integrity hash; bump them together as backend/renderer.Dockerfile's header says
pnpm check:renderer-image   # build the report renderer's container image and smoke-test it as Lambda runs it (docker; ~3.5 GB)
pnpm check:apt-snapshot     # how old the renderer image's apt snapshot (APT_SNAPSHOT) is; a weekly workflow opens an issue past 90 days
                             # check:pins also refuses any workflow `services:` image (serviceImageProblems): one is pulled from its registry on every run, which Docker Hub and ECR Public refused (issues #492, #521); CI starts docker-compose.yml's services through scripts/ci/service-image.sh, so a Dependabot compose bump moves CI with it
pnpm gen:renderer-apt [<id>] # move APT_SNAPSHOT (default today) and rewrite the pinned apt versions from it (docker); on every Dependabot docker PR
pnpm test:guards            # node:test suites for scripts/guards, scripts/release, scripts/ingest and infra/scripts
pnpm test:verify            # independent cross-check: a Python model from the docs vs runModel (examples, probes, random networks) + mutation self-test (verify/README.md; ~6 min)
pnpm test:ingest            # the bulk ingest job's unittest suite (ingest/, Python 3.14; seconds)
pnpm gen:dem-fixture        # rewrite the synthetic DEM delineation is tested against (backend/fixtures/dem/; no DB; maps.md § Delineation)
pnpm gen:water-fixture      # rewrite the synthetic water occurrence raster tracing a dam is tested against (backend/fixtures/water/; no DB; maps.md § Assisted drawing)
pnpm gen:waterbodies-fixture # rewrite the synthetic Waterbodies polygons and series round the Sandspruit dams (backend/fixtures/waterbodies/; no DB; maps.md § Waterbodies)
pnpm gen:mirror-fixture     # rewrite the synthetic rain data copy (backend/fixtures/mirror/: Zarr arrays + manifests from the synthetic CHIRPS files; no DB; architecture.md § Data feeds)
pnpm gen:example            # rewrite the example catchment the empty project list starts from (Kleinberg; no DB; issue #286)
pnpm gen:help-art           # re-render the help pictures, by day and at dusk for dark mode (optional: Blender 5 + ImageMagick 7; HELP_ART_ONLY, HELP_ART_LIGHT, HELP_ART_DEVICE; output is committed)
pnpm gen:landing-art        # regenerate the landing page's art, screens and figures (optional tooling; docs/design/landing-art.md)
pnpm gen:e2e:timings       # refresh e2e/shard-timings.json (CI's e2e shards are packed by it) from the newest green main run; needs gh (e2e/README.md § CI)
pnpm gen:liability          # regenerate the known limitations, the engine errata and the methodology hashes from engine-audit.md, engine-errata.md and docs/methodology/ (after changing any)
pnpm gen:i18n:sheet [lang…]        # rewrite a language's translation sheet (default: every non-English language in
                             # packages/engine/src/languages.ts); check:i18n checks every language
pnpm gen:i18n:stamp <lang> <id>    # re-stamp a farmer glossary translation from the current English, once the translator has re-checked it
pnpm gen:i18n:export <lang> <dir>  # a language's untranslated sheet rows as JSON batches (for the i18n-translator agent, .claude/agents/i18n/)
pnpm gen:i18n:apply <lang> <f.json …>  # write checked words (sheet Id → text; later files win) into that language's catalogues (creating one
                             # that doesn't exist yet) and rewrite its sheet
```

## Running tests

**While you work, run only what you touched** (CLAUDE.md rule 12). The
quick way is `pnpm test:changed`: typecheck plus `vitest --changed` for what
your working changes touch, DB tests included when Postgres is up, never e2e
([testing.md](./testing.md)). By hand:

```bash
pnpm test:changed                                             # typecheck + the vitest files your changes touch
pnpm check                                                    # typecheck (fast; always)
pnpm -C backend exec vitest run --project unit src/<area>     # backend unit files you changed
pnpm -C backend exec vitest run --project db src/<area>       # backend DB/RLS files (needs dev:db:up)
pnpm -C frontend exec vitest run src/lib/components/<area>    # frontend unit files
pnpm -C packages/engine exec vitest run src/<area>            # engine unit files
pnpm -C e2e e2e tests/<spec>.spec.ts                          # e2e specs for the screens you changed
pnpm build:frontend && pnpm check:bundle                      # only when you added or moved frontend code
```

Also run the guard for anything the change touches: `src/routes.test.ts`
for a new route, `src/db/catalogue.db.test.ts` for a migration,
`pnpm test:scripts` for root scripts.

**The full suite runs on GitHub Actions, not locally.** CI
(`.github/workflows/ci.yml`) runs on every push to `main` and every PR: unit
tests, `test:backend:db`, the guards, the bundle budget, and e2e as 14
parallel shards on one shared build. Locally, before a commit, run
`pnpm check && pnpm test` plus the DB test files and e2e specs for what you
touched. Don't run the full `pnpm test:backend:db` or `pnpm test:e2e`
locally, and never run the suites one after another; if you do need more
than one locally, their parts are independent (unit tests use no database;
the DB tests use this checkout's `water_test…`; e2e uses its own
`water_e2e…` database and ports, `e2e/support/env.ts`; testing.md §
Several checkouts at once), so start them as
background commands in parallel. Run `pnpm build:frontend && pnpm
check:bundle` when you added or moved frontend code. The DB project stays
serial *inside* itself (its queue and feed tests claim jobs globally;
`backend/vitest.config.ts` pins it to one worker, `maxWorkers: 1`). The perf projects
(`test:*:perf`) run alone, never alongside anything, since they assert
wall-clock budgets.

Don't pipe `pnpm test:e2e` into `grep`, `head` or `tail`: Playwright's web
servers keep the pipe open after the tests finish, so the command hangs
until something kills it. Redirect to a file (`> e2e.log 2>&1`) and read that.

Releases: `gh release create backend@X.Y.Z` / `web@X.Y.Z --target main
--generate-notes` deploys that component after a preflight and the
`production` approval ([deployment.md § Releasing](./deployment.md#releasing)).

## First-time setup

Local dev needs **no env setup**. `backend/.env.development` and
`frontend/.env.development` are committed and hold only non-sensitive local
defaults (localhost URLs, the throwaway docker DB passwords, a dev-only JWT
secret). Needs Node 24, pnpm 10, and docker (with compose).

```bash
pnpm setup
pnpm dev
```

The walkthrough, including how to import the client catchment, is in
[run-locally.md](./run-locally.md). Personal overrides go in a gitignored
`<workspace>/.env.development.local`. Never edit the committed file for those.

Deploying (only when the client is ready for it) is covered in
[deployment.md](./deployment.md).

## Where to look

- `docs/model.md`: the water-balance model, formulas, workbook quirks, glossary
- `docs/engine-audit.md`: where and why the engine departs from the workbook (finding IDs); `docs/engine-review.md`: the earlier faithfulness review
- `docs/spikes/`: one-off spikes that settle a plan's assumptions before it is built (`604-round0.md`: CHC's NetCDF vs its TIFFs, dynamical.org, zarrita, issue #604)
- `docs/upstream/`: bug reports drafted for upstream projects (the V8 Maglev OSR miscompile behind engine-audit.md V1, issue #232)
- `docs/legal/disclaimer-review.md`: the report disclaimer, sign-off statement and farmer liability lines, quoted for the client's legal review (issue #47)
- `docs/legal/operator-agreement.md` (POPIA s20–21 template for each client) and `docs/legal/incident-procedure.md` (personal-information breach: who decides, timelines, the Regulator's report); `docs/legal/known-defect-procedure.md` (a confirmed engine bug: the errata row, the runs' May be affected flag, the owners' email); `docs/legal/information-officer.md` (registering with the Information Regulator); `docs/legal/map-data-licences.md` (the Terms against the map data's licences, and the map credits; for counsel); `docs/legal-status.md` tracks what is open
- `docs/calibration-research.md`: literature and South African practice review of calibration, recession, data uncertainty and EWR reporting, with prioritised recommendations (CR-1 … CR-34)
- `docs/data-model.md`: tables, workbook mapping, roles and RLS, series storage
- `docs/api.md`: HTTP contract
- `docs/ui.md`: the catchment workspace (tabs, Add data, schematic, results dashboard)
- `docs/run-comparison.md`: comparing two runs (matching rules, what the input diff sees)
- `docs/maps.md`: the Map tab: the self-hosted basemap and its fetch recipe, GeoJSON upload checks, server-side areas, the quaternary lookup and loading its dataset, the cultivated area from land cover, the evaporation from the map, the sources table, CSP
- `docs/data-sources.md`: the source register: every upstream we use or plan (feeds, reference datasets, #604's planned sources) with host, licence and attribution, contact, access pattern, limits, fallback and owner, and the polite-client rules (`scripts/guards/data_sources.mjs` keeps it in step with `FEED_HOSTS` and `data_feed.source`)
- `docs/allocations.md`: registered water-use volumes (WARMS, licences) vs modelled use: import, matching, the comparison, who sees names
- `docs/evidence-pack.md`: licensing evidence packs: the manifest and its hash, the short code, the lifecycle (draft, sign, issue, supersede, withdraw) and the public verify lookup
- `docs/scenarios.md`: scenarios, overrides on a base run (the engine's op catalogue, classification, problems; the backend, data model and API)
- `docs/testing.md`: which test command when, and how long each takes; `verify/README.md`: the independent cross-check of the engine (what it covers, its findings, phase 2)
- `docs/contributing.md`: the git workflow for sessions sharing a checkout, code organization, the root scripts format, and which files the templates repo owns; `.claude/README.md`: the Claude agents and commands
- `docs/plan.md`: roadmap, acceptance criteria, questions for the client, risks
- `docs/planned-work.md`: feature backlog beyond V1; `docs/followups.md`: known open work
- `docs/design/ui-playbook.md`: how screens are designed, built and tested (process, layout rules, reusable pieces, testing traps; the `ui-designer` agent works from it)
- `docs/design/`: design specs written before a build (the farmer view, issue #14; the licensing evidence report, issue #15), each with its prototype; planning outputs (share the pain, outcome matrix, seasonal outlook, licence impact by year class, issue #53), research and recommendations only
- `docs/roadmap/`: the four-step growth plan (hydrologist tool → shared catchment → licensing → platform), one build plan per step
- `docs/architecture.md`: system diagram, workspaces, request/run lifecycle
- `docs/run-locally.md`, `docs/deployment.md`, `docs/security.md`
- `docs/deployment-tiers.md`: minimal vs full (highly available) deployment, their tfvars and monthly cost
- `infra/README.md`: Terraform specifics

Prefer reading these over guessing. Update them when behaviour changes.

## Conventions and gotchas

- **This repo is public.** Never commit secrets (they live in the private
  `Absence0760/infra-secrets` repo under `water-management/`), client
  workbooks, or anything derived from them. Committed fixtures are synthetic,
  with no real farm names or values ([security.md § Public repo hygiene](./security.md#public-repo-hygiene)).
- **The engine stays pure.** No `fetch`, no DB, no Node or DOM APIs in
  `packages/engine`, because it has to run in the browser *and* in Lambda.
  Engine correctness is judged by documented hydrology and the invariant tests
  (`run.invariants.test.ts`), not by agreement with the workbook: an
  intentional departure is justified in [engine-audit.md](./engine-audit.md)
  and listed, column by column, in the client catchment regression suite's deviation
  list, which must stay green. A change in behaviour bumps `ENGINE_VERSION`.
- Tests that need client-derived fixtures (under `data/`) skip when the
  fixture is absent.
- **Every project-scoped query runs as `water_app` inside a transaction that
  sets `app.current_user_id`.** Never connect the running backend as `water`,
  and never add `BYPASSRLS`. A new project table needs RLS policies,
  same-project triggers and grants (use `/safe-migration`).
- **Migrations move forward.** Production has run them all (2026-10-05), so
  never edit one, `001` included: add `NNN_name.sql`. Prefer expand/contract
  ([data-model.md § Migrations](./data-model.md#migrations)).
- **Two backend entry points.** `server.ts` imports `dotenv/config`. `lambda.ts`
  must not reach any module that imports dotenv, so that esbuild tree-shakes it
  out. The same pair for the job worker: `jobs/worker.ts` (local, dotenv) and
  `lambda-worker.ts` (AWS, never dotenv), and `lambda-fetcher.ts` and
  `lambda-renderer.ts` are AWS only; `infra/scripts/package-lambdas.sh`
  refuses a Lambda bundle that contains dotenv, and any static import of
  `playwright-core` in a bundle but the renderer's (the lazy `import()` in
  `reports/render.ts` is the one allowed path; `scripts/guards/check_lambda_bundle.mjs`).
- **Static SPA frontend only.** No SSR adapters. Routes render client-side from
  the fallback `index.html` (CloudFront maps 404s to it). `PUBLIC_API_URL` is
  `http://localhost:3001` in dev and `/api` in production (CloudFront proxy).
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`).
- **i18n messages (WP-2.5).** Farmer-facing strings (farm view, sign-in
  pages, account and alert pages, `/share`, the landing page) are their English, written at the
  call: `t('Your dam')`, `tRich(…)`, `tn(DAYS, n)`; a message kept in a table
  or variable is `msg('…')`, a counted word `plural({ one, other })`, and a
  file's messages sit under an `// i18n-section:` marker. Farmer emails come
  from `backend/src/mail/i18n/en.ts` (keyed) through `mailT()`. Never show a
  string there without `t()`, never write another language's words by hand:
  a new or changed message goes through the `i18n-translator` and
  `i18n-checker` agents and `pnpm gen:i18n:apply <lang>` (ui.md § Language),
  and run `pnpm gen:i18n:sheet` after changing a message (the
  tests throw on English that isn't on the sheet; [ui.md §
  Language](./ui.md#language)). The workspace stays English. Those pages
  show a server error through `errorText` (`lib/i18n/apiError.ts`, from the
  API's stable `code`), never its English `error` text; a new error a farmer
  can meet gets a code in `backend/src/http/errors.ts` `ERROR_CODES` and a
  message in `apiError.ts` `CODES` (`http/errorCodes.test.ts` fails on an
  uncoded one in those routes).
- **`pnpm check` doesn't compile components.** svelte-check type-checks the
  TypeScript in `<script lang="ts">`; the Svelte compiler strips it at build
  time, and a stripping bug fails every `vite build` (production and the e2e
  site alike) while `check` stays green. Svelte 5.56.0–5.56.3 left `?` on
  optional parameters (sveltejs/svelte#18455). The guard is
  `frontend/src/lib/components/__fixtures__/tsSyntax.test.ts`: it compiles a
  fixture through the build's preprocess (`frontend/svelte-options.js`, which
  `vite.config.ts` hands to `sveltekit()`) and Vite's parser (Rolldown's). Add a
  case to its fixture when a new TS form breaks a build. It does fail on
  warnings: the frontend's svelte-check runs with `--fail-on-warnings`, so a
  Svelte a11y or unused-CSS warning breaks `check` (and CI) like a type error.
- **Postgres on 5434**, because this workstation's 5432 (Supabase) and 5433
  (native) are taken.
- **Terraform:** `plan` is fine; never `apply` without the operator's go-ahead.

## What not to do

- Don't add a test framework beyond vitest (unit) and Playwright (e2e, `e2e/`). Python's stdlib `unittest` for the importer (`scripts/wbt-import/`), the bulk ingest job (`ingest/`) and the cross-check (`verify/`) aside, and the
  dependency-free CI/release guards under `scripts/` (and `e2e/support/*.test.ts`) use Node's built-in `node:test`
  (the estate pattern), since the root package has no dependencies.
- Don't replace pnpm, and don't `npm install -g` anything.
- Don't add the npm `xlsx` package (stale, with known advisories). SheetJS
  comes from its CDN tarball (see frontend above); keep the `package.json` URL
  pin, never a registry version.
- Don't call the DB or secret-bearing services from the frontend.

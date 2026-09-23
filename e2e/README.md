# End-to-end tests (Playwright)

Browser tests for the whole app: the SvelteKit frontend, the Hono backend and
Postgres. They run **fully locally**: no cloud account, and your dev servers
and dev database are left alone.

## Running

```bash
pnpm dev:db:up            # docker Postgres on :5434 (once per session)
pnpm test:e2e:install     # once: download Playwright's Chromium
pnpm test:e2e             # the whole suite, headless
pnpm test:e2e:ui          # Playwright UI mode (watch, time-travel debugging)
pnpm check:e2e            # typecheck the specs
pnpm test:e2e tests/model.spec.ts   # one file (extra args go to playwright test)
pnpm -C e2e e2e:list      # list the tests without running them
```

`pnpm test:e2e` does all of the setup itself:

1. **Database.** `support/global-setup.ts` connects as the schema owner, creates
   the `water_e2e` database if it is missing, drops and recreates its `public`
   schema, and applies `backend/migrations` with the backend's own migrator.
   Every run starts from an empty schema.
2. **Servers.** Playwright's `webServer` starts the backend on **:3101** (as the
   RLS-bound `water_app` role, against `water_e2e`) and the frontend dev server
   on **:7801** (with `PUBLIC_API_URL=http://localhost:3101`). It never reuses
   an existing server, so a stray process on those ports fails the run loudly
   instead of testing the wrong build. `pnpm dev` (:7777 / :3001, database
   `water`) can keep running alongside.

Only Chromium is configured. On Fedora, Playwright prints "your OS is not
officially supported" and downloads its Ubuntu build, which runs fine here.
`playwright install-deps` is apt-only, so it doesn't work on Fedora, and you
don't need it. CI (Ubuntu) uses `playwright install --with-deps chromium`.

Failures keep a trace and a screenshot under `e2e/test-results/`. Open one
with `pnpm -C e2e exec playwright show-trace <path>/trace.zip`.

## Layout

| Path | What |
| --- | --- |
| `playwright.config.ts` | Ports, web servers, `timezoneId: 'UTC'`, no retries |
| `support/env.ts` | Ports and database URLs (dev-only docker credentials) |
| `support/global-setup.ts` | Rebuilds `water_e2e` |
| `support/api.ts` | API helpers for arranging state (users, projects, model, series, runs) plus a small synthetic catchment |
| `support/db.ts` | Plants reset / verify / invite link tokens straight into `water_e2e` (as the owner). Mail goes to the backend log in e2e (`MAIL_TRANSPORT=log`) and the database keeps only token hashes, so a spec that follows an emailed link plants one whose plaintext it knows |
| `support/fixtures.ts` | `owner` (a fresh user signed in to `page`) and `signIn(name)` (another user in their own browser context) |
| `fixtures/*.csv` | Synthetic daily rainfall and observed flow: a 92-day pair (ISO dates; DD/MM/YYYY with one gap) and a two-water-year pair for the golden path |
| `tests/golden-path.spec.ts` | One user journey done only through the UI: register, create "Catchment D", build the network, crops and a transfer, save, set A-pan and EWR, upload two years of rain and flow, run the model, read the results, reload, then add two more catchments |
| `tests/auth.spec.ts` | Register, sign out and in, wrong password, deep link → login → back, open-redirect guard; "Forgot password?" → request acknowledged; reset link → new password works (also opened while signed in; spent link); confirm-email banner cleared by the link, and the link working signed out |
| `tests/projects.spec.ts` | Create several projects, copy one (with its model), delete, roles in the list; data-freshness badge, last run and the editors-only "Add data" link (`?add=data`); the list and the workspace header count the same local days under a UTC+14 clock |
| `tests/sharing.spec.ts` | Owner shares with a viewer (read-only everywhere, unshared project → not found); editor rights; inviting an address with no account (pending list, re-send throttle, revoke); signing up through an invite link lands in the project; a dead invite link falls back to plain sign-up; an invite link opened while signed in (another account: sign out and accept; own unconfirmed address: confirm first; dead link) |
| `tests/model.spec.ts` | Build gauge + farms, crops, planted areas, a transfer; save; reload. Second outlet and loop block saving; unsaved-changes guard; thousands separators in the one-node form and the view-only table |
| `tests/settings.spec.ts` | Monthly A-pan and EWR save and reload; discard; date validation |
| `tests/series.spec.ts` | Upload rainfall + observed-flow CSVs, preview, chart; malformed CSV |
| `tests/runs.spec.ts` | Run the model: run listed, farm summary table, charts, persisted; the result-sections menu lands each panel below the sticky header |
| `tests/overview.spec.ts` | Overview checklist and headline counts (fresh and complete projects), counts updating after "Add data" on the tab, a long member email wrapping at its break points on a phone |
| `tests/auth-layout.spec.ts` | The split sign-in / register layout beside a classic 15 px scrollbar (`html { overflow-y: scroll }`), desktop and phone, light and dark: no sideways overflow, full-height brand panel, gutter in the form's colour; saves a screenshot of each |
| `tests/examples.spec.ts` | Seeds the invented example catchments (`backend/scripts/seed-examples.ts`, once per run) and checks both demo users' lists and roles (owned, team-shared, directly shared) and a read-only shared example with its seeded run |
| `tests/teams.spec.ts` | A team owns catchments together (add a colleague, create in the team, both lists, filters); the last admin can't leave; inviting an address with no account and revoking it |
| `tests/a11y.spec.ts` | axe WCAG 2.2 A/AA scan of every page (sign-in pages, emailed-link dead states, project list, teams, a team, help, compare), every workspace tab, dialogs, save bar, one-node form, view-only workspace and a signed-in invitation, in light and dark; every tab again at phone width; sideways-scrolling boxes take focus and scroll by keyboard |

## Rules for writing specs

These follow the project rules in `CLAUDE.md`. Keep to them:

- **Every test makes its own users** through the API (`owner`, `signIn`,
  `register`). Tests share nothing and run fully in parallel against the one
  database. Don't depend on another test's data or on the order tests run in.
- **Arrange through the API, act through the UI.** Only drive the UI a test is
  actually about. Everything else goes through `support/api.ts`.
- **Wait on real UI signals**: a heading, a status message, a table row, an
  `aria-current`, a response (`page.waitForResponse`). Never use
  `networkidle`, never `waitForTimeout`, and never inflate a timeout to get past
  a slow step. Fix whatever is slow.
- **Select by role and accessible name** (`getByRole`, `getByLabel`). If an
  element can't be reached that way, fix its accessibility in the component
  (a label, an `aria-label`) rather than reaching for CSS or a test id.
- **No retries** (`retries: 0`). A flaky test is a bug. Find the race.
- `timezoneId` is pinned to `UTC`, so date output is deterministic.
- **Fixtures are synthetic.** The repo is public, so never commit client names,
  values or workbook-derived data.
- A spec that finds an app bug gets the fix in the app, in its own commit.
  Never loosen the assertion to make it pass.

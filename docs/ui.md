# The catchment workspace (UI)

What each screen is and does. How to design, build and test a screen (process, layout rules, reusable pieces) is in [design/ui-playbook.md](./design/ui-playbook.md).

## App shell and account menu

Every signed-in page sits in one frame (`lib/components/layout/AppShell.svelte`,
issue #17), except the farmer view (`/farm`, its own `FarmShell`), a
farmer-only user's account pages (the farm frame too, [§ Farmer
view](#farmer-view-farm)) and the sign-in pages (`AuthCard`). The root layout wraps the page in it once a
session exists. A **Skip to content** link comes first.

- **900 px and wider:** a full-height sidebar (15rem, 240 px) from the top
  edge, sticky while the page scrolls. From the top: the app mark (a link to
  `/`), the **Main** navigation (Projects / Teams / Help,
  `aria-current="page"` on the section the URL is in; the project workspace
  counts as Projects), the page's own navigation in the slot (below), and the
  account menu at the foot. It is spaced so that, with a project open, every
  section an owner sees fits a 1440 × 960 window with the account menu in
  view and room for one more row (a two-line catchment name included;
  `app-sidebar.spec.ts`). On a shorter window (1280 × 800) the slot scrolls
  on its own instead of the whole sidebar, so the brand, Main and the account
  menu stay on screen, and the open section is scrolled into view in it (the
  slot's `scroll-padding` keeps it clear of the edges). Only below about
  8rem of slot does the whole sidebar scroll. Nothing
  is fixed across the top, so `--header-h` (`app.css`) is 0 and sticky bars
  and in-page link targets stop at the top edge. A page (`.page`) starts at
  the sidebar's edge rather than centring in the width left, which left a
  dead gap between the sidebar and the content.
- **No pointless scroll.** Below its content a page keeps a 1rem gutter and
  nothing more; the project workspace adds the model save bar's height only
  while the bar shows (`--dock-h`, 0 otherwise), so the bar never covers the
  last row. A page whose content fits the window doesn't scroll at all. It
  used to reserve 5rem (the workspace 4rem) below everything, so a page that
  came within 56–70 px of the window's foot scrolled for nothing
  (`no-pointless-scroll.spec.ts`).
- **Below 900 px (phones):** a slim sticky bar, 52 px (`--header-h`): a
  **Menu** button that opens the Main navigation under the bar, the brand,
  and a compact account button (initials only). The Menu closes on a
  navigation, a click outside it, or Escape (Escape puts focus back on the button).

**The page slot** (`layout/sidebar.svelte.ts`): a page puts its own
navigation in the sidebar with `fillSidebar(snippet, on)`, called from an
`$effect` so it clears when the page goes. It fills the slot only while the
sidebar is shown; on a phone the page renders that navigation in the page
instead, so only one copy exists at a time (one set of ids, one tab order).
The project workspace is the one user ([§ where the sections
live](#project-workspace)); Help keeps its contents in the page
([§ Help](#help-help)).

**The account menu** (`layout/AccountMenu.svelte`) is a button showing an
avatar, display name and email (initials only on the phone bar, `compact`)
that opens a list (same disclosure pattern as the Data/Runs tabs' download
menu — a button plus a hidden list, not an ARIA `menu`/`menuitem` widget)
with three entries. At the sidebar's foot it opens upward (`up`); on the
phone bar, downward.

- **Account** — a link to `/account` (marked `aria-current` while there).
- **Sign out** — ends this device's session only, same as before.
- **Sign out everywhere** — asks for confirmation, then calls
  `POST /auth/logout-everywhere` ([api.md § Auth](./api.md#auth)), which
  revokes every session on the account (this device included) by moving its
  revocation watermark forward. Both actions clear the local session and
  return to `/login`.

The menu is keyboard-operable: Escape closes it and returns focus to the
account button, as does a click outside; a tab or click that leaves the
menu closes it too.

**The account page** (`routes/account/+page.svelte`, WP-1.9) opens with a
header (issue #17): **Account**, then who you are as its summary line, the
initials avatar, display name, email and a Confirmed / Not confirmed badge
(a region named by the heading). Below it the cards sit in **two columns**
once the page itself is 52rem wide (a container query, so the 240 px
sidebar counts): Profile and Password on the left; Language and units,
Alert emails and Your data on the right; one column below that. The page is
capped at 92rem from the sidebar's edge, and at 1440 × 960 it fits the
window without scrolling (`account.spec.ts` › layout pins both widths). Form
fields share one right edge (at most 36rem); Save name sits beside the
display name; the new and repeated passwords sit side by side once the card
is 30rem wide; the language switch is its compact joined form
(`LanguageSwitch segmented`); the m³ / ML radios sit in one row, 32 px
tall with a mouse and 44 px on touch and phones. Submit buttons are the
primary style; Choose your alert emails, Download my data and Turn alert
emails back on are secondary buttons. Sign out and Sign out everywhere stay
in the account menu only. The cards: a **Display name** form
(`PATCH /auth/me`; the account menu follows at once), **Language and units** (the
language switch and the farm view's m³ / ML, [§ Language](#language)), a
**Your data** panel whose **Download my data** button saves the
data-subject export (`GET /auth/me/export`, a JSON file; the download
helpers load on click, and a second click within the minute shows the
server's `429` message in an alert) and a
**Password** form
(current, new, repeat; `POST /auth/change-password`). Changing the password
signs out every other device while this browser stays signed in. Errors show
in an alert above the form, with the field it's about marked
`aria-invalid`: *Your current password is wrong.* (the server's `403`, which
also counts towards the sign-in lockout, whose `429` message is shown as
is), and the new-password rules checked before any request (*Use at least 8
characters.*, the two not matching).

## Number style

One thousands separator app-wide (D10, issue #76): a **narrow no-break
space** (U+202F) between digit groups, with a '.' decimal point in the
workspace: 300 000, 1 234.5. It never wraps a figure across two lines, and
it is what SI and South African practice write. The workspace formats
through `fmtNum` (`lib/format/number.ts`), the farm view and landing page
through their own helpers in the chosen language's decimal mark, and the
engine's messages (run warnings, input diffs, validation) the same way; all
of them group with `engine/src/format.ts`. A figure and its unit keep an
ordinary no-break space on the farm pages. Typed or pasted numbers accept any
space, and a comma in a valid grouping (1,500), as a separator (`parseNum`).
Exports don't group: a CSV is plain numbers, and the workbook's format codes
draw the reader's own locale. A revision line saved before the change
("750,000 m³") still matches today's diff for the History attribution
(`backend/src/history/attribute.ts`).

## Landing page

`/` for a signed-out visitor, and `/welcome` for anyone (issue #57;
`lib/components/landing/`, `e2e/tests/landing.spec.ts`). What the app is, who
it's for and why, before the sign-in: a first-time visitor to `/` no longer
lands on the sign-in form. A signed-in `/` is still the project list, and every
other signed-out route still goes to `/login?next=`.

- **Routing.** `routeAccess` shows a signed-out `/` (`isLandingRoot`); the root
  layout renders `Landing.svelte` there in place of the projects page, loaded
  as its own chunk beside `/auth/me`. `/welcome` (`LANDING_PATH`, public) is
  the same component, **prerendered** at build time (`routes/welcome/+page.ts`)
  so crawlers and link previews get the page and its tags without running the
  app; it renders at once, before the session is known, and even with the API
  down. The canonical link and `og:url` point at `/welcome`.
- **Frame.** Outside the app shell, like the sign-in pages: a slim header (the
  mark and name, the language switch, **Sign in**), the page, a footer. A
  reading page with a 1200 px column; on a phone the header keeps the mark only.
- **Sections**, in order: the hero (headline, lede, **Sign in** and **Create an
  account**, the animated catchment); *From rainfall to river* (five steps over
  a pinned diorama, each with a small chart); *Try a what-if* (two sliders over
  precomputed runs); *What you get* (real screens, framed); *Who it's for* (the
  four audiences); *How it works* (three steps); *Why trust it*; a closing call
  to action; the footer. Sign-up is open, so **Create an account** links
  `/register` (issue #57's decision); Help stays behind sign-in.
- **Language.** Translated (English and Afrikaans, § Language): the
  `landing.*` sections of the translation sheet. `/welcome`'s prerendered HTML
  is English and switches once the chosen language's words arrive, the one page
  allowed to, so it never waits on the API.
- **Tags.** Title, description, canonical, Open Graph (`og.jpg`, 1200 × 630,
  rendered) and a large Twitter card, with absolute URLs from the build's
  `SITE_ORIGIN` ([deployment.md](./deployment.md)).
- **Figures** come from the invented Kleinberg example (the engine at build
  time, `data.generated.ts`), named as the example catchment's where shown:
  the hero's reserve tag, the story's charts (the river's on a square-root
  scale, which its unit says), the what-if (each bar labelled **Today** or
  **This plan**; the plan's supply in the app's supply bands), and *Why trust
  it*'s three figures under "In the example catchment", the last the run's
  calibration NSE. The art, the motion rules and the
  pipeline that makes them: [design/landing-art.md](./design/landing-art.md).

## Legal pages

`/privacy` (the privacy notice) and `/terms` (terms of use),
`routes/privacy`, `routes/terms`, framed by `lib/components/legal/LegalPage.svelte`:
a slim header with the way home and **Open the app** (to `/login`, which sends
a signed-in reader on to their projects: a static page can't know the session,
so it doesn't claim "Sign in"), a contents list (folded behind a
**Contents (13 sections)** disclosure (the privacy notice) on a phone, where the list alone filled
the first screen; open from 601 px), a readable column, and footer links. Prerendered like `/welcome` (static HTML, open to
anyone signed in or out, rendered before the session is known). Each has its
own `<title>` (*Privacy notice · Water Management*, …) in the HTML itself:
`app.html`'s fallback title sits after the page's head, since the document's
title is the first `<title>` and these pages run no script to correct it
(WCAG 2.4.2; `legal.spec.ts`). English
only: the English text binds; the link labels to them are translated. Linked
from the landing footer, under every sign-in form (a **Legal** nav in
`AuthCard`), and in the sign-up form's assent checkbox. The Terms open with
**The short version**: the four main points of `lib/components/legal/termsSummary.ts`,
the same list the sign-up form and the re-acceptance notice show translated
(`TermsSummary.svelte`). Research-based wording the operator accepted without
counsel: what it assumes and what is open is in [legal-status.md](./legal-status.md).

**Sign-up assent.** Directly above the sign-up button (invitations
included): a bordered box, **The main things you agree to**, with the four
points in the reader's language (and, in another language, "The Terms are
in English; this summary is in your language"), then a required, unticked
checkbox, "I have read the main points above and accept the Terms of use
and Privacy notice", whose label links both pages. The browser won't submit
the form until it is ticked. With the box at body size the sign-up form is taller
than a window, so it is the one sign-in page that scrolls (to the end of the
form and no further; `auth-pages.spec.ts`).

**Re-acceptance notice.** When the terms change (`LEGAL_VERSION`), a
signed-in account whose `termsCurrent` is false (it accepted an older
version, or none) sees, on any app page, a full-page notice in the sign-in
pages' frame instead (`auth-extras/TermsUpdate.svelte`, loaded by the root
layout): **Our terms have changed**, what changed (a short list rewritten
with each version), links to both pages, the same main points, **Accept the
new terms** (`POST /auth/me/accept-terms`) and **Sign out**. The URL stays
the page asked for, which renders once accepted. The public pages (the legal
pages, emailed links, share links) aren't held behind it. Translated.
`e2e/tests/terms-update.spec.ts`.
The **Effective** line under each title is `legalEffective()` of the
engine's `LEGAL_VERSION` (`packages/engine/src/legal.ts`), the same
version the sign-up form sends as `acceptTerms` and the account records
(087); change the pages and that date together.
`e2e/tests/legal.spec.ts`.

## Methods page

`/methods`, "How the model is checked" (`routes/methods`): the public summary
of [engine-audit.md](./engine-audit.md), in the legal pages' frame and
prerendered like them (static HTML, no script, open to anyone). It backs the
landing page's first trust statement and is linked under it and from the
landing and legal-page footers. Nine sections: what the model does, the
standard it is held to (documented hydrology and invariants, not the
workbook), the checks on every run and on every change, the departures from
the workbook, the known limitations, calibration statistics, versions, and a
link to the full audit in the public source. No client data. Two parts can't
drift from the audit: the **known limitations** table is the engine's
generated `KNOWN_LIMITATIONS` (the list every report prints), and a
departure's *Pending a hydrologist's confirmation* mark is read from it too.
The departures' own words are `lib/methods/departures.ts`; its test checks
that every id is a row of the audit. After changing an audit decision, run
`pnpm gen:limitations` as usual and the page follows; when the audit adds or
closes a finding a reader would care about, update `departures.ts`. The
**Effective** line shows the engine version instead. English only.

## Sign-in pages

`/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email` and `/alerts/unsubscribe` share one frame,
`lib/components/layout/AuthCard.svelte` (translated, § Language): the navy
brand panel with the catchment drawing on the left (55 %), the form on the
right, 380 px wide. They are forms, not dashboards: each fits a 1280 × 800
window with no page scroll, in every state (the longest is the sign-up form
under a dead-invitation warning).

- **The lockup is a link home** (`/`): the landing page signed out, the
  project list signed in.
- **Sign-up is email-first** (issue #57, the flow threkir uses). The form asks
  for the password twice (**Confirm password**; compared exactly, a trailing
  space included, before anything is sent) and says under the email field
  that a confirmation link will be emailed. An ordinary sign-up then goes to
  `/login?confirm=sent`: a notice says where the link went (the address kept
  in this tab's `sessionStorage`, never the URL) and that sign-in waits for
  it, with **Send the link again**, and the email field is filled in. Signing
  in before confirming (`email_unconfirmed`) shows a warning naming the
  address, with **Send the link again** (`POST /auth/resend-confirmation`,
  the same answer for any address). A taken address gets exactly the same
  pages. Sign-up through a live invitation link is still confirmed, joined and
  signed in at once.

- **One place for the title.** The form starts on the brand copy's top line
  rather than centred in the height, so the brand lockup, the language
  switch and the page title (the only `h1`) sit in the same place on every
  page and don't move when a message appears above the form (a wrong
  password, a sent link).
- **Actions** are full-width buttons under the form (44 px, wrapping a long
  address rather than overflowing); the footer, under a rule, holds the one
  way elsewhere ("No account? Create one"). A page whose answer already
  offers that link leaves the footer out: the unsubscribe page's done and
  dead-link states show **Manage alerts** once, as their button.
- **Focus.** When a page swaps its content for another state (forgot
  password → *Check your email* and back, reset → done or a dead link,
  unsubscribe → done or a dead link, *Sign out and accept* on an invitation
  for someone else), focus moves to the title (`focusAuthTitle`), since the
  button that had it is gone. The same holds outside the card: **I
  understand** on the farm notice, **Accept the new terms** and the
  confirm-email banner's **Dismiss** each remove themselves, and focus moves
  to the new page's `h1`, or `#main` while it loads (`focusPageStart`,
  `lib/a11y/focusPage.ts`; WCAG 2.4.3).
- **Text** is 14 px at least (1rem of the 14 px root): labels, hints, the
  *Forgot password?* and legal links (issue #51; `layout/authTextFloor.test.ts`
  scans the styles, `auth-pages.spec.ts` measures every visible text in
  English and Afrikaans).
- **Motion.** The panel's drawing (`CatchmentScene.svelte`) moves for under
  5 s after the page opens, then holds still (WCAG 2.2.2), and not at all
  under reduced motion.
- **Phones (below 900 px):** one column, the drawing an 84 px band above
  the form, so the title and first field sit in the top quarter of the
  screen, above the keyboard.
- **Password fields** (`common/PasswordInput.svelte`, also on the account
  page) have a **Show / Hide** button inside, named *Show password* /
  *Hide password* from its content, so the field stays the only control
  labelled "Password". The wrapper draws the field's border and focus ring
  and lays the input and the button side by side, so the button takes its
  own width and never covers the text (Afrikaans *Versteek* overran a fixed
  reserve once; issue #51).

`auth-pages.spec.ts` pins the fit, the title's place and focus at all three
sizes in both themes, with axe scans at desktop and phone size;
`auth-layout.spec.ts` checks the frame beside a space-taking scrollbar.

## Project workspace

**Terminology: hydrological unit (issue #54 item 2a; client question Q6,
decided in issue #90).** Everywhere a user reads the name of a demand node
of kind `farm`, the app calls it a **hydrological unit**: a farm,
sub-catchment or town with land of its own, a runoff share, an optional dam
and demands (a town that only draws water from the river is an *other water
user*). "Hydrological unit(s)" in a sentence, capitalised at its start
("Hydrological units", "Your hydrological unit"). That covers the
modeller workspace (Network, Crops & demand, the results panels, History,
scenario forms, the farmers and publication panels, the printable report,
the xlsx notes, the download menu's labels, the landing and methods pages
and the workspace help, `lib/help`: tips, articles, guides, tour; the one
definition is the glossary's **Hydrological unit** entry, `element-farm`,
which also says it is not a unit of measurement) and, since issue #90,
everything farmer-facing too: the farmer view (`/farm`: "My hydrological
unit", "Your hydrological unit on the river", "Who can see my hydrological
unit"), its i18n messages and Afrikaans ("hidrologiese eenheid",
[farmer-view.md §5.1](./design/farmer-view.md#51-words)), the farmer
glossary (`lib/help/farmer.ts`), the farmer emails ("Your hydrological unit
on …", "Open your hydrological unit") and the public `/share` page. The
client chose it knowing it is more technical for farmers. Engine check
labels are reworded on the way in (`runs/checks.ts` `checkLabel`).

What keeps **farm**: the code, database, API and CSV names (`kind: 'farm'`,
`/farm`, `farms.csv`, `farm_scope`, the invite CSV's `farm` column), URL
params (`unit=`), test ids, engine and API messages (run warnings, save
errors, the bulk invite's "no farm named …") and the summary CSV's block
titles. So do words that mean the real thing rather than the node: a
**farmer** (the person, "Preview as farmer", "farmer views" in the
publication panel), a **farm dam** (the kind of dam), "a farm, sub-catchment
or town" where the glossary says what a unit can stand for, the landing
picture's "two farm dams", and "a farm" as a business in the Terms. Three
farmer-facing texts keep "farm" on purpose, as legal wording that needs its
own decision: the farm notice's title "Before you look at your farm"
(bound to `FARMER_NOTICE_VERSION` and quoted in the legal review pack, so
rewording it means a new version every farmer re-accepts), and the Terms
and Privacy pages (`/terms`, `/privacy`, versioned by `LEGAL_VERSION`). The
importer's notes keep b023's own terms (and match `extract_project.py`),
and node names ("Upper farm") are data. A new node is still named
`Farm N`.

A project opens on `/projects/:id`. The page loads the project, its model,
the input-series list and the runs list behind one loading gate, so no tab
renders empty and then fills in. The Summary, Data and Runs tabs take those
lists as props and report changes back, so an upload or a run made on one tab
shows in the others (the Summary's counts and checklist included) without a
refetch. Only the Summary ships with the page; every other tab's code is
fetched the first time that tab opens (started alongside the data load when
the URL names the tab, and warmed when its link is hovered or focused), with
the standard "Loading…" state in the meantime
([architecture.md § Code splitting](./architecture.md#code-splitting-frontend)).
The tabs are grouped into three sections, in this order: **Build the
model** (Network, Crops & demand, Transfers, Data, Settings & calibration),
**Review** (Project, Applications, History) and, at the bottom,
**Outcomes** (Summary, River & reserve, Hydrological units, Runs & results, Dams,
Compare runs, Scenarios, Allocations). Issue #17's option A put Outcomes
first; the operator moved it last on 2026-09-27. The Summary is still the
tab a project opens on. The sections are
`NAV_SECTIONS` in `lib/workspace/tabs.ts`, and `navSections(shown)` splits
whatever tabs a role sees into them (empty sections are dropped; a tab no
section lists joins *Build the model*). Each tab's name is `TAB_LABELS` in
the same file, which the help pages share. It is layout only: the URLs stay
`?tab=<id>` and which tabs a role sees is unchanged (below).

- **900 px and wider:** in the app sidebar's slot ([§ App shell](#app-shell-and-account-menu)),
  a "Catchment" label with your role badge (owner, editor, viewer) beside it
  and, at the end of that line, the **Choose sections** button (reading
  "Hidden (n)" once you hid some; see Tabs by role below),
  the project's name (a link to its Summary; a long name is clamped to two
  lines, the full name its tooltip and accessible name), the section labels
  shown, with a
  viewer's **Show model inputs** at the end. **Data** carries an amber badge
  counting the series behind: the series a run is driven by (recorded rain,
  A-pan evaporation; never a forecast or a flow) ending more than
  `STALE_DAYS` ago (`freshness().behind` in `series/freshness.ts`, the same
  measure as the "Rain up to" pill and Needs attention's stale item). Its
  accessible name says it: "Data (2 series behind)".
  The sidebar's **Projects** link replaces the old "Projects / *name*"
  breadcrumb row. The content column keeps its usual 1480 px maximum beside
  the sidebar; narrower, the widest grids scroll inside their own box: the
  network's node table fits from about 1700 px and scrolls below that (cards on a phone), its
  name and remove columns kept in view (`model.spec.ts`).
- **Below 900 px (phones):** a compact line with the project's name and your
  role, then a full-width **Sections** button naming the open
  tab (its accessible name is "Project sections: *Tab*", with the problems dot
  when a model tab has one) opens the same grouped list in the page, the
  section labels shown and the open tab marked, with a viewer's **Show model
  inputs** at the end. Choosing a tab or pressing Escape closes it (Escape puts
  focus back on the button). The phone bar's **Menu** holds Projects / Teams /
  Help. It replaced a 12-tab strip that scrolled sideways, where a phone
  showed about three tabs and none of the grouping.

The list is rendered once, in whichever of the two places applies
(`fillSidebar(…, wide && project loaded && not the Applicant view)`), so
its tab ids and arrow keys never exist twice. The Applicant view fills no
slot.

The arrow keys move through the tabs in the order shown, across sections,
wrapping at the ends (Right/Down next, Left/Up previous).

| Tab | `?tab=` | Aliases | Code |
| --- | --- | --- | --- |
| Summary | (none) | `summary` | `lib/components/overview/` |
| Runs & results | `runs` (`&run=<id>`) | `results` | `lib/components/runs/` |
| Compare runs | `compare` (`&a=<projectId>:<runId>&b=…[&c=…]`: baseline, what-if 1, optional what-if 2) | | `lib/components/compare/CompareView.svelte` ([run-comparison.md](./run-comparison.md), § Compare runs below) |
| Scenarios | `scenarios` (`&scenario=<id>`) | | `lib/components/scenarios/` |
| Allocations | `allocations` | | `lib/components/allocations/` |
| Network | `network` | | `lib/components/network/` |
| Crops & demand | `crops` | `demand` | `lib/components/crops/` |
| Transfers | `transfers` | | `lib/components/transfers/` |
| Data | `series` | `data`, `timeseries` | `lib/components/series/` |
| Settings & calibration | `settings` | `calibration` | `lib/components/settings/` |
| Project | `project` | `details`, `members`, `sharing` | `lib/components/project/` ([§ Project](#project)) |
| Applications | `applications` | | `lib/components/scenarios/ApplicationsTab.svelte` |
| History | `history` | `changes` | `lib/components/history/` |

**Tabs by role** (`lib/workspace/tabs.ts`, issue #6). One pure function,
`visibleTabs(role, prefs, rendered)`, decides which tabs the sections list shows and
which setup-checklist steps are links:

| Role | Tabs shown |
| --- | --- |
| owner, editor | every tab |
| viewer | Summary, River & reserve, Hydrological units, Runs & results, Dams, Compare runs, Scenarios, Allocations, Data, Project; Network, Crops, Transfers, Settings & calibration and History behind a **Show model inputs** checkbox at the end of the sections list. Never Applications |
| contributor, farmer, none | Summary only (a farmer is redirected to `/farm/:id`, an applicant gets the Applicant view, [§ Applications](#applications-wp-33)) |

Each tab is one entry in `TAB_GROUP` (`core`: everyone; `inputs`: the model
inputs; `assess`: the assessors' Applications list, owners and editors
only), so adding a tab is one line; a tab the table doesn't know counts as
an input, and a tab the page doesn't render is dropped. Summary can never be
hidden. Whether a viewer starts with the inputs shown is one constant,
`VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT` (`false`; a client question). The
checkbox isn't saved: it resets when the project is opened again.

This is **presentation, not access control**: RLS still lets a viewer read
every input. A deep link to a hidden tab (`?tab=settings`, or an alias) still
opens it, and the sections list then shows that tab in its place while it is
open (`stripTabs`), so you can see where you are. The one exception is
Applications, which the API refuses a viewer: a viewer's `?tab=applications`
link opens the Summary instead of an error (`canOpenTab`). The Summary's checklist keeps a
hidden tab's step and its status, but as plain text rather than a link; the
Project page's headline facts still link to their tabs (a deep link, as above).

**Your own sections** (`workspace/SectionsMenu.svelte`,
`e2e/tests/own-sections.spec.ts`). Within what the role shows, each person
hides the sections they don't use. The **Choose sections** button (icon only
on the sidebar's "Catchment" line, in words at the foot of the phone's
Sections menu; "Hidden (n)" once some are hidden) opens a dialog with a
checkbox per section the role shows here, opening right beside the button
(centred on a phone), grouped as the sidebar is (the groups side by side,
one column on a phone), with **Reset to default** and
**Done**. Summary is always shown (its box is ticked and disabled). The
choice is the account's (`user.preferences.hiddenTabs`, `PATCH /auth/me`,
[api.md § Auth](./api.md)), so it applies in every catchment and on every
device; each change saves at once, in order, with the boxes kept live (a
failed save says so and holds until a reload). It goes through `prefs.hidden`:
`visibleTabs` drops those tabs after the role's own filter, so hiding only
takes away, and `hiddenTabs` counts only the hidden ones the role would show
here (a viewer's hidden Transfers counts only while the model inputs are
shown). A hidden section still opens from a link and then shows in its place
while open (`stripTabs`), and the Summary's checklist still links to it (it
gets the role's tabs, not yours).

The model tabs (Network, Crops, Transfers) edit one in-memory model
(`lib/model/editor.svelte.ts`) and share the fixed save bar at the bottom.
Settings has its own save button, which sits above that bar.

**A part that fails to download.** Every tab but Overview, the Add data
dialog and several panels download on first use. If one can't (a network
blip, or a new release that removed the old file), it says "This part of the
page could not be loaded. Check your connection, then reload the page." with
**Reload page**, in place of the part. There is no "Try again": the browser
won't fetch a failed file again until the page reloads. With unsaved model
edits (or a scenario's unrecorded overrides) it adds "You have unsaved
changes: save them first, or the browser will ask before the reload discards
them."; the save bar is still there, and **Reload page** meets the same
"leave site?" prompt as closing the tab. Nothing reloads by itself. The
project list's import dialog and its workbook reader, Overview's alert email
settings, the printable report, the run's workbook download (below the
Download menu), the account's data download, the "confirm your email"
banner (in its place, rather than vanishing) and the language of the
translated pages say the same, naming what failed
([architecture.md § Code splitting](./architecture.md#code-splitting-frontend)).

**Popups and Escape.** Every popup closes on Escape: help tips (ⓘ), the
account menu, the "Rain up to" dropdown, the download menu and the dialogs.
Help tips, the account menu and the "Rain up to" dropdown also close on a
click outside. The one exception guards
unsaved input: while **Add data** holds a file that is read but not uploaded
(or is uploading), Escape and ✕ ask before discarding it. Help-tip bubbles
render in the browser's top layer (a manual popover placed against the
button), so a scrolling table or a sticky header can't clip or cover them.
Every `Dialog.svelte` dialog also has a **✕** in its top-right corner
(`aria-label="Close dialog"`, tooltip "Close (Esc)") for people who don't know
Escape closes it. It is last in the DOM, so opening a dialog still focuses its
first field (New project, New team).

**Long tables.** A `.table-wrap` table (app.css) scrolls inside its own box,
capped at 70 % of the window, and its whole `<thead>` is sticky, so the header
stays in view while you read down a long table (the network table with many
nodes, the curtailment table). The whole header sticks, not each cell, so a
two-row header (group labels over the column names) stays stacked. A table
shorter than the cap looks as before.

## Section header

Every section has **one header** (issue #17, option A; `workspace/SectionHeader.svelte`),
drawn by the page above the open tab, in place of the old project row (name,
role, freshness, Add data) and each tab's own header:

- **The title** is the section's name (`TAB_LABELS`), the page's only `h1`.
  **Unsaved changes** shows beside it while the model has edits (editors).
- **A one-line context** under it. A tab gives its own through
  `fillHeader({ context, actions })` (`workspace/headerSlot.svelte.ts`,
  called from an `$effect`, like the sidebar's slot): the Summary names the
  run it shows (label, workbook-comparison and evidence badges, period,
  engine, "ran N days ago", **Open in Runs**); the Network its summary
  ("8 farms · 8 dams · 2 gauges · draining to … · 184.0 km²"); Crops its
  line ("3 crops · 675 ha irrigated on 8 farms · …"); Settings & calibration
  where the runoff parameters came from; Runs & results its run count and
  when the newest ran; River & reserve the run it shows (label, badges,
  period, engine, the EWR rule); Hydrological units, Dams, Scenarios,
  Allocations, Project and Applications a summary of what they hold; History
  the latest change, by whom and when. The others count what they hold (`workspace/context.ts`):
  "2 runs" on Compare runs, "4 input series · 1 behind",
  "3 transfer rules · 2 active", "No runs yet" on a Summary before the
  first run.
- **The actions on the right**, in this order: the **Rain up to** pill
  (below), the section's own (the Network's **Grids** and **+ Add node**,
  Crops' **Grids** and **+ Add crop**, Transfers' **Show on the map** and
  **+ Add transfer**, Data's **Preview all data**, Settings & calibration's
  **Fit the parameters** (a viewer: **Fit record**, when there is one),
  River & reserve's **Run** menu and **Open in Runs & results**, Units &
  supply's run menu and **Open in Runs**, Dams' **Open in Runs**, Scenarios'
  **+ New scenario**, Allocations' run menu, **Download CSV**, **Import** and
  **+ Add volume**, Project's **Download** menu, Applications' **Decide the
  longest waiting**), **Add data** (editors), and **Run
  model** (editors; on the Summary, Network, Crops, Transfers and Settings).
  Run model starts a run with no label and opens it in Runs, through the
  same `startRun` as the new-data line's Re-run model. On Runs & results the
  tab's own run form (**Run label**, Run forecast, Run model) takes its place,
  last, after a plain Add data (`fillHeader({ main })`, the header slot's
  `main` part), and on Data **Add data** is the main (primary) action. Run model is
  disabled until there is a network and a rainfall series, and its
  accessible description says which is missing. A tab shown inside the grid
  modal or scenario override mode fills nothing.
- **Notices, one slim line** under the title row, instead of full-width
  banners: the viewer's **View only** note (every section), the upload
  result with **Re-run model** / **Dismiss**, **New data since the last
  run** with **Re-run model** (not on Runs or Data, which say it in their
  own way), and a run that didn't start. Every message and action of the
  old banners is kept. The model save bar stays the dock at the bottom
  (Save changes, Discard, the reason), and the grid modal and sheets keep
  their own `ModelSaveRow`.
- **The groups:** `SectionHeader` takes the pill as `status`, the tab's
  controls as `actions` and the page's pair (Add data, then Run model or the
  tab's `main`) as `main`. Wide, the pill and the tab's controls add no boxes,
  so all of it is one row beside the title (under it when it doesn't fit, as
  on Allocations at 1440); the pair is one box, so a wrap never splits it.
  The title column asks for its context's full one-line width (and no more:
  a 16rem floor made a short one wrap its controls under it in a wide font,
  Data at 1024 in DejaVu Sans), so the controls sit beside the title only while the context
  fits on one line there; a longer context puts them under the title instead
  of wrapping to 3–4 short lines in a narrow column (River & reserve for a
  viewer at 1440 and Compare runs at 1024 did). A context that fits keeps the
  header as it was. `section-header.spec.ts` pins at most 2 context lines at
  1440/1280/1024, and 1 whenever the controls are beside it.
- **Phones (a header 640 px wide or less, a container query):** the same
  header after the Sections button. The pill is a line of its own (its list
  opens rightwards, on the screen); a picker (a run select) takes a full row;
  the tab's buttons and the pair then fill full rows, every control growing to
  fill its row, and Add data and Run model always end the header side by side
  (Transfers fits all three on one row; Settings puts Fit the parameters on
  one row and the pair on the next). Runs' run form is a row of its own under
  Add data. Targets are 44 px. `e2e/tests/workspace-phone.spec.ts` pins this
  on every section with a big catchment, plus the overlays' phone scans (node
  sheet, node table, Allocations' sheets, New scenario, Add data, the
  Sections menu).
- **Compare runs** draws no title of its own in the workspace: it gives the
  header its context ("Baseline “…” against one what-if · …"); the
  standalone `/compare` page keeps its own `h1`.

## Header: data freshness and "Add data"

- **Rain up to 14 Jun 2026 · 12 days ago**: the latest end of the
  **recorded rain** (catchment or CHIRPS, `isRecordedRain`), which is what a
  run is driven by. A forecast runs into the future and observed flow only
  scores a run, so neither counts: either would read "up to date" while the
  rain lags. With no recorded rain it reads "No recorded rain yet". Click it
  for every series' end date. It turns amber when the recorded rain is more
  than 7 days old (`STALE_DAYS` in
  `series/freshness.ts`; a candidate for a project setting). Ages count
  calendar days up to the viewer's **local** date (`localIsoDate`); the
  project list's badge (`projects/freshness.ts`) counts the same way from its
  own `daysSince`, so the two never differ by a day around midnight. Series
  dates are calendar days, so the UTC date would be wrong for anyone east or
  west of UTC.
- **Add data** (editors) opens the upload form in a dialog on any tab
  (`series/AddDataDialog.svelte`, the shared `common/Dialog.svelte`, wide).
  Dropping a CSV anywhere on the page opens it with that file. The form's
  buttons sit in the dialog's action row, on the right: **Cancel** and the
  upload button (**Upload**, **Upload and merge** or **Upload and replace**;
  `UploadForm`'s `external` mode, the button submitting the form through its
  `form` attribute). With a file read but not uploaded, **Cancel**, the close
  button and Esc ask "Discard the file you haven't uploaded yet?" first
  (Dialog's `beforeclose`, which handles Esc itself so Chrome can't skip the
  question). Closing gives focus back to what opened it
  (`e2e/tests/add-data-dialog.spec.ts`). It reads a
  date,value CSV (comma, semicolon or tab; decimal point or decimal comma,
  decided per file) or a DWS hydrology export (fixed-width YYYYMMDD with a
  quality code, gap codes and -999 read as gaps): see [Data](#data) below for the
  rules. The form's **File formats** note lists them.
- The upload form (`series/UploadForm.svelte`) guesses the series a file
  updates from its name and header (`guessSeries`). An existing series
  defaults to **append / update** (`POST /projects/:id/series/merge`): new
  days are added and overlapping days corrected. Days the file leaves blank
  keep their stored value. The preview counts new, changed and unchanged
  days before anything is sent, and warns about **blank days** between the
  series' last value and the file's first day (`coverage.ts` `holeBefore`):
  the merge stores them as blanks, and a run treats a blank rain day as dry.
  **Replace** overwrites the whole series.
  **Overwrite confirm** (issue #54 item 3): an upload that would change
  stored days (a merge with changed days, or a Replace of a series holding
  values) asks first, in place of the submit button. It says how many days,
  between which dates, and has a **Show the changes** table (date, stored,
  from the file, in the stored unit, the first 100). It notes that the
  replaced values can be restored from History, and its button says
  **Overwrite N days** / **Replace N days**, next to **Back** (in the Add
  data dialog these take the action row's place: Cancel turns into Back and
  keeps the focus). A merge that
  only adds days uploads straight away. Changing the file, the mode, the
  series or the unit takes the question back. There is no confirm on the
  machine `/ingest` API: loggers re-send days on purpose.
  **Unit** is a list of the units the kind accepts (`unitOptions`: m³/s, l/s,
  m³/day, m³/h, ML/day for flow; mm, cm, in for rain), the kind's own first;
  any other says "Values in l/s are converted to m³/s when saved", and the
  server stores the converted values (api.md § Units). The merge preview
  converts the file to the stored unit before it compares
  (`series/upload.ts` `inStoredUnit`), so an l/s file that repeats stored
  days counts them as unchanged. The file is sent as it is: the server keeps
  the stored value of a day the file leaves blank, under the row lock, so a
  stale copy in the browser can never write old values back. The Data tab,
  the preview and the fit-period proposal share one cache of stored values
  (`series/valuesCache.ts`), used only while the series' start, length and
  `updatedAt` still match, so a same-length change (a restore, a feed
  correction) is fetched again.
- After an upload the header's notice line offers **Re-run model**. Every tab
  but Runs and Data notes new data since the last run there: a rainfall series
  that reaches past the latest run's end, or was updated after it
  (`newDataSinceRun`).
- **Automatic runs** (WP-2.11): when the project has them on and a re-run is
  queued (`project.rerunQueuedFor`, and the upload's own answer), both
  notices say "An automatic re-run is queued for 14:05." (the viewer's local
  time; "… for 27 Sep 00:05" on another day; "… is due now." once its time
  has passed) instead of offering **Re-run model**
  (`autorun/autoRun.ts` `rerunQueuedText`). The page doesn't poll: the run
  shows in the Runs list on the next load.

## Summary

The tab a project opens on (id `overview`, no `?tab=`; `?tab=summary` is an
alias). It was called Overview until issue #17 (option A · Results first)
put the results first; its first screen follows board A1 of the redesign
(issue #17, "option A's simplicity, nothing lost"). Top to bottom:

1. **Before the first run**, the setup checklist (`overview/checklist.ts`)
   leads, then Needs attention: there is nothing to summarise yet, so there
   is no KPI row, chart or supply list.
2. **The first screen, once there is a run**: the **Latest run** KPI row
   (four cards, the mean outflow in the line under them), then two columns:
   the **Flow vs reserve** chart on the left, and on the right (a column
   280–340 px wide) **Needs attention** above **Supply by farm**. From
   1100 × 620 px (`FIT_QUERY` in `OverviewTab.svelte`) the block is exactly
   the height left in the window below its own top edge (measured with a
   `ResizeObserver` on `body`, as the Network's map, less the save bar
   when it shows; at least 560 px): the chart fills what the KPIs leave, the
   side column's cards scroll inside themselves, and the page doesn't need
   scrolling to see any of it. Narrower, the columns stack and the chart is
   240 px tall; on a phone the KPIs are 2 × 2.
3. **Below the first screen**, compact: the active alerts
   ([§ Alerts](#alerts)) beside the published baseline (two columns once the
   tab is 56rem wide, a container query; stacked below that), each panel
   unchanged; one line of links, **Dam levels for each dam → Dams** (once the
   latest run has dams; the table moved to the [Dams](#dams) page) and
   **Model facts, details, team and sharing → Project**; then the setup
   checklist, the one-line "Setup complete" once every step is done. The
   model's headline facts, project details, import record, recent notes,
   team, members, farmers and share links moved to the [Project](#project)
   page (2026-09-27, issue #17). A link to one of their panels' old
   fragments on the Summary (`#details-h`, `#import-record-h`,
   `#recent-notes-h`, `#team-h`, `#members-h`, `#farmers-h`, `#share-h`,
   and `#model-h` for the facts; `project/links.ts` `PROJECT_ANCHORS`) is
   sent there, replacing the history entry so Back skips it.

- **Flow vs reserve** (`overview/FlowVsReserve.svelte`), once the latest run's
  record is in: the Runs tab's *EWR vs simulated outflow* chart
  (`runs/flowSeries.ts` `ewrChartSeries`, log axis at first) with a
  **30 days / 1 year / All** switch (LineChart's `windows`: each window ends
  on the run's last day, it opens on a year, the pressed button is the window
  shown and a drag-zoom releases it), shading a forecast run's forecast days.
  The **days below the reserve are shaded** (LineChart's `shade`), from the
  run's own `ewr_shortfall` series (`overview/summaryChart.ts`
  `belowReserve`: negative on a day the engine counted as EWR not met), so
  the caption's count ("Shaded: the 23 days the outflow was below the pragmatic
  EWR line") is the EWR card's; a run that always met it says so. When the
  outlet has a Reserve rule table the chart also draws its requirement
  (the run's catchment-level `ewr_rule` series, `EWR_RULE_KEY`) as a second
  step line, *Reserve rule requirement*, and the caption says it is each
  month's requirement judged month by month, so the chart shows the line the
  "Reserve rules met" headline is judged by, not only the pragmatic EWR
  (issue #51; the printed report's EWR chart too). A rule table at another
  site isn't drawn: this chart's flow is the outlet's. On the
  first screen it fills its panel (`fill`: the plot gets the panel's height
  less the chart's own head, legend and caption, measured from the drawn
  chart). It is its own chunk, since it pulls in uPlot, so the page's first
  paint doesn't wait for it. Its series come through the Runs tab's
  `cachedSeries`, and it fetches only the series the run stored ("This run
  stored no outflow or EWR series." otherwise). Beside its heading, **More on
  River & reserve** opens [River & reserve](#river--reserve) for that run
  (`riverHref`, `river/links.ts`), where the same chart is larger.
- **Supply by farm** (`overview/SupplyByFarm.svelte`, rules in
  `overview/supplyBars.ts`): every farm in the latest run with a bar and the
  % of its demand supplied, fullest first and emptiest last, in the Network's
  supply bands (`network/supplyColour.ts`: amber below `SUPPLY_TARGET`, red
  below `LOW_SUPPLY`, with a key; a farm with no demand says "no demand"
  and goes last). A farm's name opens its [farm drawer](#farm-drawer)
  (`farmDrawerHref`), unless it has left the model since the run. Beside its
  heading, **More on Hydrological units** opens [Hydrological units](#hydrological-units)
  for that run (`supplyHref`, `supply/links.ts`). Under the heading, one line
  says what the bars measure ("Share of each unit's irrigation demand
  supplied, latest run"). Its own chunk (it waits for the run's record
  anyway).
- **Dam levels** moved to the [Dams](#dams) page (2026-09-26, issue #17):
  the Summary keeps only the **Dams today** card (which links there) and the
  one-line link below the first screen. `OverviewTab` reads the card's
  levels from the run summary (`FarmSummary.dam*`, engine ≥ 1.2.0, issue
  #55, [model.md §2.8](./model.md#28-outputs); `damLevelsFromSummary`), and
  fetches each dam's series (`loadDamLevels`) only for an older run.

- **Latest run** (`overview/LatestRun.svelte`, rules in
  `overview/latestRun.ts`), shown once the project has a run. It is the
  **newest run by `createdAt`**, even when an older run is the nominated
  evidence: the Summary answers "what does the model say now?", and only
  the newest run reflects the latest data and edits. When the evidence run is
  a different run, a line under the context names and links it, so the two
  can't be confused. A context line gives the label, the run period
  (`fmtDay`, e.g. "1 Oct 2021 – 28 Jan 2022"), the engine version and "ran …
  ago" (`describeAge`, by the viewer's calendar), with badges for a legacy run
  (a stored run from before engine 1.0.0: *Workbook comparison*, plus a note
  that its figures are for workbook comparison only, not evidence, and that
  engine 1.0.0 removed the model, so it can't be re-run and a new run uses
  GR4J) and the evidence run. **Open in Runs** links
  to `?tab=runs&run=<id>`. Four cards, the same figures and labels as the Runs
  tab's headline (`RunSummaryView.svelte`): *Reserve rules met* (the rule-table
  site from `headlineSite`) or, without a rule table, *EWR not met* (days below
  the pragmatic EWR); *Irrigation supplied* (% of all farms' demand, with "N of
  M farms below" `SUPPLY_TARGET`); *Calibration NSE* ("calibration period
  (in-sample)" only when the parameters were fitted on those days, otherwise
  why not, as on the Runs tab; "–" without observed flow). They show in the
  order Reserve · Irrigation supplied · **Dams today** · NSE. *Dams today*
  (`latestRun.ts` `damsHeadline`, `damLevels.ts` `damsToday`) is all dams'
  storage at the end of the run as a share of their total capacity (weighted
  by capacity), with its change over the run's last 30 days ("▼ −9 pp in 30
  days"; none when the run is shorter), flagged below 30 %; it reads the
  run summary's dam figures (engine ≥ 1.2.0, issue #55), or for an older run
  each dam's `dam_storage` series through the Runs cache, when it says
  "loading dam levels" until they are in; "no dams in the run" without any. The card links to the [Dams](#dams) page: its term is a link
  (`Headline.href`, `DAMS_HREF`) stretched over the whole card, as the model
  facts' tiles are. *Mean simulated outflow* (m³/s, % of natural) is a short
  line under the cards, linking to [River & reserve](#river--reserve), which
  has it as a tile with its change; then the run the changes are against. Each
  card shows its change from the previous run (the one before it by
  `createdAt`) with the compare page's `Delta` (sign, ▲/▼ and a spoken
  better/worse, so colour is never the only cue), only when both runs have the
  figure: the Reserve only at the same site, the pragmatic EWR only when
  neither run headlines a rule table. The full records come through the Runs
  tab's `detailCache`, so only this section shows a loading or error state
  (`LoadState`, with a retry) and the Runs tab then opens the run at once. Four
  cards in a row, 2 × 2 below 760 px.
- **Published baseline** (WP-2.3, `overview/PublishedBaseline.svelte`),
  below the first screen, after the active alerts (shown with or without runs): what stakeholders and farmers see. It fetches
  `GET /projects/:id/publication` and names the published run (a link to it
  in Runs, with its period from the page's runs list), when and by whom it
  was published, the notice level with its percentage ("Advisory · 15 %"),
  the notice in each language the WUA wrote it in (named in its own
  language, the text marked with its `lang`), and the next expected update (a calendar
  day, `fmtDay`). It is read-only for everyone: editors get **Change the
  notice or publish another run**, a link to the Runs tab on the published
  run at its Publication panel (`?tab=runs&run=<id>#res-publication`), so
  the notice has one editor, not two. With nothing published: "No run is
  published yet. Stakeholders and farmers see nothing until you publish one
  (Runs tab)." Its own `LoadState` (loading, an error with a retry).
  **New auto run: publish?** (WP-2.11, editors): when the newest automatic
  run is newer than the published run (`autorun/autoRun.ts`
  `autoRunToPublish`), the card names it with **Compare with the published
  run** (the Compare runs tab, published run as A) and **Review and publish**
  (the Runs tab on the auto run, at its Publication panel). Publication stays
  a person's act unless the project chose "Publish if there are no new
  warnings" in Settings; nothing here publishes.
- **Needs attention** (`overview/NeedsAttention.svelte`, rules in
  `overview/attention.ts`): a card per item, hidden when there is nothing.
  Each card has a short title ("1 of 2 farms below 95%"), a one- or two-line
  detail and its link; the link covers the whole card, and a second link sits
  above it. The card is coloured by its `tone`: red when the worst short farm
  is below `LOW_SUPPLY`, amber for a short farm above it, run warnings and
  stale data, grey for new rainfall and unplanted farms (the title always says
  what's wrong, so colour is never the only cue). Items: farms below `SUPPLY_TARGET` in the latest run (the
  worst named, links to [Hydrological units](#hydrological-units) for the run with the
  worst unit picked (`?tab=supply&run=<id>&unit=<nodeId>`), and, while it is still a farm in the model,
  a second link, **Its planted areas**, to the [farm drawer](#farm-drawer)),
  the latest run's warnings (the first one as the detail), rainfall the latest run hasn't used
  (`newDataSinceRun`, links to Runs to re-run), input data older than
  `STALE_DAYS` (`freshness`, links to Data), and farms with no planted area
  once anything is planted (one farm: **Set its planted areas**, the farm
  drawer; several: Crops; before anything is planted the checklist's crops
  step covers it). Run items wait for the run's summary.

## Dams

`?tab=dams` (`dams/DamsTab.svelte`, rules in `dams/dams.ts` and
`overview/damLevels.ts`), under **Outcomes** after Runs & results (issue #17,
option A · Outcomes; no board of its own, so it takes A1's cards and the
Summary's window-fitting layout). Every member who sees the Summary sees it
(`TAB_GROUP.dams = 'core'`); an applicant sees the Applicant view instead, as
for every workspace tab. Its own chunk.

- **Header**: the section header titled "Dams", with the context line
  "8 dams · 2.73 million m³ capacity · latest run “Baseline”, ran today"
  (`damsSummary`, `fmtVolume`) and **Open in Runs** once there is a run, both
  filled through `fillHeader` like Crops & demand.
- **Which dams**: a farm with a capacity of at least 1 m³ (`modelDams`). Only
  a farm has a dam in the engine; a capacity on a gauge or another water user
  is inert (no storage, no `dam_storage` series), so it is not listed, and
  the Summary's *Dam capacity* fact counts farms' dams only too. The levels are
  those of the latest run (`pickRuns`, the Summary's newest-by-date rule):
  the dams the run stored storage for (`damsInRun`, capacity and minimum
  level from the run's own model), each dam's daily series fetched through
  the Runs cache four at a time (`loadDamLevels`) and kept for the sparklines
  and the chart. On a forecast run the levels, the cards and their sparklines
  are the record's, up to the day before the forecast, like the Summary's
  (issue #51); the chart shows the forecast days in their band.
- **Cards** (`damCards`), emptiest first (the levels' order), then any dam
  without a level in node order: the name, capacity, % full at the end of the
  run, "below 30%" / "at its minimum level" in words, the change over the
  run's last 30 days in words with ▲/▼ ("down 11 pp in 30 days",
  `changeWords`), a sparkline of the last 365 days as % of capacity
  (`storageSpark`: at most 60 steps, each drawn at its lowest real day, plus
  the first and last day; the compact chart pattern, `charts/Sparkline.svelte`):
  captioned "% full over the run's last year", the window's first and last
  day under its ends, and between them the low with its day ("low 15% ·
  19 Dec 2023", the Dam levels table's *Lowest in its last year* to the day),
  marked by a dot; pointing at the line reads out that day instead, and so
  do the keys on its focused slider (from the low; End is the last day). In a
  narrow card (a phone's two columns) the low takes its own line under the
  dates. The line sits above the card's stretched link, and a click on it
  picks the dam as the rest of the card does. Then links
  **On the Network** (`?tab=network&node=<id>`, the node picked on the map)
  and **Planted areas** (the [farm drawer](#farm-drawer), `farm=<id>`, over
  this page). A coloured edge repeats the band (accent, amber below 30 %, red
  at the minimum; grey without a level). Above them, **All dams together**
  (`damsToday`, capacity-weighted: the Summary's Dams today figure).
- **Picking a dam**: the name is a link (`dam=<nodeId>`, `withParam`) stretched
  over the card, so a click anywhere on it picks the dam, the URL can be
  shared, and Back returns to the one before. Without `dam=` (or with one
  that has no card) the first, emptiest, card is charted. When the layout is
  stacked the chart scrolls into view after a pick.
- **Storage chart** of the picked dam: its storage, a dashed capacity line
  and (a farm with one) its dashed minimum operating level
  (`storageChartSeries`), as **% full** (default) or **m³**, with the
  Summary's **30 days / 1 year / All** switch (`FLOW_WINDOWS`, opens on a
  year). A line above it: % full and the volume on the last day, the lowest
  in the last year and the days at the minimum level.
- **Layout**: the cards column sits beside the chart once the page is 56rem
  wide (a container query on the page, not the viewport). When it is also at
  least 620 px tall, the block is the height left in the window below its top
  (measured with a `ResizeObserver` on `body`, less the save bar; at least
  480 px): the chart fills its panel (the plot takes what the chart's head,
  legend and caption leave) and the cards scroll inside their column.
  Narrower, the cards are two to a row on a phone, then the chart.
- **Dam levels** (`dams/DamLevels.svelte`, moved here unchanged from the
  Summary) below: every dam in the run, emptiest first, with its capacity,
  its storage at the end of the run as a bar and a % (a tick marks its
  minimum operating level, and "below 30%" or "at its minimum level" is
  written beside the %, so colour is never the only cue), the lowest it
  reached in the run's last 365 days with the first day of that low, and the
  days in that year at or below the minimum. The model keeps the minimum as a
  fraction of capacity (`damMinPct` 0.1 = 10 %) and only a farm's dam has
  one, so `damsInRun` turns it into a % (until 2026-09-26 it passed the
  fraction through, so a 10 % minimum was drawn and counted as 0.1 %). The
  first 8 rows show, with **Show all N dams**, and **Open in Runs**. The page
  keeps fetching every dam's series even though the run summary carries the
  table's figures (engine ≥ 1.2.0, issue #55), because each card's sparkline
  and the storage chart draw them.
- **Empty states**: no dams in the model says how to add one, with **Open the
  Network** and **Node table** (the grid modal over this page, where a node's
  dam capacity is set or a node added; a new dam shows as a card at once).
  No run yet: the cards show each dam's capacity only, under a note linking
  to Runs & results to run the model (a viewer is told an editor has to run
  it), with no chart or table.

## Project

`?tab=project` (`project/ProjectTab.svelte`; aliases `details`, `members`,
`sharing`), first under **Review** (issue #17, option A): what the project is
and who can open it. Every member who sees the Summary sees it
(`TAB_GROUP.project = 'core'`, no model inputs needed); an applicant sees the
Applicant view instead. Its own chunk. Everything on it sat below the
Summary's first screen until 2026-09-27 and moved unchanged (the panels'
files moved from `overview/` to `project/`); the Summary links here and
sends its old `#…-h` fragments here ([§ Summary](#summary)). A reading page:
it scrolls, and isn't fitted to the window.

- **Header**: the section header titled "Project", with the context line
  "Personal project · created 3 Sep 2026 · time zone Africa/Johannesburg"
  (or "Team “North WUA” · …"; `project/project.ts` `projectContext`) and
  **Download** (Download project (JSON): the model, settings and input
  series; every member, viewers included), both through `fillHeader`. The
  download menu was in the Project details panel's head.
- **The model**: eight headline facts (units and gauges, catchment area, dam
  capacity and farm dams, irrigated area and crops, active transfers, time
  series, model runs, the outflow gauge), counted from the page's lists and
  the model as edited, so an upload or a run shows at once.
- **Fragments**: `?tab=project#members-h` (any id in `PROJECT_ANCHORS`)
  waits for that panel's heading, scrolls it to the top and holds it while
  the page settles (`holdAnchor`), with focus on the heading. History's
  "farmers to link again" notes link to `#farmers-h`.
- **Headline facts** each link to the tab where they are edited or looked at
  (farms, area, dams and the outflow gauge to Network, irrigated area to
  Crops, transfers to Transfers, time series to Data, runs to Runs). The
  whole tile is the click target (the label's link is stretched over it), and
  a focused tile gets an outline.
- **Import record** (`project/ImportReportPanel.svelte`, 017_project_import),
  under Project details, only for a project imported through the import dialog
  (it fetches `GET /projects/:id/import-report`; a `404 no import report`
  shows nothing). "Imported from the b023 workbook *file* on *date time* by
  *name*.", the importer and web build, then the review's two lists, shared
  with it (`import/ImportReportLists.svelte`): **Importer notes** and the
  **Unmapped report** (a workbook's only), each with its count sentence and
  the list behind a *Show the N notes* / *Show the N items* disclosure, closed
  at first. Items the client trimmed past the caps show as "And N more …, not
  kept." Every member sees it, viewers included, so a reviewer or assessor
  can check what the importer interpreted long after the import. All the text
  came from the file and renders as text only.
- **Time zone** (Project details, under Description; issue #45): the
  project's IANA zone, `Africa/Johannesburg` unless changed, typed or picked
  from the browser's list of zones, saved with **Save details** (editors;
  read-only for viewers). Every download of the project (CSV, JSON, the
  .xlsx workbook, the server report PDF) is dated by the calendar day there,
  so an export made just after local midnight carries today's date, not
  UTC's yesterday. The same day dates what the server counts for a person:
  the portfolio's ages, the feeds' health, the farm page's "not recent"
  notice and forecast date, and the alerts (their "today" and the 06:00
  digest). A zone the server doesn't know is refused with its error.
- **WUA name** (Project details, under Time zone; issue #74): the name of
  the Water User Association the farm pages tell a farmer to contact
  ("Questions? Contact Vaalbank WUA."), saved with **Save details**
  (editors); empty keeps "your WUA". Not the team's name, which may be a
  consultancy's.
- **Layout**: the facts in one row of eight (4 × 2 on a narrower page, 2 × 4
  on a phone), then Project details, the import record, recent notes and
  recent changes on the left; on the right, "who has access": Team above
  Members (or "Shared directly with" for a team project), so the two panels
  that refer to each other sit together, then **Farmers** and share links. The columns answer to
  the page's width (container queries on `project-page`: two columns from
  about 760 px of page), then one column in the order facts, details, import
  record, notes, changes, team, members, farmers, share links.
- **Recent changes** (`project/RecentChanges.svelte`, issue #42): the three
  newest saved changes to the model or settings
  (`GET /history?kind=revision`), each in one line with the History tab's
  wording (`project/recentChanges.ts`: "Model changed: Upper farm: dam
  capacity 150,000 m³ → 180,000 m³ and 2 more"), then who, when and the
  save's reason, and a link to the History tab. Shown only to members who
  have the History tab; reloads after a save of the model (the save bar) or
  of the settings or details. e2e: `e2e/tests/history.spec.ts`.
- **Members**: each applicant row has an **Applying party** box for owners
  (saved on change; blank for none): an applicant shares applications only
  with the members of their own party, so put an applicant and their
  consultant or client in the same one. Others see the party as text.
- **Farmers** (WP-2.1, `project/FarmersPanel.svelte`): each farmer with the
  farms linked to them, by name. Owners change a farmer's farms and remove
  one, and **Invite farmers** (WP-2.2, `project/InviteFarmersDialog.svelte`, its own chunk, fetched on first open)
  opens a dialog with two modes: *One farmer* (email, a tick box per farm,
  **Joins as** *Farmer* or *Applicant*, and for a farmer the email's
  language; an applicant is a licence applicant who holds those farms,
  WP-3.3, invited with the ordinary English invite email and badged
  "applicant" in the pending list) and *Several, from a CSV* (`email,farm,language`,
  one farm per row, pasted or uploaded, header optional; parsing in
  `project/farmers.ts`). A CSV is previewed first: a table of every row's
  line, email, farm and what will happen (added, invited, or the row's
  error), from a server dry run that sends nothing; **Send** then does it and
  the table shows the results. A verified account is added at once; anyone
  else is invited and listed under **Pending farmer invitations** (owners
  only) with their farms, who sent it and when it expires, with Resend and
  Revoke. Empty state: "No farmers yet: invite them to see their own farm."
  Farmer invites stay out of the Members panel's pending list.
  Farmers aren't in the Members list (it hides the `farmer` role), and a
  farmer never sees this page: their own view is WP-2.6. A link to a farm
  deleted but not yet saved reads "a removed farm".
- **Share links** (WP-2.3 phase 2, `project/ShareLinksPanel.svelte`, rules
  in `project/shareLinks.ts`), owners only, under Farmers: read-only links
  to the published baseline for people outside the project. *Make link*
  takes who it's for (up to 100 characters) and how long it works (1 week,
  30 days, 90 days or 1 year); the new URL shows **once**, in a read-only
  field with **Copy** (it falls back to selecting the field when the
  clipboard is refused), because the token isn't kept. The list shows each
  link's label and state (Live, Expired, Withdrawn), who made it and when,
  when it ends or who withdrew it, and when it was last opened (to the
  hour), live links first. **Withdraw** asks first, then the link shows the
  dead-link state to whoever holds it. With nothing published, a note says
  a link opens only once a run is published.
- On the **Network** tab, a farm with linked farmers says how many in its
  detail panel, and removing it asks first, naming the farmers who lose
  access when the model is saved.
- The **description** box grows with its text (up to about 24rem; on a phone, where every line wraps, with no cap) instead of
  hiding it behind an inner scrollbar (`field-sizing: content`; browsers
  without it keep four rows).

Email addresses (member rows here and on team pages,
pending invitations, the confirm-email banner) render through
`common/EmailText.svelte`, which lets them wrap before the `@` and after `.`,
`-`, `_` or `+` rather than mid-word on a phone.

## Project list

`/` (`routes/+page.svelte`, issue #17) answers "which of my catchments need
me?" on the first screen, then lists every project you can see. Its header
has the title, one line with the count and the EWR status of the catchments
in view ("50 catchments · EWR, last 30 days: 2 red, 1 amber, 18 green"),
and **Import b023 workbook**, **Import project file (.json)** and **New
project**. Both import buttons open the same dialog; the button only
sets its wording and what the file picker offers, and the picked file's type
decides how it's read, so a workbook picked from the JSON button still works.
Two buttons rather than one "Import…": the client looks for a named workbook
import, and the two sources explain themselves differently (a workbook's
review has options and reports a `.json` file doesn't). The dialog downloads
on demand (hovering or focusing a button starts it); if that download fails,
the list says so and offers **Reload page**
([architecture.md § Code splitting](./architecture.md#code-splitting-frontend)).

**Figures.** Each row carries the [portfolio](#portfolio-teamsidportfolio)'s
figures for its project, from `GET /projects/outcomes` ([api.md §
Projects](./api.md#projects)), which covers personal and shared projects as
well as team ones and loads beside the list (the rows show first, with
"Loading…" in the figure cells; a failed request says "Figures unavailable"
and the list still works). The wording comes from the portfolio's helpers
(`portfolio/portfolio.ts`, `StatusPill`), so a catchment reads the same on
both pages. Columns: **Catchment** (the name, then owner/team for *Shared
with me*, your role and the updated date, and the description on one
line), **EWR, last 30 days** (the pill in words and colour, and *Published*
or *Latest run* with the figures' last day), **Hydrological units short** ("2 of 8 units
short this week", a link to that run's curtailment on Hydrological units;
*Not published* until a run is published), **Lowest dam**, **Data** (the
rain freshness badge, *Newer rain not in the figures*, the feeds' health)
and **Last run** (its age, then the date or when it was published). A
project where your role is farmer or applicant has no figures ("Not shown
to your role").

**Needs attention** (`projects/NeedsAttention.svelte`, rules in
`projects/outcomes.ts` `attention`): the catchments in view to look at
first, most urgent first: a red EWR, hydrological units short this week, alerts firing,
an amber EWR, failing or stale feeds, newer rain than the figures, figures
over 7 days old (the portfolio's *stale*). Up to four cards (two a row on a
mid-width page, three stacked on a phone), each naming its reasons in words
with the colour only repeating them; the count says "3 of 50", and **Show
all N, most urgent first** (or **Sort the list by it**) sets
`?sort=attention`. With nothing flagged it says so in one line; a catchment
that hasn't run is not flagged.

**Filter, search, sort, all in the URL.** The owner filter is a row of chips
(All projects, Personal, each team, Shared with me, with counts, and
**Manage teams**), or a select when the page is 600 px or narrower. Search
matches name, description and team (`?q=`). Sort (`?sort=`): *Recently
updated* (the default), *Needs attention first*, *EWR status* (worst
first), *Hydrological units short*, *Lowest dam*, *Last run* (newest first), *Name*,
from the Sort select or a column heading (`aria-sort`); an outcome sort puts
rows without figures last. Old links (`?owner=`, `?sort=name`, `?new=1`)
still work. With *All projects* the list is grouped (Personal, each team
with its **Portfolio** and **Team members & settings** links, Shared with
me), one table per group with the same fixed columns.

**Fits the window** from 900 × 620 up, like the portfolio: the list's card
takes at most the height left below the strip (its top and what sits below
it, measured by a `ResizeObserver` on `body` and the page's `<main>`; below
is measured to the end of `<main>`, not the document's height, which counts
the empty window under a short list and left the card at its 320 px floor
after a search was cleared), the groups scroll inside it
with each table's header stuck, and the page keeps a 1 rem gutter and
doesn't scroll; a short list just ends. `.groups` is `position: relative`
so its visually hidden captions stay inside the scroll box (without it they
scrolled the whole page, ui-playbook § 2). On a phone the page scrolls.

**Layout answers to the space it has, not the window** (container queries).
Each table (`ProjectTable.svelte`, container on its wrapper) folds Lowest
dam and Last run into a line under the name at 1100 px or narrower (a
1280 px window beside the app sidebar), and at 730 px every figure: the
pill, units short, the freshness badge, the last run and the lowest dam
stack under the name, with Add data and ⋯ stacked on the right.

**A click anywhere on a project's row opens it.** The name link stretches
over the row (`ProjectTable.svelte`, `.name::after`), so it's a real link:
Ctrl/Cmd-click or a middle click opens a new tab, and the keyboard and screen
readers still meet one named link per row. The row's team link, units-short
link, Add data, the ⋯ button, and the freshness and run figures (whose
tooltips explain them) sit above the stretch and keep doing their own thing.

**Row actions.** **Add data** (editors and owners) opens the workspace with
the upload dialog (`?add=data`). The **⋯** button ("More actions for
*name*") opens a small disclosure menu with **Copy…** (anyone) and
**Delete…** (owners); it's drawn `position: fixed` so the scrolling list
never clips it, opens upward near the window's bottom, and closes on
Escape (focus back on ⋯), a click outside, focus leaving, a scroll that
moves ⋯ (not the one that brought an off-screen ⋯ into view: its event
arrives a frame after the menu opened) or a resize. One menu is open at a
time.

**Delete** asks for confirmation, then deletes. A project that has nominated
an evidence run is kept for good (issue #43, [data-model.md](./data-model.md)
§ Evidence nomination), so the server answers `409`; instead of the raw error
the page opens a **This project can't be deleted** dialog
(`lib/components/projects/deleteRefusal.ts` reads the answer). It names the
evidence run, says the nomination history is kept so the evidence can still
be read and reproduced, and that a nomination can be replaced but not
withdrawn; it links to the run (**Open the evidence run**, the Runs tab) and
offers **Copy project**, which opens the copy dialog for a fresh start
without the runs and their nominations.

`e2e/tests/projects.spec.ts` covers the figures, the strip, the URL round
trips and Back, the menu from the keyboard, a viewer, and fifty projects
(the fit at 1440 × 960 and 1280 × 800, the phone, and a11y scans).

### Import a project file

The import dialog (`lib/components/import/ImportProjectDialog.svelte`, WP-1.8)
turns a project document into a new project through `POST /projects/import`:

1. **Pick** a `.json` file: a project's *Download project (JSON)* or the
   workbook importer's `project.json`. It's read in the browser
   (`import/projectFile.ts`); a file that isn't JSON, isn't a project document
   or is over the 5 MB cap is refused here, before anything is sent.
2. **Preview** (`ImportPreview.svelte`): the importer's notes first (for
   example, a file with no time series, or an export's notes, which aren't
   imported and aren't sent), then the name (editable, prefilled
   from the file), *Belongs to* (only when you're a member or admin of a team;
   preselected when the list is filtered to one), what's in the file
   (farms, gauges and other water users, crops and planted areas, transfers,
   and a table of the time series with their days and dates) and *Run the
   model after importing*.
3. **Importing:** a status line; the controls are disabled.
4. **Done:** "Imported *name*", plus "Its first run is ready on the Runs tab"
   after a run, or a warning with the reason when the run failed (the project
   is still imported). *Open project* goes to it; the list behind has already
   reloaded.
5. **Failed:** the server's message (zod or model problems are listed) and
   "Nothing was created." When the server couldn't be reached, it says the
   import may or may not have gone through and to check the list first. *Back
   to the preview* keeps the file and choices.

The dialog is the wide variant: full width less the page gutter on a phone.
Its preview and submit steps take an already-parsed document
(`ParsedImport = { file, notes }`), so a second source only has to produce
one; `ImportPreview`'s `extra` snippet takes whatever else that source shows.

### Import a b023 workbook

**Import b023 workbook** (WP-1.31) turns a Water Balance Tool b023 `.xlsm` or
`.xlsx` into a project with no Python. The workbook never leaves the browser:
it's read in a Web Worker (`lib/spreadsheet/import/import.worker.ts`, loaded
only now; [architecture.md § Code splitting](./architecture.md#code-splitting-frontend)),
and only the extracted project is sent to `POST /projects/import`, like a
`.json` file. The view logic is `import/workbookFile.ts`; the review's
workbook part is `WorkbookReview.svelte`.

1. **Pick** the workbook (up to 150 MB).
2. **Reading:** a progress bar and "Reading sheet *Flow data* (7 of 9)…" per
   sheet the importer parses (then "Building the project: …"), and
   **Cancel**, which stops the worker at once and returns to the picker.
   Failures come back here, each with its own headline and the importer's
   message:
   - *not a b023 workbook*: the named ranges it lacks (the first eight, then
     "and N more");
   - *unsupported build* (AppSettings `zAppVer` isn't b02x);
   - *too large* (the file, the sheet count, or the parts it reads unpacking
     past their caps, which a real workbook never does);
   - *couldn't be opened* (not a zip, an old `.xls` or a password-protected
     file, `.xlsb`, a damaged or encrypted archive);
   - *a problem the importer can't get past* (a table header it can't find,
     dates that jump …), with the sheet and cell.
3. **Review:** the preview as for a `.json` file (name prefilled from the file
   name up to `_WBT`, team, "In this workbook" counts and series table, *Run
   the model after importing*), plus:
   - **Gauge column** (only when the workbook has one): *It's a gauge on
     another river: import it as a reference gauge*, and then an optional
     *Scaling starts on* date and *Scale factor* to undo a known scaling. A
     change re-extracts from the workbook the worker still holds (no second
     read) and updates the counts, notes and report in place; a date without
     a factor (or the other way round) or a non-positive factor is flagged
     and blocks Import.
   - **CHIRPS column** (only when the workbook has one; issue #40 part c):
     which CHIRPS product and version it holds, **CHIRPS v2.0 (usual for
     b023)** preselected, or CHIRPS sat / rnl v3.0, or *Not known*. The
     series goes in labelled with the answer
     ([data-model.md § Series provenance](./data-model.md#series-provenance-032_series_provenancesql)),
     which is what later stops the CHIRPS feed (v3.0) splicing onto it. The
     Python importer (`pnpm import:project`, `seed:demo`) leaves it
     unrecorded; say it on the Data tab.
   - **Importer notes**, each marked *Note* or *Warning*, with its sheet and
     cell: the Python importer's `note:` / `WARNING:` lines, same text.
   - **Unmapped report**, its own section and table (*Where*, *Element*,
     *What*, *In the workbook*): what couldn't be carried across as the
     workbook meant, such as a hand-written [Transfers] InOut formula (shown
     verbatim), a draw rule with no destination, a blank Specific share, M1
     month lists, number cells holding text. The importer never changes a
     value on its own; "Nothing: everything in the workbook was mapped" when
     empty.
4. **Importing, Done, Failed:** as for a `.json` file (the server's 400 and
   413 messages included). *Open project* goes to it, and a first run's
   result is on the Runs tab.

The notes and unmapped report go with the import (`importReport`,
`import/importReport.ts`, trimmed to the server's caps) and are kept with the
project: its Summary's **Import record** shows them afterwards
([Summary](#summary)). A `.json` import sends its own record
(`source: 'project-file'`, with the notes the preview showed, if any).

Everything from the file (farm and sheet names, notes, formula text, error
messages) is rendered as text, never `{@html}`
([security.md § Input handling](./security.md#input-handling)). Closing the
dialog, Cancel and a finished import terminate the worker. An import still in
flight when the dialog closes finishes (the list reloads) but never takes over
a reopened dialog.

## Teams

Laid out for the app frame (issue #17): the layouts answer to the page's own
width through container queries, not the window's, since the sidebar takes
240 px.

**`/teams`** shows each team as a card: its name (opens the team) and your
role, then **Projects**, **Members**, **Farms short this week** (added up
over the projects whose count is known, "2 of 14 farms"; "–" when none is)
and **Last run**, a stacked **EWR, last 30 days** bar with the counts in
words ("1 red, 4 green"), and the projects worst first with their status
pills (five, ten when it's your only team; the rest are "N more projects on
the portfolio"). *Open team* and *Portfolio* sit at the card's foot. The
numbers come from each team's portfolio (`GET /teams/:id/portfolio`, one
request per team after the list loads; no new endpoint), so a card shows
its project and member counts at once and fills in the rest; if a
portfolio fails the card says so and keeps its counts. The card grid
auto-fills; a single team gets the full width with its projects beside the
numbers. A **How teams work** panel beside the cards explains the three
roles. *New team* stays in the header, and the empty state explains teams.

**`/teams/:id`** leads with outcomes. The header has the team's name and
your role, a summary line ("5 projects (1 red, 4 green) · 4 members ·
created 26 Sep 2026") and the actions: **Portfolio**, **Team settings**,
**Add member** (admins; focuses the add form) and **New project** (members
and admins; opens the New project dialog with the team preselected). The
main column is **Projects**: four tiles (EWR bar, farms short this week,
alerts firing, last run), then each project worst first with its source
("Published run"…), EWR pill, figures age and *Stale* flag, farms short
(linking to the run's curtailment, as on the portfolio), lowest dam and
alerts; a footnote states the traffic-light rule with a link to the
settings. **Members** is the side column (below on a narrow page): name
with the email under it, role, Remove; the add-by-email form, pending
invites and the roles list. Admins pick each member's role from
**viewer / member / admin** (the sole admin's viewer and member options are
disabled), and the page explains each role in a short list under the table:
viewers read every team project, members edit them, admins own them and
manage the team. A team viewer doesn't get "New project"; the
New project dialog and the Summary's *Move to* list offer only teams where
you're a member or admin, and copying a team project you only view makes a
personal copy (the Copy dialog says so).

**Team settings** (`?settings=1`, a side sheet,
`lib/components/teams/TeamSettings.svelte`) holds what used to sit in the
reading path: **Team name** (admins; *Rename*), **Portfolio traffic lights**
(below), and **Leave or delete** (*Leave team* for everyone, the only admin
told to hand over first; *Delete team* for admins, which closes the sheet
and asks in a confirmation dialog). The URL opens it (the portfolio's
"Change them on the team page" links there), and closing it drops the
parameter in place, so Back closes it.

**Portfolio traffic lights** (in the settings sheet, decision D11):
every member reads the rule the portfolio judges by, "green when it was not
met on under 5 % of them, amber under 20 %, red otherwise", and whose it is:
*These are the team's own thresholds* or *These are the default thresholds,
still to be confirmed by the hydrologist*. Admins get two number inputs,
*Green below (%)* and *Amber below (%)*, checked as the API checks them (both
0–100, green below amber; the message sits under the inputs, which carry
`aria-invalid`), *Save thresholds* (disabled while invalid or unchanged) and,
once the team has its own, *Use the defaults*. Anyone else sees "Only admins
can change them." A change shows in each team project's History tab
(`team_thresholds.changed`).

### Portfolio (`/teams/:id/portfolio`)

The WUA's one screen for all of a team's catchments (roadmap WP-2.14,
`routes/teams/[id]/portfolio/`, wording and sorting in
`lib/components/portfolio/portfolio.ts`). Linked from the team page and
from each team group's heading on the project list. One row per catchment
the user can see, from `GET /teams/:id/portfolio` ([api.md §
Portfolio](./api.md#portfolio)):

- **Catchment**: the name (opens the project's Summary) and where the
  figures come from: *Published run*, *Published run (a newer run is not
  published)*, *Latest run, not published* or *Not run yet*, with a hint
  for editors to run or publish.
- **EWR, last 30 days**: the status as words **and** colour, never colour
  alone: "Red: EWR not met 9 of 30 days", "Green: EWR met all 30 days", or
  "Unknown: no run yet / no EWR set in the run / the run has no EWR record;
  run it again" (dashed outline). Under it, how old the figures are
  ("Figures to 29 Dec 2023, 1,002 days ago") and a *Stale* flag past 7 days.
- **Hydrological units short**: "2 of 8 hydrological units short this week" (a link to the
  Curtailment panel of that run on [Hydrological units](#hydrological-units), over the
  last 7 days, `?tab=supply&run=<id>&window=last7#res-curtailment`; the page
  scrolls there once the run's results render and moves focus to the table's
  heading; the old Runs tab link still lands there) and the count over 30 days; "Unknown
  until a run is published" without a publication.
- **Lowest dam**, **Restriction** (the WUA's level and %), and **Data**:
  recorded rain to …, a *Newer data not in the figures* flag, and the feeds'
  health.
- **Alerts**: the alerts firing now, "None" or "2 firing" (a warning badge),
  from `alertsFiring` ([§ Alerts](#alerts)).

Wide screens get a sortable table (column-heading buttons with `aria-sort`);
under 760 px the same rows become stacked cards with a *Sort by* select.
Sorts: EWR status worst first (red, amber, unknown, green; more days not met
first within a colour; the default), name, figures age, farms short, lowest
dam; unknown values sort last either way. The sort lives in the URL
(`?sort=`, `?dir=desc`). States: loading, error with retry, an empty team
("No catchments in this team yet", with *New project in this team* for
members and admins), and not-found for a team you aren't in. A farmer who
opens the address is sent to their farm view (`/farm`), as the project list
does. The intro states the thresholds the statuses were judged by (the API's
`thresholds`, the team's or the defaults) and whose they are; an admin gets
a link to change them in the team page's settings sheet (§ Teams,
`?settings=1`), anyone else is told a team admin can.

A dashboard (issue #17). The header carries *Team page* and, for members
and admins, *New project in this team*; under it five tiles: **EWR, last 30
days** (the "5 catchments: 1 red, 4 green" line, a live status, over the
stacked bar), **Farms short this week** (added up), **Alerts firing**,
**Stale figures** ("4 of 5") and **Last run** (the totals come from
`portfolioTotals` in `portfolio.ts`; the pill and bar are
`portfolio/StatusPill.svelte` and `StatusBar.svelte`, shared with the teams
list and the team page). On a wide screen the page fits the window like the
Network map: the table's box is the height left below the tiles, measured
(its top and what sits below it on the page, re-measured by a
`ResizeObserver` on `body`), never a fixed viewport height; the table
scrolls inside it with its header row stuck, and the page keeps a 1 rem
bottom margin and doesn't scroll. On a phone it's the cards, and the page
scrolls. (The cards used to show under the table on a wide screen too: a
plain `.cards { display: grid }` beat `.phone-only { display: none }`; the
wide-screen rule now hides them.) `portfolio.spec.ts` pins the fit at
1440×960 and 1280×800.

## Network

One page, the **map** (issue #17, option A's simplicity with nothing lost).
It used to have three layouts (Map, Table, One node); with the Grids menu
they only made the page jump, so the other two became things the map opens:
the **node table** is a grid (**Grids → Node table**, `grid=nodes`, the
[grid modal](#grid-modal) showing `NetworkTab` with `only="table"`), and a
node's **full form** opens in a sheet over the map from its card's **Edit**
(`edit=<id>`). Old links still land: `view=table` becomes `grid=nodes`,
`view=node` becomes `edit=<node or the first>`. `node=<id>` picks a node (a
note's link on the Summary, `notes.ts` `noteHref`).

- **Map** (the A2 board), a page of its own:
  - **Header** (with no nodes yet too): "Network" and one line on what it is
    ("2 hydrological units · 2 dams · 1 gauge · into Outflow gauge · 32.0 km²";
    "No nodes yet"); on the right a **Grids** menu (a disclosure named "Open
    as a grid": *Node table*, *Crop factors*, *Planted areas*, *Transfers*,
    each in the [grid modal](#grid-modal); Escape or a click outside closes
    it) and, for editors, **+ Add node**, which opens the new node's form in
    the sheet. With no nodes the map card is an empty panel with **Add
    outflow gauge**.
  - **Catchment map** card: *Colour farms by* in its header, the schematic
    filling the card, and one legend line under it. Colouring by supply is
    **on by default** once the project has a run.
  - **Screen use:** from 900 px the layout is exactly the height left in the
    window below its top edge, less the page's 1rem gutter and the save bar
    while it shows (`--dock-h`; at least 520 px), the top measured on load and
    whenever the page resizes, so **the page itself doesn't scroll**. (It
    used to measure what sat below it from the page's scroll height, which
    the window's own height props up, so a map shrunk in a narrow window never
    grew back when the window widened; Crops & demand had the same rule and
    the same fix.) The drawing takes the card's height
    after the legend, and the node list takes the side column's height after
    the node card, each scrolling inside itself. `NetworkSchematic`'s `fill`
    lays the tree out to the box rather than zooming it: columns are at least
    wide enough that no label runs into the next node on its row, and spread
    until the right-most label reaches the box's edge (at most 1.8× the usual
    150 px); rows spread to the box's height the same way (only from 900 px,
    where the box's height is set by the page, not by the drawing). Text stays
    at its usual size, and a network wider than the box at its tightest
    spacing scrolls; the drawing is centred in its box only while it fits
    (`align-items: safe center`), so a network taller than the box starts at
    its top row rather than centring that row above the box's edge, where
    nothing can scroll to it (Sandspruit's top row was cut off at 1440 × 960).
    The side column is `clamp(17rem, 24vw, 22rem)`.
  - **Fit signal:** a resize reaches the drawing a frame or more later (the
    box's size through a ResizeObserver, the 900 px breakpoint through its
    media query's change event, the layout's height through the measured top),
    so the schematic's scroller carries `data-fit` (`<width>x<height>`, plus
    ` wide` from 900 px): the box the drawing on screen was laid out for. It
    is settled once that matches the box as it is now and `--map-top` matches
    the layout's top; e2e waits on that (`waitForMapFit`, e2e/support/diagrams.ts)
    before measuring the map (issue #138).
  - **Legend line:** the shapes, the supply bands present, the run they come
    from ("Hydrological units coloured by … in run “test”, ran today", read out) and the
    drag hint, which becomes the live drop status while dragging.
  - The **Grids** menu closes through its element (`details.open`), not its
    bound state: the `toggle` event that updates the state is async, so an
    Escape right after opening would otherwise leave it open.
  - Beside it (one column below 900 px, the map first), two cards:
    - the **picked node** (`network/NodeCard.svelte`): kind ("Selected ·
      farm", "outflow gauge", "other water user") and name, its notes
      (`NotesDrawer`, a saved node) and **Edit** (**Details** for a viewer),
      which opens its form in the node sheet. A farm has two tiles:
      *Supplied* in the latest run (the newest run's summary, fetched through
      the Runs tab's `detailCache` whenever this layout shows; the tile
      tints for the short and low bands, and "no demand" / "not in this run"
      are written) and **Dam now**, its storage at the end of that run as a %
      of capacity (its `dam_storage` series, through `cachedSeries`, reduced
      by `overview/damLevels.ts`; "No dam" without one). Then drains into,
      catchment area (a user: what it takes, `describeUser`), and for a farm
      its flow share in use, dam capacity and irrigated area, a link ("20.00
      ha, 1 crop") to the farm drawer. With nothing picked: "Select a node on
      the map or in the list to see it here."
    - **All nodes**: a button per node, in the model's order, with a dot for
      its kind (in its supply band's colour while colouring is on), its name
      and "→ downstream" (or "outlet"). The name wraps between words; the
      downstream name takes at most 45 % of the row on one line, cut with an
      ellipsis (the button's accessible name has it whole). Pressing one picks it (and marks it
      on the schematic); picking on the schematic marks it here.

  - **Node sheet** (`edit=<id>`, the `Dialog` `side wide` variant, 640 px,
    the whole width on a phone): "Edit *name*" ("*name*: details" for a
    viewer), the node picker (‹ select ›, labelled "Node to edit") fixed in
    the dialog's sub-header above the scrolling form (so no control scrolls
    under it), then the one-node form (`NodeDetail`: every field with its help
    text, land cover, boreholes, the farmers note, Preview as farmer, move,
    make outflow gauge, remove) and a farm's Yield panel. The save row
    (`ModelSaveRow`: status, reason, Discard, Done, Save changes) is pinned
    under the form. ‹ ›, the picker and a tap on the map move it to another
    node (replacing `edit=` in place); Done, Esc, the ✕ or Back close it.

  Every field of the old Table and One node layouts is a click away (Edit,
  Grids → Node table), so nothing was removed.
- **Schematic** (`NetworkSchematic.svelte`, layout in `schematic.ts`): the
  drains-into tree with the outflow gauge at the bottom. Farms are circles,
  farms with a dam (≥ 1 m³) are filled squares, gauges are open triangles
  and the outflow gauge is a filled triangle. River lines thicken with the
  upstream area, and transfers are dashed arrows. Each transfer arc takes
  the smallest bend that keeps it off every node label and symbol and inside
  the drawing (`transferArc`), left of the nodes first since labels sit to
  their right. When no arc is clear (far-apart dams on a big network, the
  packed columns on paper) the transfer is routed instead (`routeAround`): a
  shortest path on a 4 px grid round every label and symbol, along the lanes
  between rows and beside the nodes, crossing rivers but never running along
  one, its corners rounded (`routePath`); `transferPathData` picks. Labels
  (ui-playbook § 3, "Labels on diagrams"): each node's **name** (12.5 px,
  semibold, `--text`) over its **figure** (11 px, `--text-muted`: area and
  dam, or the colouring's "82% supplied"), both with a halo in the drawing's
  ground colour on screen (not on paper, where it doubled every name in the
  PDF's text). The room each label takes (column spacing, the transfers'
  obstacles) is its width measured in the drawing's own font, never less than
  the per-character estimate (`measuredWidths`). Names are cut to 17 characters so that no two read the same
  (`distinctShortNames`): "Kliprivier Estat…", but "North Sandvlak… 2" and
  "… 7" keep the ending that tells them apart; the full name is the node's
  tooltip, the list and the drainage tree. Editors can drag a node onto
  another to change what it drains into. Drops that would make a loop, or
  that move the outlet, are refused and the reason is shown. The "Drains
  into" select is the keyboard route. A visually hidden list ("Drainage
  tree") is the text equivalent of the drawing. On paper (the report, below)
  the drawing is wrapped to the A4 width instead (`paper`,
  `wrappedSchematicLayout`): at most five columns, and where the branches
  draining into one node don't fit side by side they wrap onto more rows
  stacked upwards, the shortest nearest the node, the higher rows' rivers
  running down a gutter on their left into the node's confluence line. Names
  print at a readable size (a 30-unit catchment on one page, names at
  ~7.6 pt of type; unwrapped it printed at ~15 %, names ~1.4 pt). A drawing that is
  then taller than its page (a long main stem wraps down, not across) is split
  into page-high bands (`paperBands`): each band is its own SVG that prints
  whole (`break-inside: avoid`), cut just below a row's names and above the
  next row's confluence line, so no page break runs through a row of names.
  The first band leaves room for the section heading. A river that crosses a
  cut runs off the foot of one band and on from the top of the next, with a
  small arrowhead at both ends (`bandCrossings`), and a note under the band
  ("Continues on the next page") and over the next ("Continued from the
  previous page"). A drawing that fits its page prints as one picture, as
  before, and the screen never bands.
- **Colour hydrological units by** (the Catchment map card's header, offered once there is
  a farm; component state, not kept in the URL). Rules in
  `network/farmColour.ts`; each mode gives every farm a band, the words for its
  second label line, the legend entries and a caption sentence, so nothing is
  colour-only (the words are also in the node's tooltip and the drainage-tree
  text):
  - **Supply, latest run** (the default once there is a run): the newest
    run's summary (`api.runs.get`, sharing the Runs tab's `detailCache`; a
    quiet status line covers loading, and a failure offers Retry) banded by
    `fractionSupplied` (`network/supplyColour.ts`): **≥ 95 %**
    (`SUPPLY_TARGET`), **70–95 %** and **under 70 %** (`LOW_SUPPLY`), "no
    demand" (the engine reports 100 %) dashed and unfilled, "not in this run"
    (added since) hatched. Label: "82% supplied".
  - **Dam level, end of latest run** (offered with a run and a dam): each
    dam's storage on the run's last day, from the run summary's dam figures
    (engine ≥ 1.2.0, issue #55, `damLevelsFromSummary`), or for an older run
    from its `dam_storage` series, fetched only while this mode is picked,
    four at a time (`overview/damLevels.ts` `loadDamLevels`, shared with the
    Dams page and the Summary's Dams today; "Loading dam levels (N of M)…",
    Retry on failure). Bands on the
    same three colours: **60 % full or more** (`DAM_FULL_PCT`), **30–60 %**,
    **under 30 % or at its minimum level**; no dam (< 1 m³) dashed, not in
    the run hatched. Label: "64% full" or "10%, at its minimum". Capacity and
    minimum come from the run's own model.
  - **Irrigated area** (no run needed; follows unsaved edits at once): each
    farm's planted hectares, in one hue over three steps (thirds of the
    largest farm's area, since more area is neither good nor bad) and
    "nothing planted" dashed. Label: "20.0 ha planted".

  The caption names the run ("… in run “test”, ran today"; with unsaved
  edits it adds that the colours show the run, not the edits). The **All
  nodes** list's dots take the same bands (hollow for no dam / nothing
  planted / no demand). Gauges and other water users are never coloured.
  Selection, hover and drop states live on the halo and opacity, so they're
  unchanged. The printable report colours by supply the same way
  (`supplyColouring`).
- **The node table and the one-node form** (the grid and the sheet above):
  every field has
  a unit, a help tip and an entry in the field guide. Percentages are stored
  0–1 and shown 0–100. Fields that only apply to farms show "–" on gauge rows.
  The flow share in use (with the Settings method) and its total are shown.
  The one-node form and the view-only table show thousands separators
  (300 000, the app's usual `fmtNum` style, § Number style) on the non-% fields; a field
  switches to the plain number while it is being edited, and typed or pasted
  separators (`300 000`, `300,000`) are accepted (`NumberInput grouped`). The
  editable table keeps plain numbers.
- **The node table** (`grid=nodes`): the whole table, through the **In use** share and the ✕
  column, fits a 1440px screen without sideways scrolling (the dam physics
  fields live in the one-node form only, see above). Field headers wrap
  (e.g. "Upstream inflow to dam" over three lines) instead of setting the
  column width, cells are tighter, the short area and 0–100 % columns are
  narrow, and the volume columns (m³, m³/day; `isVolume`) keep room for a
  seven-digit value such as 1500000, so a dam capacity is never clipped.
  Every cell of a column carries its width class, not-used and footer cells
  included. Every field header is the label (hyphens don't break,
  so "High-MAP" stays whole) over one line with the unit and its ⓘ, all
  bottom- and right-aligned, so the icons form one row. Numbers are
  right-aligned in even-width digits with no spin buttons, and each total
  lines up with the digits above it. Narrower screens scroll the table sideways inside its own
  box, with the **Name** column pinned on the left and the **✕** remove
  column pinned on the right, so every row stays named and removable.
  On a phone (≤ 640 px) each row is a card instead, the same markup
  restyled like the crop grids: a first line with the row's controls
  (drag handle, ↑/↓, notes, and ✕ at the top right), the name across the
  card, then Kind and Drains into and every field two to a row, each with a
  visible label that names its group ("Dam capacity m³", "High-MAP area
  km²"; `cardLabel` in `network/fields.ts`), and the flow share in use last.
  Fields a node doesn't use (a gauge's dam, routing and irrigation) are left
  out rather than shown as "–". The totals are a card of their own lines
  ("Area 144.00 km²"). The inputs, their accessible names, validation and the
  save row are the table's, and the cards scroll with the modal rather than
  in a box of their own, so **+ Add node** and the field guide follow the
  last card. The ⓘ tips sat in the column headers, so the intro sends a
  phone to the field guide instead (`node-table.spec.ts`).
- **The one-node form** (the node sheet): the picker (‹ select ›) stays in
  reach above the scrolling form in the sheet's fixed sub-header.
- **Irrigation** group (engine ≥ 0.16.0, [engine-audit N1](./engine-audit.md)):
  efficiency and the share of losses returning. The one-node form adds an
  **Irrigation system** select that sets the system's SABI 2021 efficiency
  (drip 90 %, micro-sprinkler 82 %, centre pivot / linear move 85 %,
  permanent sprinkler 80 %, movable sprinkler 75 %, surface 70 %,
  `IRRIGATION_SYSTEMS` in the engine, the same table as [Load crop
  factors](#load-crop-factors)), labelled indicative; "Other" keeps the value
  as typed (and is what a farm saved with a value off the table, e.g. the old
  flood 65 %, shows). New farms start on drip, 90 % and 50 % (the client's
  default, issue #90).
- **Dam** fields also hold the area when full (m², empty = unknown), the area
  exponent (default 0.7) and seepage (% of storage per day) for dam
  evaporation and seepage ([engine-audit N2](./engine-audit.md)). These three
  are in the one-node form and the field guide only, not the table
  (`detailOnly` in `fields.ts`), so the table still fits a 1440px screen.
- **EWR site** (engine ≥ 1.5.0, [model.md §2.7b](./model.md)): the one-node
  form of a gauge has an **EWR site** checkbox (ticked by default, and on
  every gauge before 1.5.0) with a line saying what it means: ticked, a
  shortfall there is charged to the units upstream; unticked, the gauge only
  measures flow and a Reserve rule table there is skipped. The outlet's is
  ticked and disabled (the outlet is always a site). It also shows on a unit
  or other user that has it off (an imported model), with the problem the API
  would refuse it for (`ewrSiteIssue` in `model/validate.ts`), and has its
  field-history line. Not in the table.
- **Hints** (not errors, `damHints` in `fields.ts`): the one-node form notes
  under a dam's fields when irrigation may empty it (minimum operating level
  0 %, [engine-audit Q5](./engine-audit.md)), and when its area is unknown, with
  the capacity ÷ 3 m estimate the run will use (N2, warning W6).
- **Other water users** (engine ≥ 0.22.0, WP-1.33, [model.md §2.7c](./model.md)):
  **+ Add other user** (next to + Add node, in both layouts) adds a node of
  kind *Other user* draining into the outlet, with no demand yet; any node's
  Kind can also be switched to it. In the table a user's row shows "–" in
  every farm column ("not used for an other water user"), and below the
  network panel an **Other water users** panel lists each user (name, a
  one-line summary: priority, mean demand, share returned, what it drains
  into) with its **Priority** (senior: farms upstream pass its demand first;
  junior: takes what reaches it), **Share returned** (%) and **demand per
  month** (m³/day, Oct–Sep) with *Use October's demand for every month*
  (`UserFields.svelte`, `users.ts`). The one-node form shows the same fields
  under "Other water user" instead of the farm groups. The schematic draws a
  user as an open diamond (legend "Other water user"). The client check
  mirrors the API: no crop areas or transfers on a user, 12 demands ≥ 0, a
  return share in 0–100 %.
- **Groundwater (boreholes)** group (engine ≥ 0.23.0, WP-1.34, [model.md §2.7d](./model.md)),
  one-node form only (`detailOnly`), on farms and other users: borehole
  capacity (m³/day, empty = none), **Borehole rule** (supplemental / primary /
  drought), drought trigger (%), stream depletion (%) and depletion lag
  (days). The client check refuses boreholes on a gauge and the drought rule
  without a farm dam.
- **Dam survey and releases** (engine ≥ 0.35.0, WP-3.5, [model.md §2.7a](./model.md)),
  one-node form, farms with a dam (`DamStorageFields.svelte`, `damCurve.ts`):
  without a curve it says the power-law area is in use; **Paste survey rows**
  opens a box for level, area and volume rows (commas, semicolons, tabs or
  spaces; a header line skipped) with **Use these rows** / **Cancel**, and a
  line it can't read is named in an alert. With a curve: its rows as a table,
  a small area–volume chart (dashed line at the capacity; the chart's
  accessible name gives the first and last rows), the save rule's message if
  it breaks one, a note when the top row is more than 1 % from the capacity,
  **Edit the survey rows** and **Remove the curve**. Below: **Release rule**
  (none / pass inflow / fixed) with its monthly amounts (m³/day, Oct–Sep,
  *Use October's amount for every month*); under pass inflow a checkbox
  keeps the EWR required at the node as the target. The Dam group gains
  **Seepage returning** (%) and **Outlet capacity** (m³/day, empty = no
  limit), one-node form only. Viewers see the values read-only (no paste
  controls). The dam hint about a missing area is dropped when a curve gives
  it. Settings: **Vary it by month** under the dam evaporation factor opens a
  monthly row of factors (started from the single one).
- **Supply** (engine ≥ 0.42.0, WP-3.8, issue #54 item 2c, [model.md §2.7e](./model.md)),
  one-node form, farms (`SupplyFields.svelte`, `supply.ts`): **Supply rule**
  in run comparison's and the scenario form's words (dam only / river first /
  dam, river when low / run of river, engine `SUPPLY_RULE_LABEL`) with a line
  on what the chosen rule does. Every rule but dam only shows the river pump:
  **Number of pumps** × **m³/h per pump**, which fills **River pump capacity**
  (m³/day, pumps × m³/h × 24, with the sum shown under it), and the capacity
  itself, which can be typed straight in (typing it clears the calculator).
  Only the m³/day is stored, so a saved capacity reloads into the m³/day field
  with the calculator empty, whatever the pumps were; that way a capacity that
  isn't a whole pumps × rate product (an imported or licensed figure) shows as
  it is. Blank is no limit, and the note says the run warns. **Switch to river
  below** and **Back to the dam at** (% of dam) show for dam, river when low
  only. The save rules show under the fields as alerts and block Save, as the
  API refuses them (`supplyIssues` in `lib/model/validate.ts`, a test holds it
  to the engine's `modelRuleIssues`): dam, river when low needs a dam; run of
  river with a dam says to set the dam capacity to 0 or pick another rule; the
  switch-back level must be at least the switch-to-river level. A farm with no
  dam on dam only that has anything routed to its dam gets the run's hint: it
  irrigates straight from the river with no limit; pick run of river with a
  pump capacity. A farm turned into a gauge or other user keeps the section
  while it still has supply settings, so they can be reset. Read-only for
  viewers (no calculator).
- **Individual boreholes** (engine ≥ 0.36.0, WP-3.9, `BoreholeFields.svelte`),
  one-node form, farms and other users: always the note **Low confidence:
  Depletion is a fixed fraction, not an aquifer model. Attach the geohydrology
  report.** **+ Add borehole** adds one (supplemental, straight to the crop, no
  capacity or cap yet); each has a **Name**, **Capacity** (m³/day), **Annual
  cap** (m³/a, empty = none), **Mode** (supplemental / primary / emergency /
  none; emergency only with a dam), **Runs below** (% of dam, emergency only),
  **Pumps into** (the crop or the farm dam; farms only, the dam only with one)
  and **Stream depletion** (% of pumping). Below them: the caps' total and the
  GN 538 context: this property's volume (area × Table 2 rate, at most 40 000
  m³/a, in any 12 months) once the groundwater group's **Property area (GN
  538)** (ha) and **GN 538 rate** (a select of the six Table 2 rates, or "Not
  looked up") are set, else GN 538's rule and a prompt to enter them (engine ≥
  1.12.0); and the GA's exclusions (an alluvial aquifer connected to the
  stream, within 100 m of a watercourse). The app never decides legality. Read-only for viewers; fields stack on a phone.
  Removing the node asks about its boreholes too.
- **Demand objects** (engine ≥ 1.7.0, issue #54 item 2b, [model.md §2.7f](./model.md),
  `DemandObjectFields.svelte`), one-node form, units only (and on a node turned
  into a gauge or user that still has some, so they can be removed; the save
  refuses them there): demands that aren't crops. A **category** picker
  beside **+ Add demand** adds one with that category's defaults from the
  issue's research table (municipal: m³/day by month, first, 50 % returned;
  domestic: people × 230 l a day, first; livestock: head × 45 l a day, with
  the crops; external: piped out, nothing returned; the rest: m³/day by month,
  with the crops). Each has a **Name**, **Category**, **Demand given as**
  (m³/day by month, or a count × litres a day), **Priority** (first / with the
  crops / last), **Destination** (used in the catchment, or piped out, which
  sets and locks the share returned at 0 %), **Share returned** (%),
  **Modelled** (off keeps it on record only), a 12-month row (the demand in
  m³/day, or the per-unit profile, blank = 1), and **Where the number comes
  from**. Per unit: **Number of** people / head / units, **Litres per** person
  / head / unit **a day** and **Distribution losses** (%). The line below gives
  its mean m³/day as the engine sizes it; **Use October's demand for every
  month** fills a monthly row. **On/off schedule** (engine ≥ 1.17.0, issue
  #90 Q4, `DemandScheduleFields.svelte`, `demandSchedule.ts`): "Every day at
  its month's demand" until a window is added; a **Days the new window
  covers** picker beside **+ Add window** adds one, off (factor 0), with a
  starting point per span (Every day: weekends, Sat and Sun ticked; Dates
  each year: the Christmas break, 12-15 to 01-10; Date range, once: blank
  dates; Around Easter: −2 to +1, Good Friday to Family Day). Each window has
  a label (**Window n**), **Days** (the span; changing it resets the bounds),
  its bounds (**From** / **To**: MM-DD each year, date pickers once, days
  from Easter Sunday), **Factor** (0 = off, up to 10), **On** Mon–Sun
  checkboxes (all ticked = every day), **Move window n up / down** (order
  matters: the later window wins a day two cover) and **Remove window n**. A
  window the run couldn't use says why under it ("Not used: …"), and the
  save refuses it. Read-only for viewers; removing the unit asks
  about its objects too. Scenario override mode can't record an object edit
  yet and says so. After a run, the human-impact tables show **Demand
  objects**: per object its unit, priority, demand, supplied (m³/day and %),
  days short, days off (a column only when an object has a schedule; "–" on
  one without) and returned (or "piped out").
- **Land cover** (engine ≥ 0.24.0, WP-1.35, [model.md §2.5a](./model.md)),
  one-node form, farms only (`LandCoverFields.svelte`, `landcover.ts`):
  **+ Add land cover** adds a patch (invasive trees, full cover, no area yet);
  each patch has a **Cover class**, **Area** (km²), **Condensed cover** (%)
  and **Own reductions**, which replaces the class's indicative reductions
  (shown otherwise) with two editable %s. Below the patches: the condensed
  share of the farm, flagged when above 100 % (the run scales it down). The
  field guide points table users to the one-node layout. Removing a farm
  removes its patches (the confirm says how many).
- **Order**: rows reorder by drag handle or ↑/↓ buttons (focus stays on the
  moved row, and the new position is announced). **Sort by flow path** lists
  each tributary from its headwater down, with the outflow gauge last. The
  order is `node.sortOrder`, which is display only: runs always use the
  topological order. Every list of nodes uses it (`lib/model/order.ts`).

### Yield (WP-3.6)

`lib/components/yield/YieldPanel.svelte`, its own chunk (with its chart),
loaded only when a farm is focused. It sits under the farm's form in the
node sheet, and under a scenario (**Yield under this scenario**,
with a dam picker over the scenario's own farms). The numbers come from a
background `yield` job ([api.md § Yield](./api.md#yield), [model.md §2.13](./model.md#213-firm-yield-and-storageyield-engine--0340-roadmap-wp-36)).

- A note says every number is **historical**: it replays the one record, and
  a stochastic yield can be materially lower (not computed here).
- On the Network tab a **Run** select picks the saved run of the model it
  works on (the newest by default; scenario runs aren't offered). With no
  run, it says to run the model first.
- Editors pick a **Draft pattern** (constant, or this farm's irrigation
  demand by month) and an **Assurance** (firm, 98, 95, 90 or 80 %), then
  **Work out the yield** or **Storage–yield curve** (disabled, with a title
  saying why, for a farm with no dam). Viewers see the results with no
  controls.
- The status line (a polite live region) follows the job on
  `GET /jobs` every 1.5 s: Queued, Running with its % (and a progress bar),
  then the results; Failed with the server's reason (never database text);
  Cancelled. **Cancel** stops a waiting job at once and a running curve at
  its next point. On open (and on each change of run or dam) the panel also
  asks `GET /yield/jobs` for this dam's pending jobs, so it picks up and
  follows one it didn't queue: another tab's, a colleague's, or its own
  before a reload (a running one first, then the newest waiting one).
- **Results**: the newest firm yield as a definition list (the yield in
  m³/day and a year, the dam's capacity, the pattern, failure days and
  years at that draft, who worked it out and the engine version); the
  newest curve as a uPlot line (yield against capacity in thousand m³) and a
  table (capacity, yield per day and year, failed water years; the dam's own
  capacity marked "this dam"). A curve whose yield falls somewhere as the dam
  grows carries a warning saying why that can be real.
- Not yet: the instant in-browser preview through the preview worker
  ([followups.md](./followups.md)).

## Crops & demand

The answers first, the crop grids one click away (issue #17, option A · A3;
`components/crops/CropsTab.svelte`). Built to hold a real catchment's crops
and units, and 30 crops on 20 units, without pushing the results off the screen:

- **Header:** "Crops & demand", one line ("4 crops · 312.5 ha irrigated on 6
  farms · water year October to September", `cropsSummary`), and on the right
  a **Grids** menu (Crop factors, Planted areas, Irrigation demand → the
  [grid modal](#grid-modal), `grid=crop-factors|planted-areas|demand`; Escape
  or a click outside closes it) and **+ Add crop** for editors. The header
  shows with no crops too, over an "Add crop" prompt.
- **Crop list** ("Crops", *Largest planted area first*): one compact row per
  crop, sorted by planted area on the units shown, largest first (equal areas,
  unplanted crops included, keep crop order; `rankCrops`). A row has the
  crop's colour key, its name, its area and the month of its **peak need**
  (A-pan × factor; the factor alone while A-pan is unset; "no crop factors
  yet" when every factor is 0), a small sparkline of its 12 factors
  (`charts/Sparkline.svelte`, the compact chart pattern; `cropRows` in
  `crops/cards.ts`): one column header over the sparklines names them
  ("Crop factor by month, Oct–Sep"), each has Oct and Sep under its ends and
  its highest factor between them ("max 0.80"), marked by a dot, its top at
  1.0 (or the highest factor above it); pointing at it reads out a month
  ("Jul 0.40"), as do the arrow keys once it has focus (its slider, "Orchard:
  Crop factor by month, Oct–Sep, read-out"), and its image name gives every
  month's factor. Then
  **Edit** (viewers: **View**), which opens the **crop
  sheet**. A crop with a factor above 1.0 gets a warning icon, a button named
  "Factor above 1.0 in Jan: check Vines isn't an FAO Kc" whose short text
  shows on hover and focus; it opens the sheet, which carries the full
  warning. The display order the engine and the grids use is still set in the
  Crop factors grid; the list only sorts what it shows. When there are more
  crops than colours, an **Other** row after the coloured ones names its
  members ("Other: Crop 10, Crop 11 and …", two lines at most) with their
  total area, and each member's row follows it with a hatched key and "in
  Other" instead of the group's grey.
- **Irrigation demand by month:** the catchment's gross demand per
  water-year month, stacked by crop in the list's order, largest at the
  bottom, "Other" on top (`MonthlyBars` in stacked mode, drawn at the card's
  measured size so its text isn't scaled; its legend's height is measured
  after each render and taken off the plot). Hovering a segment names the
  month, crop and value. The annual volume, mean m³/s and peak month sit
  under it. **Show table** opens the demand table (`crops/DemandTable.svelte`:
  the formula, m³/day per month, the mean and Mm³/a per unit and for the
  catchment) in place. An alert says when A-pan isn't set (demand is then
  zero).
- **Planted area by hydrological unit:** one stacked bar per unit with something planted,
  largest total first, split by crop in the list's colours and order, scaled
  to the largest unit, with its total ha (`farmBars`). Each bar is an image
  named with its parts ("Lower farm: 20 ha, Orchard 12 ha and Vines 8 ha");
  hovering a segment names its crop and area. The bars scroll inside the card
  and the crop key stays pinned under them (the coloured crops planted
  somewhere, then Other), so it is never cut off. A unit's name opens the
  [farm drawer](#farm-drawer) (`farm=<nodeId>`, keeping the page's other
  parameters). **Edit areas** (viewers: **Areas table**) opens the
  planted-areas grid. Under the key, a muted note names every unit whose
  planted area adds up to zero ("Farm 5, Farm 6 and Farm 8 have no planted
  area, so their irrigation demand counts as zero."), at most five names then
  "and N more" (`noPlantedAreaNote`).
- **Layout** (a container query on the page column, `crops-page`): from a
  60rem (840 px) column, which is a window of about 1100 px beside the
  sidebar, the crop list is a left column (19–25rem) that scrolls inside
  itself, and the demand chart over the unit bars fills the rest; the row
  reaches the window's bottom (its top and the room the page keeps below it
  are measured with a ResizeObserver, as the Network's map), so the chart and
  the bars stay on the first screen however many crops and units there are.
  From a 1500 px column the chart and the bars sit side by side. An open
  demand table lets the row grow and the page scroll. Narrower, the list
  comes first, capped at about six rows (it scrolls inside itself, and
  **Show all N crops** / **Show fewer** lift the cap, `aria-expanded`), then
  the chart, then the bars (also capped, key pinned). On a phone everything
  is one column with no sideways scroll, the bars put the unit and total
  above a full-width bar, and the row buttons are 44 px targets.

**Crop colours.** One set serves the list, the chart and the bars: nine
theme tokens (`--series-1…3`, `--series-5…10` in `app.css`, each with a
light and a dark step; `--series-4` is the line charts' own violet and the
crop set skips it), in an order validated so every adjacent pair stays apart
for colour-blind readers in both themes (the dataviz palette check: adjacent
CVD ΔE ≥ 8.4, normal-vision ΔE ≥ 19.3, every colour ≥ 3:1 on the dark
surface; aqua, yellow and pink are under 3:1 on the light one, which the
row names, the key and the table carry). The chart and the bars stack crops
in that same order, so neighbouring segments are the validated pairs. The
colours go to the crops **ranked by planted area** (`cropColouring`): the
largest nine get one each, so no two named crops ever share a colour, and
any further crops are grouped as "Other" in a neutral grey (`--text-muted`)
that no named crop uses. Area rather than annual demand because it is known
before A-pan is set (demand is then zero for every crop), it is what the
list and the unit bars show, and editing a month's evaporation doesn't
repaint the crops. The chart's parts come from the same per-farm
computation as the table: `farmDemands` splits each farm's engine demand
(`grossFarmDemandM3PerDay`) by crop, `catchmentDemand` gives the totals and
`cropStacks` the parts (the named crops, then "Other (N crops)"), which sum
to them. It is gross demand, before the daily effective-rain reduction (and
the soil-water store that carries rain over, engine ≥ 0.14.0). The Irrigation
demand grid's chart (`CropGrids`) uses the same ranking and colours.

### Crop sheet

One crop's name and 12 monthly factors in a side sheet over the page
(`crops/CropSheet.svelte`), while the URL has `crop=<cropId>`, so it can be
linked and Back closes it; Done, Esc or the ✕ drop `crop` in place
(`withoutParam`). **+ Add crop** adds "Crop N" and opens its sheet with the
name focused. The sheet shows the factors four to a row (labelled "Orchard
crop factor, Jan", as in the grid), the mean, the high-factor warning for
this crop, the × A-pan, not FAO Kc note, and which farms plant it and how
much. **Remove crop** asks first when the crop is planted anywhere, removes
it with its areas, and closes the sheet. It edits the shared `ModelEditor`
and, being modal, carries the save row (`ModelSaveRow`); a viewer gets the
values read-only and Close. `Dialog` `side`, full width on a phone.

### Crop grids

The old tab body, unchanged, is `crops/CropGrids.svelte`: crop factors
(reorderable, the × A-pan intro, the warning naming every crop and month
above 1.0: `highCropFactors`, a hint, never a block on saving), planted areas
in **ha** (stored as m²; farm rows in network order, reorderable; the
no-planted-area note) and the demand preview (chart and `DemandTable`).
`CropsTab` with a `sections` prop renders it: the grid modal passes one
section, scenario override mode (`scenarios/OverrideEditor.svelte`) all three,
inline, on the scenario's model, so neither the crop sheet nor the page's
overlays ever edit the catchment from there.

### Load crop factors

**Load crop factors…**, under the crop-factor table of the [crop
grids](#crop-grids) (editors only: Crops & demand's **Grids › Crop
factors**, the grid modal from any tab, and scenario override mode, where it
fills the scenario's crops), opens a dialog over it
that fills the project's crop factors from a source, shows what changes and
what it does to demand, and changes nothing until **Apply** (issue #54 item 1;
`crops/LoadCropFactorsDialog.svelte`, its own chunk, fetched on first open;
logic in `crops/loadFactors.ts`, data in `crops/library.ts`). Which crop set a
catchment uses is the hydrologist's call (issue #54 Q9/Q10).

- **Source:** the **reference library** (ARC/SABI Irrigation Design Manual
  ch. 4 A-pan design factors, winter rainfall area; [model.md §2.3
  item 8](./model.md) lists the crops, sources and conversions), or **a b023
  workbook** the user picks: its [Crop demand] factors, read by the browser
  importer in its worker (`spreadsheet/import/`, the same reader and
  failure messages as Import a b023 workbook; it reads the whole workbook,
  so a large one takes a few seconds). Workbooks never leave the
  browser. A node-based workbook (no b023 named ranges) can't be
  read yet ([followups.md § Crop factors](./followups.md#crop-factors-issue-54-item-1)).
- **Pan coefficient Kp** (default 1) multiplies the source factors: 1 for
  A-pan factors (the library, b023), about 0.75 for an FAO-56 Kc set.
- **Match crops:** a row per project crop with a **Load factors from**
  select, preset by name (`matchByName`: the same name ignoring case,
  accents, punctuation and a plural s, or the one source whose words hold the
  crop's or the other way round, "Lucerne" → "Alfalfa (lucerne), frost
  areas"; ambiguous or unknown names stay on **Keep current**). A library
  vegetable (staged by portion of the season) asks for a planting month and
  day and a season length, preset from the manual's Table 4.7 where it gives
  one; until the month is set it has no factors. An **irrigation system**
  select sets the crop's own efficiency (engine ≥ 0.43.0) from the SABI 2021
  values, default **Keep**; the library crop's typical system is shown as a
  hint, never applied unasked.
- **Diff:** per mapped crop, its current and new factors month by month
  (changed cells highlighted) and the efficiency, with the source table and
  page and the entry's notes, and an **Apply to <crop>** tick (on) to accept
  or reject that crop.
- **Demand difference:** for the accepted changes, the mean gross irrigation
  demand (m³/day, before rain, at the saved A-pan) now and new per farm and
  for the catchment with the change in %, the same ÷ each farm's irrigation
  efficiency (its crops' blend, `farmIrrigationEfficiency`), and the
  catchment's demand by month. The engine's own functions, so it is what a
  run would use before effective rain.
- **Apply** replaces the accepted crops' factors (and efficiency) in the
  shared `ModelEditor` and closes; the save bar then saves them with the
  optional reason, and History records the change. Cancel, Esc or unticking
  every crop leaves the model untouched. It loads into the project's existing
  crops only: add a crop first to load into it.

### Farm drawer

One farm's planted areas in a side sheet over whichever tab is open
(`crops/FarmCropsDrawer.svelte`, helpers in `crops/farmDrawer.ts`; issue #17,
option A step 4). The drawer is for a quick edit in context; the full grid is
the planted-areas [grid modal](#grid-modal). It opens while the workspace URL has `farm=<nodeId>`
(`farmDrawerHref(tab, nodeId)`: `?tab=network&farm=…`, or `?farm=…` over the
Summary), so it can be linked and Back works; Done, Esc or the ✕ drop `farm`
from the URL in place (`withoutFarm`), so Back then goes to where it was
opened from. It is its own chunk, fetched when a URL names a farm. It never
opens over the Scenarios tab, even when the URL names a farm: it edits and
saves the catchment's model, and override mode there edits the scenario's
([§ Scenarios](#scenarios-tabscenarios)).

- **From:** the Summary's Needs attention (a farm below the supply target, a
  single farm with nothing planted), the Network (on the Map, a farm's card
  links its irrigated area, "20.00 ha, 1 crop", `farmPlanting`) and Crops &
  demand (a farm's name beside its planted-area bar). The
  link keeps the page's other parameters (`withParam`), so closing the drawer
  comes back to exactly where it was opened.
- **Content:** every crop in the model with this farm's area (ha, the same
  inputs and labels as the Crops tab's row, "Orchard on Upper farm, ha"), the
  total, and its gross demand from the saved A-pan (mean m³/day, Mm³ a year,
  the peak month; `farmDemands`). No crops yet, A-pan unset, nothing planted
  and a farm that is no longer in the model each say so.
- **Saving:** it edits the shared `ModelEditor`, so an edit shows on the Crops
  tab at once and the other way round. The sheet is modal, which makes the
  page's save bar unreachable, so it repeats the save row: status (unsaved,
  problems to fix, saving, save failed), the optional reason (the same value
  as the save bar's) and **Save changes**, which runs the page's save;
  **Done** closes and leaves the edit unsaved for the save bar. A viewer
  gets the values read-only and a Close button.
- **Layout:** the `Dialog` component's `side` variant: full height down the
  right edge, 480 px wide, the whole width on a phone. The note linking to
  Crops & demand sits under the table, so opening the sheet focuses the first
  area. Its save row is `model/ModelSaveRow.svelte`, shared with the grid
  modal.

### Grid modal

An existing model grid, unchanged, full screen over whichever tab is open
(`model/GridModal.svelte`; issue #17: the simpler screens keep every grid one
click away). It opens while the workspace URL has `grid=<id>`
(`lib/workspace/overlays.ts`): `nodes` (the Network's node table, `NetworkTab`
with `only="table"`: every column, reordering, Add node / other user, Sort by
flow path, the other water users and the field guide; with no nodes, **Add
outflow gauge**), `crop-factors`, `planted-areas` and `demand` (the
[crop grids](#crop-grids), through `CropsTab`'s `sections` prop) and
`transfers` (the Transfers tab). Done, Esc, the ✕ or Back close it; closing drops `grid` from
the URL in place (`withoutParam`). It isn't opened over the grid's own tab
(`GRID_TAB`), where the grid is already on the page: the parameter is dropped.
The node table and the crop grids have no such tab (`GRID_TAB` null: the
Network is a map and Crops & demand cards and bars), so they open anywhere
but the Scenarios tab, where no grid opens even when the URL names one: the
modal edits and saves the catchment's model, and override mode there edits
the scenario's ([§ Scenarios](#scenarios-tabscenarios)).

- **From:** the Network's and Crops & demand's **Grids** menus, and Crops &
  demand's **Edit areas**. More screens will link to it as they simplify
  (the #17 checklist).
- **Editing:** the grid edits the shared `ModelEditor`, so its edits show on
  the tab it comes from and the other way round, and the tab's problems list
  shows above it (`IssueList`). The modal hides the save bar, so it carries
  the same save row as the farm drawer (`ModelSaveRow`): status, reason,
  **Discard** (the save bar's), **Save changes** (the page's save), **Done**. A viewer gets a read-only grid
  and **Close**.
- **Layout:** the `Dialog` `full` variant with `keepInputs` (the grid's inputs
  keep their own widths; other dialogs stretch text fields to the dialog's
  width). The grid scrolls inside the modal; the title and the save row stay
  put. On a phone (≤ 640 px) a `full` dialog takes the whole screen, and the
  grid shows its phone layout (cards).

On a phone (≤ 640 px) the crop-factor and planted-area grids (in the grid
modal and override mode) turn each row
into a card with visible labels: the crop name (with reorder and remove) on
top, the twelve factors four to a row and the mean below; each farm's crops two
to a row with its total, and a totals card last. Every field is on screen
without scrolling the table sideways. The read-only demand preview stays a
table that scrolls. With no farm or crop yet, the Planted areas note links to
the Network tab. The node table does the same, one card per node (§ The
node table above).

## Transfers

A page of two cards under the section header, which counts the rules ("3
transfer rules · 2 active", `workspace/context.ts`) and carries **Show on the
map** (the Network, where transfers are dashed arrows) and **+ Add transfer**
(editors, with at least two units). A new rule starts after the existing ones
(the highest priority + 1), and the cursor lands in its **From**, scrolled into
view.

**Transfer rules** is one row per rule: its number (with **off** under it when
the rule is switched off, and a tinted row), **From → To** (side by side from
an 80rem-wide container, stacked below that), its **max rate by month**
(engine ≥ 1.14.0, `transfers/MonthRates.svelte`: twelve m³/s fields in
water-year order, six to a row, all twelve in one row where the cell is 40rem
wide; a blank month is off; under them the months in words with the largest
rate, and **… in every month**, which puts the largest rate in all twelve). A
workbook rule with one rate in its ticked months shows that rate in each of
them and runs as before; the first edit gives it its own rate per month
(`monthlyRateM3s`, with `months` and `maxRateM3s` kept in step), then an
optional daily cap (m³), **Takes from** (engine ≥ 1.14.0): *The source’s
dam*, with the minimum source-dam storage (%) below which it stops, or *The
river (an off-take)* ([model.md §2.6a](./model.md)), whose fields replace the
minimum there: a hands-off flow (m³/day, blank = none), the losses on the way
(%), how much it takes (*What the destination needs* or *Up to capacity*, like a canal that runs full),
and switches for leaving the EWR in the river and topping up the
destination’s dam; then a **Priority**, an **On** switch
(named "transfer N enabled") and remove. Priority is a whole number, lower
moves first; equal priorities share a source dam pro rata to their limits
([engine-audit Q18](./engine-audit.md)). The help explains the destination's
room cap (N4). Thirty rules fit at 1280 × 800 without scrolling the table
sideways.

**When water moves** has a bar per month, Oct … Sep: how many enabled rules
run in it and the most they can move in a day together, each rule's
min(the month's rate × 86 400, daily cap) summed (`transfers/capacity.ts`). It is an upper
bound: on the day the source dam's minimum and the destination's room also
limit it. A screen reader hears each month as a sentence ("Nov: 2 rules, up to
6,912 m³ a day").

From 1100 × 620 the two cards are the height left in the window (less the save
bar) and the page doesn't scroll: the rules scroll inside their card and When
water moves takes what they leave, so with a few rules its bars are tall and
with thirty they keep a strip at the bottom. The empty state says what a
transfer is (most catchments have none) and has its own **Add transfer**; with
fewer than two units it links to the Network tab.

In a container up to 64rem (a phone, a narrow window) each rule becomes a card,
two to a row where there is room: "Transfer N" with its remove button on top,
From and To side by side, the month rates six to a row at tap size (44 px), the daily cap
and priority side by side, Takes from across the card (its selects and switches 44 px), then the
numbers and an **Enabled** switch whose label is part of the tap target. The
column headers and their ⓘ tips move into each card's field labels, the page
scrolls rather than a box inside it, and the months show six to a row.

The Network's **Transfers** grid (`grid=transfers`) and scenario override mode
show the same table alone, with **+ Add transfer** under it and no months
card.

## On this page menu

The long workspace pages share one in-page menu, `common/SectionNav.svelte`
(its rules in `common/sectionNav.ts`): **Settings & calibration**, **Runs &
results**, **River & reserve**, **Hydrological units** and **Data**. Each page
gives it its sections in groups (a `nav` labelled "Settings sections",
"Result sections", "River sections", "Hydrological units sections", "Data
sections"); each group is a list named for screen readers, set apart by a
wider gap. The dashboards that fit the window (Summary, Network, Crops,
Dams, Transfers, Scenarios) and the pages with at most two panels past their
first screen at 1440×960 (Allocations, Project, Compare runs, Applications)
have none (surveyed 2026-09-27 with the example catchments); History is left
to its own redesign.

- **Two rows at most** from 641 px. The links flow like words, so a group
  may break across rows; laid out as whole blocks, a long group pushed the
  next onto a row of its own, and Runs & results took three rows at 1280 px
  with Summary alone on the first. What still doesn't fit goes, in page
  order, into **More** at the end of the bar (`navFitCount`, from a hidden
  copy of every link measured in its widest, marked state, refitted when the
  bar's width, the labels or the fonts change). At 1440 and 1280 px every
  page's links fit without More; at 1024 px Settings and Runs use it.
- **More** is a disclosure button ("More sections", `aria-expanded`) with a
  menu under the bar's right end that lists its links under their group
  names. Enter or a click opens it; Tab moves into its links; Escape closes
  it with focus back on the button; a click outside, focus leaving it, or
  following one of its links closes it. When the section being read is in
  it, More is marked like a link and its name adds "including the one being
  read".
- **Sticks and marks.** It sticks at the top (under the phone bar on a
  phone), marks the section being read with `aria-current="location"`
  (`activeSectionId`: the last section whose top has passed under the menu,
  or the last at the bottom of the page), and raises the page's
  `scroll-padding-top` by its height, so a jumped-to section or a focused
  control clears it. It sits at the page's top level (Settings: above the
  form), so it stays stuck to the last panel.
- **Phones** (up to 640 px): one strip that scrolls sideways inside itself
  with every link (no More), the marked link kept in view, never the page.
- `e2e/tests/section-nav.spec.ts` pins the rows at 1440 and 1280, More's
  keyboard use and axe scan at 1024, the phone strip, and each new page's
  menu, jumps and loaded links.

## Data

`?tab=series` (`?tab=data` and `?tab=timeseries` also work;
`series/SeriesTab.svelte`), under **Build the model** (issue #17, option A;
no board of its own, so it follows the Dams page's list-and-chart layout
with the table the data needs).

- **Header**: the section header titled "Data", its context line counting
  the series and those behind ("5 input series · 2 behind",
  `workspace/context.ts`), then the Rain up to pill, **Preview all data**
  (filled through `fillHeader`; absent with no series) and **Add data**, the
  main (primary) action for editors. The tab's own notices (new data since
  the latest run with its *Re-run the model* link, a feed rebuilding a
  series, a failed delete or relabel) are slim lines under the header, like
  the page's.
- **Freshness first**: the table lists the series **behind** first, most
  days behind first, then the series a run reads, then the rest (another
  series of that kind is read, reference only), keeping the list's order
  within each group (`series/freshness.ts` `freshnessOrder`). *Behind* is
  exactly the sidebar badge's rule (`freshness().behind`): a series a run is
  driven by (recorded rain, daily A-pan) ending more than 7 days
  (`STALE_DAYS`) before the viewer's date; a forecast runs ahead and observed
  flow only scores a run, so neither is. Each such row carries a **Behind**
  pill beside its age and an amber edge, the key line says what it means,
  and the panel head repeats "2 behind (more than 7 days old)", so the
  table, the header and the badge always give the same count. **Data up
  to** is the column straight after the series. (Until 2026-09-26 any row
  older than 31 days, flow included, was amber, which disagreed with the
  badge.) Ages read "2 months ago" from 60 days and "2 years ago" from 730
  (`describeAge`; those two days used to read "1 months" / "1 years").
- **Picking a series**: clicking a row (or its **View** button) charts it
  through the URL (`series=<id>`, `withParam`), so the link can be shared
  and Back returns to the series before. Without `series=` (or with one that
  no longer exists) the observed flow a run reads is charted, else the main
  rainfall, else the first. Deleting the charted series drops the parameter
  (`replaceState`); an upload through the form below charts the new series.
  When the layout is stacked, the chart comes into view after a pick.
- **Layout**: when the page is at least 720 px wide and the window at least
  720 px tall, the table and the chart are the height left in the window
  below their top (measured with a `ResizeObserver` on `body`, less the save
  bar; at least 540 px): the table takes up to 55 % and its rows scroll
  inside its box (the sticky column headers stay), the chart fills the rest
  (the plot takes what the chart's head, legend and caption leave). Shorter
  or narrower, the page scrolls as before, and below 640 px each row is a
  card. The gauge-vs-logger table, the double mass panel, Data checks, the
  Upload CSV form and *What the model uses* follow below.
- **On this page.** Once there is a series, a **Data sections** menu
  ([§ On this page menu](#on-this-page-menu)) sits under the header, above the
  table (the fitted table and chart take the height left below it), and sticks
  down the panels under the chart: **Series** (`#data-series`), **Chart**
  (`#data-chart`, with a series picked), **Gauge vs logger**
  (`#data-agreement`), **Double mass** (`#data-double-mass`), **Data checks**
  (`#data-checks`), **Upload CSV** (`#upload-csv`, editors) and **What the
  model uses** (`#data-uses`), each only when the page draws it
  (`series/sections.ts`, `dataNavGroups`), in three groups named for screen
  readers (Series, Checks, Adding data). A loaded `?tab=series#data-…` link
  lands on its panel once it is drawn, held there (`holdAnchor`) with focus on
  its heading.
- **Add data from the header** refreshes the table at once: the tab takes
  the page's new series list when it changes (before 2026-09-26 the table
  kept its own copy until the page was reloaded).

Each series shows its role in the model, its last date and age, its period,
% missing, a typical value (mean annual rainfall in mm/a, or mean flow), and
a strip showing coverage per year. Series a run won't read (not the first of
their kind by name) are marked. Editors can **Delete** a series (after a
confirm; runs already stored are not affected). A CHIRPS series shows which
product and version it holds (issue #40 part c): editors get a select
(*Version not recorded*, CHIRPS v2.0, CHIRPS sat v3.0, CHIRPS rnl v3.0) that
relabels it without touching its values (`PATCH …/series/:id`), viewers the
words. The **Upload CSV** form asks the same for a CHIRPS file (*Not known*
by default, or the existing series' own label when appending to it); a
merge of another version into a filled series is refused by the server with
its reason. An observed or logger **flow** record also shows **where it was
measured** when the model has a gauge above the outlet (issue #64, engine ≥
1.4.0, [data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)):
editors get a select (*At the outlet*, or *At gauge &lt;name&gt;* for each such
gauge, `PATCH …/series/:id { siteNodeId }`), viewers the words. A record at a
gauge is badged *Gauge record (checks only)*: the run checks it against the
simulated flow there (Runs & results → Plausibility checks), and it is never
the outlet's record, whatever its name (calibration, the EWR test, the
*What the model uses* badges, the setup checklist and the fit panel's
records read only the outlet's). A record whose gauge has left the model says
so, until it is moved. The alternative catchment gauge and the reanalysis (engine ≥
0.30.0, issue #40 (b)) take an optional free **Product** and **Version**
instead (e.g. SASSCAL AWS / 1), shown on their row; both kinds are marked
*Not used: no rain-source period names it* until Settings → *Rain source
periods* names them. The **daily A-pan evaporation** kind (*Evaporation —
A-pan, daily*, `evap_apan_mm`, engine ≥ 0.38.0, issue #45) is listed and
uploaded like rain (mm, cm or in, stored in mm), badged *Daily evaporation*,
with a mean annual total in its row like a rain series; a file whose name or
header says evap, A-pan or A pan is guessed as that kind, and a newer daily
A-pan record counts as new data since the last run. It replaces the monthly
A-pan means on the days it covers ([model.md §2.3a](./model.md#23a-daily-a-pan-evaporation-engine--0380-issue-45)). A CSV with several timed readings a day (an automatic
station's hourly log) is not refused: the form asks how to add it up into
days, **08:00 to 08:00, booked to the day it starts** (the default, the
manual-gauge day) or **midnight to midnight**, and its summary says how many
readings, how many a day and how many days are short of that. Each
timestamp closes its interval. The series records the choice
(`dayBoundary`), shown as an *08:00 day* tag on its row, and a merge of the
other window into it is refused ([model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)).
Below 640px wide each row becomes a card
(series and role on top, then labelled Data up to / Period / Missing (% of
days) / Typical (mean), the coverage strip, and the buttons wrapping underneath), so a phone
never has to scroll the table sideways; explicit table roles keep it a table
to screen readers, and the card labels are silent to them. For editors the
**Upload CSV** form follows the series panels in reading order, so on a phone
it sits right below them rather than after the whole *What the model uses*
reference (wide screens still show it on the right); the empty state points at
it. Uploads read year-last dates (DD/MM/YYYY or
MM/DD/YYYY) in one order for the whole file, from any part above 12 (a file
mixing both is rejected; one with no part above 12 assumes day/month and the
summary says so), and YYYYMMDD. The delimiter (comma, semicolon or tab) is
worked out from the file's rows, outside double quotes, and quoted fields may
hold it. The decimal separator is decided once per file (`lib/series/csv.ts`,
issue #45): a value that settles it (12,5 · 0,359 · 1.234,5 say decimal comma;
2.5 · 1,234.5 say decimal point) sets it, thousands separators (spaces, or
commas or dots in valid groups) are dropped, a file mixing both conventions is
refused naming a line of each, and in a semicolon or tab file with nothing to
settle it a value that reads either way (1,234) is refused rather than guessed
(a comma file defaults to the decimal point, since its unquoted values can't
hold a decimal comma). A row split by another delimiter than the file's is
reported as that, not as a bad date. **DWS hydrology exports** load as they
are (`lib/series/dws.ts`, picked by `lib/series/file.ts`): the fixed-width
daily table HyData.aspx prints (`DATE D AVG F/R QUAL`, YYYYMMDD), as text or
the saved page, or headerless `YYYYMMDD value [quality]` rows. Rows are read by
the automatic DWS feed's own code (`@water-management/engine/dws`), so a
missing-data quality code (151, 165, 170, 172, 246, 247, 255), a blank value or
a negative placeholder such as -999 is a gap, never a value. The summary adds a
*DWS export* line (rows, the value column as the file's format block describes
it, and how many rows were read as gaps and why) and the quality codes met; a
sub-daily DWS export (a TIME column) is refused. A plain date,value CSV reads
a negative value as a gap too (issue #51: every kind is a rain, flow or
evaporation, so −999 or −1 is a "no reading" placeholder), and its summary
adds a *Negative values* line with how many (`csv.ts` `negativeGaps`). In number fields, a comma is a thousands separator only in a
valid grouping (1,500); otherwise a single comma is a decimal comma (1,5 = 1.5). The chart opens on the last 3 years and has
a log scale for flows. When both a gauge and a logger flow exist, a table
compares them per water year (engine `observedAgreement`) and flags years
where they disagree, using the project's thresholds from Settings → *Data
quality*. A **Data checks** panel lists negative values, outliers and flat
stretches found in each loaded series (engine `checkSeries`), plus the
catchment-rain checks for missing data recorded as 0 (issue #2): a **Zero rain
run** badge for long zero stretches in the wet season, and a **Low vs CHIRPS**
badge for water years far below the usual catchment / CHIRPS share (engine
`rainVsChirps`, on the first catchment and first CHIRPS series by name, as a
run reads them). These are the same checks a run reports as warnings; rules in
[model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree).
Charting that catchment rain series tints the days a run will treat as
missing (flagged zero runs and listed periods, per Settings → *Zero-rain
runs*; `series/zeroRain.ts` over the engine's `zeroRainMask`), with a caption
naming the periods and days ([model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)).
It also tints the multi-day accumulation windows a run will spread by CHIRPS
(engine `rainAccumulations`, judged against the first CHIRPS series by name
and the CHIRPS bias setting, as a run does), and the caption counts them and
their days ([model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations)).
`LineChart`'s `shade` prop draws the bands.
When both catchment rain and CHIRPS are loaded, a **Double mass: catchment
rain vs CHIRPS** panel (`series/DoubleMassPanel.svelte`, data from
`series/doubleMass.ts` over the engine's `doubleMass`, with the project's
zero-rain settings deciding which days are suspect; engine ≥ 0.18.0, CR-20)
says in a sentence whether the ratio breaks, then draws cumulative catchment
rain against cumulative CHIRPS (water-year points, the whole-record line
dashed, the segments between breaks solid, each slope in the caption), a
small chart of the departure from the whole-record line by water year, and a
collapsible table of the water-year totals (the charts' text equivalent).
It needs 10 judged water years; without them the panel is absent. A break
also shows in Data checks with a **Double mass vs CHIRPS** badge
([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
"What the model uses" explains every kind. A **reference gauge (other
catchment)** series (`flow_reference_m3s`, e.g. imported with
`--gauge-as-reference`) is badged *Reference only*: it can be charted here as a
regional wet/dry index, but runs never read it, it is not in the gauge-vs-logger
table and it can't be picked as the calibration record. Each series can be
downloaded as CSV.

**Preview** (`series/SeriesPreviewDialog.svelte`, in a modal `Dialog.svelte`)
opens a searchable table of every loaded series' daily values side by
side, in a near full-screen dialog (`Dialog`'s `full` size: up to 1600px wide
and the window's height, with the table filling what's left and only the rows
in view rendered), one row per day across the union of their periods, plus columns for how
the model actually used that day's data — not only what checkSeries flags.
The section header's **Preview all data** button opens it with every column shown; a
row's own **Preview** button opens the same dialog with that series' column
un-hidden, scrolled into view and highlighted. Number columns have right-aligned headers, so each value sits under its own header; the date and the Excluded column stay left-aligned. Alongside each series' own
column (same label, unit and order as the table above, with its
`checkSeries`/`seriesRowFlags` quality flags on the value) is a **column
picker** grouped into *Series* and *How the model used it*: a m³/day column
for every flow series; **Rain used (model)** and its source (catchment / CHIRPS /
forecast / none) after gap-fill; the **CHIRPS bias factor** for that calendar
month and the **CHIRPS (corrected)** value (respecting Settings → *CHIRPS bias
correction*); and **Excluded from calibration**, with its reason, for any day
inside a Settings → *Calibration exclusions* period. Every column header,
Date included, carries an ⓘ `HelpTip` saying where that number comes from, how
it is derived and what it tells you: a raw series column reuses its kind's
`series.<SeriesKind>` entry, and each derived column has its own
`preview.<column>` entry (`preview.date`, `preview.flowM3Day`,
`preview.rainUsed`, `preview.chirpsFactor`, `preview.chirpsCorrected`,
`preview.excluded`), the key set per column in `series/preview.ts`. The bubble
is a top-layer popover, so the sideways scroll and sticky header don't clip
it, and Escape closes the tip without closing the dialog. A header shows its
unit once: the m³/day columns name it in their label, so no second `(m³/day)`
follows. The derived columns are
computed with the engine's own `prepareRun`/`rain.ts`/`calibrate/provenance.ts`
(the same functions a run uses), not recomputed separately, so they are blank
for any day outside the model's own run window. The search box takes a date
prefix (`2015`, `2015-03-14`) or a value comparison (`> 20`, `= 0`); *Missing
only* and *Flagged only* look only at the currently visible series columns.
Rows are virtualised (fixed row height, only the rows near the scrollport are
real `<tr>`s) so a multi-year daily record doesn't put thousands of rows in
the DOM at once. As in Download → Preview, each body row is exactly 28 px,
border included, and a spacer row exists only when it has height, so the
first day starts right under the header and the last day sits at the foot of
the box on a fifteen-year record; the pinned date keeps the row's hover, and
the scroll box is a focusable, named region, so it scrolls from the keyboard
(`series-preview.spec.ts`, with a11y scans at desktop and phone). This is a read-only view of what's already loaded; a CSV
export of the same model-used columns is tracked separately
([followups.md](./followups.md)).

The download menus (`export/DownloadMenu.svelte`) open fixed to the window,
below their button or above it when there's no room
(`lib/export/menuPosition.ts`), so a table's scroll box never clips them;
scrolling or resizing closes an open menu.

The run downloads (in the results' Download menu) are where the numbers can be
checked outside the app. A farm's **daily CSV** has every column in the
workbook's FarmTemplate order, the letter in each header
(`Irrigation supplied [G] (m³/day)`), the working columns between them and the
balance check `[V]` next to outflow. **Fragmented flow — all hydrological units** and
**Fragmented EWR — all hydrological units** (only when the run has farms) put one series
of every farm side by side, a date column then a column per farm, like
the workbook's `[Fragmented flow]` (I) and `[Fragmented EWR]` (Y) sheets.
Every daily CSV starts with a `# run=…; engine=…; runoff_model=…; created=…;
period=…` line (a farm's also `dam_capacity_m3=…`), so a renamed file still
says which run made it; the header is the next row, so read it with
`pandas.read_csv(…, comment='#')` ([api.md § Export](./api.md)). Each
of the two has a **Preview** button beside it in the menu, which opens the
table in a near full-screen dialog (`export/DailyTableDialog.svelte`, its own
chunk): the dialog fetches the export and parses it (`lib/export/dailyTable.ts`),
so it shows exactly the file, then **Download CSV** saves that same response.
The parser takes every leading `#` line: the provenance line is kept apart from
the table, and a legacy run's (its warning line, or `runoff_model=legacy`)
shows the legacy-model warning above it.
The header row and the date column stay in view, numbers are right-aligned
under right-aligned headers (to the precision the charts use, `fmtReading`), a
date prefix (2015, 2015-03) narrows the rows, and closing it returns focus to
the Download button. Only the rows in view are rendered, as in the Data tab's
preview: each body row is exactly 28 px, border included, and the spacer rows
exist only when they have height, so the first day starts right under the
header and the last day sits at the foot of the box on a 30-unit, two-year
table. The table's scroll box is a focusable, named region, so it scrolls from
the keyboard (`download-preview.spec.ts`, with a11y scans at desktop and
phone). The **summary CSV** adds the self-checks,
the water balance per water year and a column guide giving each letter's
formula ([api.md § Export](./api.md)).

**Workbook (.xlsx)**, first in the run's Download menu, puts the whole run in
one file: the summary, a daily sheet for the catchment and for every node in
network order, curtailment, the EWR grid, Reserve compliance, annual volumes,
the data checks, the inputs and the warnings, every number at full precision
with a display format per column ([api.md § Export](./api.md#export)). It is
built in the browser: picking it closes the menu and shows, under the button,
a progress bar and "Fetching Upper farm (3 of 9)…" per node, then "Building
the workbook…", with **Cancel**, which stops at once and saves nothing. A
failed fetch shows "Workbook failed: …" with the server's reason (a `413`
included) in the menu's status line. The phone layout keeps the same menu and
progress, wrapped under the button. Leaving the tab stops an export still
running. The workbook code loads only then, in a worker, never with the page.

## Settings & calibration

A reading page (issue #17, option A): the long form scrolls under the
section header, which it fills (`fillHeader`) like the other sections.

- **Header.** The context line says where the GR4J parameters in the form
  came from (`fitSummary`, `settings/calibration.ts`): "GR4J · fitted 15 Jan
  2025 · KGE′ 0.93 in calibration" (the fit record's day and its in-sample
  score on its own objective), with "· changed since the fit" whenever the fit
  record below lists a caveat (a parameter edited by hand, the forcing, the
  window or the record changed; it follows the unsaved form), or "GR4J · no
  fit record: the parameters were set by hand or imported". The actions add
  **Fit the parameters** for editors (a link to `#set-fit`), or **Fit record**
  for a viewer when there is one, before Add data and Run model. The old
  intro paragraph is gone: the header and the menu's groups say what it
  said, and the monthly tables' own Oct … Sep headers show the water year.
- **Links into a group** (`?tab=settings#set-ewr`, a note's link from the
  Project page's recent notes, `notes.ts` `noteHref`; `?tab=calibration`
  still works) land on that group once the tab's chunk has drawn it, held
  while the page settles (`holdAnchor`), with focus on its heading. Before,
  the browser's own jump ran before the lazy tab existed and the page opened
  at the top.
- **On this page.** Under the header, a **Settings sections** menu links to
  each group (`#set-demand`, `#set-flow`, `#set-rain`, `#set-record`,
  `#set-fit`, `#set-wr2012`, `#set-share`, `#set-ewr`, `#set-reserve`, `#set-period`,
  `#set-quality`, `#set-outcomes`, `#set-outlook`, `#set-auto`, then after the
  form `#set-feeds`, `#set-api-keys` (owners only) and `#set-report-schedules`;
  listed by `settings/sections.ts`, `settingsNavGroups`), in three groups
  named for screen readers and set apart by a wider gap: **Model inputs**
  (Demand … Simulation period), **How results are read** (Data quality,
  Outcome matrix, Seasonal outlook: they change no result) and **Runs, feeds
  and reports**. It is the shared in-page menu
  (`common/SectionNav.svelte`, [§ On this page menu](#on-this-page-menu)),
  above the form rather than in it, so it stays stuck down the panels after
  the form too (inside it, it scrolled away at Data feeds): a bar of pill links
  that sticks at the top (under the phone bar on a phone) down the long form and marks the group
  being read with `aria-current="location"` (scroll spy: `activeSectionId`
  in `common/sectionNav.ts`, the last section whose top has passed under the
  menu, or the last one at the bottom of the page). A group with a Save
  blocker gets a red dot ("has a problem" to screen readers). It is a bar
  rather than a side rail because the monthly input rows need the full
  width. On phones it is one strip that scrolls sideways inside itself (the
  marked link kept in view), never the page. While shown, the menu raises
  the page's `scroll-padding-top` by its height, and this tab sets
  `scroll-padding-bottom` to the save bar's, so a jumped-to group or a
  focused control is never hidden under either (WCAG 2.4.11).
- **Save bar.** Sticky at the bottom (above the model save bar when that
  shows), with "Unsaved settings", **Discard** and **Save settings** (editors
  only). When something blocks Save it says how many groups have a problem
  and links to each one (`saveBlockers`; the link's accessible name carries
  the message), and that group's menu link gets a red dot ("has a problem").
  Each problem is also shown next to its field. The bar ends with the form;
  a line under it tells editors that Data feeds, API keys (owners) and
  scheduled reports save as they change, not with Save settings.

The settings are grouped by what they drive. Every 12-month row (A-pan, pan
coefficient, EWR, the WR2012 monthly flows) fits a 1280px screen beside the
app sidebar without sideways scrolling: a month cell is as narrow as a
six-digit value such as 250000 allows (sized in the input's own digits, no
spin buttons, as in the Network table; arrow keys still step), spare width is
shared out between the months and the row label, and the label wraps before
the row scrolls.
At 320 px the whole tab reflows with no sideways page scroll (WCAG 1.4.10):
selects and period lists shrink to the screen, and only the section menu and
the monthly tables scroll, inside their own boxes (`e2e/tests/reflow.spec.ts`,
which checks every catchment tab).


- **Demand**: A-pan (Oct–Sep), with a line under it saying where the model's
  A-pan comes from (`apanSourceNote`, `settings/peInput.ts`, engine ≥ 0.38.0,
  issue #45): the project's **daily A-pan series** on the days it has a
  value, these monthly means filling the rest, or these monthly means on
  every day (with a pointer to the Data tab); nothing while the series list
  loads. Effective rainfall %, the **soil-water store**
  (mm, `settings.effectiveRainStoreMm`, default 25; 0 carries no rain over, as
  the workbook does; [model.md §2.3](./model.md#23-irrigation-demand) step 4),
  the **dam evaporation factor** (× A-pan, `settings.lakeEvapFactor`, default
  0.75, 0 off; the hint warns that WR90 lake factors are S-pan based;
  [model.md §2.7a](./model.md#27a-dam-evaporation-rain-on-the-dam-and-seepage-engine--0150-audit-n2)),
  and days in February.
- **Calibration is four panels**, each its own menu entry, rather than one
  long one: Flow calibration, Rain gaps and CHIRPS, Calibration record and
  Fit automatically, in that order.
- **Flow calibration (rain → natural flow)** (`#set-flow`): the **runoff
  model**, shown read-only as "GR4J (Perrin et al. 2003)" (`RUNOFF_MODEL_LABEL`;
  there is no picker since engine 1.0.0, issue #16). Its hint says the legacy
  b023 workbook model was removed in engine 1.0.0 and that runs made with it
  still open, labelled, but can't be re-run. A stored legacy run keeps its
  amber "Workbook comparison" badge on the Runs list and the run header, a
  matching label on its CSV exports, and run comparison notes it when either
  side is legacy. Then the catchment area (blank = the sum of the farm areas,
  which is shown), then GR4J's parameters. (Until engine 1.0.0 a Legacy
  choice showed a, b, the season factors, summer months and, under
  Advanced, the recession tables; they are gone with the model.)
  - **GR4J**: X1, X3 and X4, each with its typical and allowed range
    (`settings/calibration.ts` `GR4J_FIELDS`, bounds from the engine). The
    input refuses values outside those bounds, and shows at most three
    decimals (display only: a fit writes nine, which stay stored until the
    field is edited). The GR4J view also has the
    warm-up in days and the rain threshold, which under GR4J only affects
    demand. X2 is behind a "Let the catchment gain or lose groundwater" checkbox;
    unticking it sets X2 back to 0.
    Then the **Areal rainfall correction** group (`settings.arealRain`,
    engine ≥ 1.13.0, `settings/arealRain.ts`;
    [model.md §2.4g](./model.md#24g-areal-rainfall-correction-engine--1130)):
    a checkbox "Scale the rain GR4J runs on to the catchment's areal rain"
    (on: × 1 in every month, method Independent MAP, source blank; off:
    null, and the correction switched off comes back if ticked again before
    saving). On, it shows a "Factor in every month" input (fills all twelve;
    blank when the months differ), a "Derived from" select (Independent MAP,
    Rain gauges, Fitted to the flow record, each with its hint), the twelve
    monthly factors (0.25–4, Oct … Sep) and a required Source. A factor out
    of range or a blank source blocks Save, with the message beside the
    source and in the save bar. The fit record lists the correction it ran
    under ("Areal rainfall correction"), and the report's inputs table
    shows it.
    After it comes
    the **GR4J potential evaporation** group (`settings.pe`, engine ≥
    0.31.0, issue #39, `settings/peInput.ts`;
    [model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)).
    Two radios choose where GR4J's PE comes from: **Pan coefficient ×
    A-pan** (the default) and **Monthly PE, entered directly**. Under them a
    line gives the annual total GR4J runs on: "Annual GR4J PE: N mm (pan
    coefficient × A-pan; A-pan M mm a year)", or "… (the monthly PE row
    below)". The note under it depends on the choice. Under pan: the A-pan
    row (Demand) also drives irrigation demand and dam evaporation, so
    changing it moves all three. Under monthly: demand and dam evaporation
    still use the A-pan row, and GR4J doesn't use the pan coefficient.
    - **Under pan coefficient × A-pan**: a **preset** picker (Generic (flat
      0.70), Winter rainfall (e.g. Western Cape), Summer rainfall —
      indicative, from FAO-56 Table 5 climate classes, Allen et al. 1998;
      model.md §2.4a) fills the pan-coefficient row with a starting point;
      the row stays editable after, and the preset's name goes into the
      **Pan coefficient source** note below the row. Below it, a collapsed **Suggest from
      FAO-56 Table 5 (humidity, wind, siting)** helper
      (`settings/PanCoefficientHelper.svelte`, part of the Settings tab's
      chunk, hidden on a read-only view): the pan siting (Case A, green crop, or
      Case B, dry fallow) as radios, the windward fetch as a select (1, 10,
      100 or 1000 m), an optional reduction for bare surroundings (0–20 %),
      the mean RH (%) and wind at 2 m (m/s) for each of the 12 months, and a
      required "Where the RH and wind came from" note. **Fill the
      pan-coefficient row** replaces the 12 values in the form only, and
      writes the table cells used plus the RH and wind note into the **Pan
      coefficient source** note: nothing is saved until Save, and the values
      and note stay editable. The button stays
      disabled, with the reason beside it, until every month has a valid RH
      and wind and the note is written. Then the monthly **pan coefficient**
      row. A warning appears under the row when a month sits outside
      FAO-56's usual 0.6–0.85 range for a Class A pan — a plausibility
      check, not a hard limit, so a value further out still saves. Under
      the row, an optional **Pan coefficient source** text field (up to 600
      characters, engine ≥ 0.31.1): where the row came from. Fit provenance
      shows it as a "Pan coefficient source" row when a fit recorded one,
      and the report's inputs add it to the GR4J potential evaporation line
      under pan coefficient × A-pan.
    - **Under monthly PE**: the preset, the helper, the pan-coefficient row
      and its warning are hidden. A 12-month **Monthly PE (mm)** row, with a
      Year total, and a required **Source** field take their place.
      Switching to monthly starts the row from the current pan coefficient ×
      A-pan, rounded to 0.1 mm, so the annual total doesn't jump, with the
      source blank. Switching back to pan and then to monthly again restores
      the row switched away from, until the settings are saved. Save is
      blocked while the source is blank or over 600 characters, or a month
      is outside 0–10 000 mm. A row of zeros saves.
    A separate notice appears when GR4J's PE is 0 in every month (A-pan ×
    pan coefficient, or the monthly PE row): the engine then refuses GR4J
    runs and fits. Under pan coefficient × A-pan a daily A-pan series counts
    as evaporation, so a project with one isn't warned.
- **Rain gaps and CHIRPS** (`#set-rain`): the **CHIRPS bias correction**
  picker (`settings.chirpsBiasCorrection`, `settings/rain.ts`: bias-corrected
  per month, the default, or raw CHIRPS; it applies to the runoff model and to
  demand, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
  A run that corrected CHIRPS lists the monthly factors and the number of
  days in its warnings. Below it, **CHIRPS fit period** (always shown; with raw CHIRPS it says it is unused but kept, and an invalid list still blocks Save where it can be fixed)
  (`settings/ChirpsFitPeriodSection.svelte`, `settings.chirpsFitPeriod`,
  engine ≥ 0.29.0): "Whole record (default)" or "Listed water years", the
  latter with rows of from / to water year and a required reason
  (overlapping or reasonless ranges block Save). **Propose from the
  double-mass breaks** (`settings/proposeFitRanges.ts`, pure part
  `fitRangeProposal.ts`) loads the catchment rain and CHIRPS and fills the
  list with one range per double-mass segment, each reason saying it is a
  proposal; nothing is saved until Save, and the hint says to check each
  range against the station history, since a detected break can be a year
  or two off ([model.md §2.4b *Fit period*](./model.md#fit-period-and-per-range-factors-engine--0290-issue-40)).
  Fit provenance shows the fit period and the factors per range, with the
  years each was fitted on, that the fit ran under. Below it, **Zero-rain runs in the catchment rain**
  (`settings/ZeroRainSection.svelte`, `settings.zeroRainRuns`,
  [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)): a
  **Flagged zero runs** picker ("Treat as missing (default)" or "Run as
  recorded (dry)"), then **Keep dry** (only in the default mode) and **Also
  treat as missing** period lists. These share the calibration exclusions'
  editor (`common/PeriodList.svelte`), with the same required reason and the
  same checks that block Save. The Keep dry hint says that kept-dry days
  count in the CHIRPS factor fit, filled runs are left out of it, and a run
  warns and leaves the year out when CHIRPS reads a lot of rain over a
  kept-dry run (engine ≥ 0.18.0, model.md §2.4b). Then **Multi-day
  accumulations** (engine ≥ 0.20.0, same component,
  [model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations)): an
  **Accumulated readings** picker ("Spread over the days they cover", the
  default, or "Run as recorded (one day)"), then **Keep as recorded** (only
  when spreading: readings confirmed as one day's rain) and **Also spread**
  (windows listed by hand, ending on the reading day), on the same period
  editor. The help entry *Multi-day rain accumulations* explains the
  detection rule. Last, **Rain source periods**
  (`settings/RainSourceSection.svelte`, pure part `settings/rainSource.ts`,
  `settings.rainSource`, engine ≥ 0.30.0,
  [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)):
  *None* until **Add a rain-source period**, which starts one over the last
  five complete water years from the alternative catchment gauge, fitted
  against the reanalysis over the ten years before, with a blank reason
  that blocks Save until written. Each period has From / To dates, a
  Reason, **Factors** (*Fixed monthly factors, with where they came from*:
  twelve factors Oct … Sep, 0.25–4, and *Fitted by*, *Fitted on, from* /
  *to*, *Method*, all required; or *Fit against a reference series*: the
  reference, reanalysis or CHIRPS, and the reference era's water years),
  **Gaps from** (CHIRPS × the CHIRPS fit-period factors, or the reanalysis
  with the water years its factors are fitted on) and **CHIRPS ingests this
  gauge in this period**, which refuses CHIRPS as the reference and needs a
  reanalysis fallback. **Quantile-map its wet days onto the catchment
  series** (engine ≥ 1.20.0, issue #66, off by default) adds the water
  years to map onto (the fit's reference era, or the ten water years before
  a fixed-factor period, to start with) and **Wet day from (mm)** (1 mm,
  0.1–10); a hint says what it does and that each run reports the heavy-day
  share either way. The form blocks Save on the engine's own check
  (`rainSourceError`, which the API uses too), with the first problem
  shown under the list. It doesn't reuse the period editors above: its rows
  have different fields, and it is the second list with water-year fields
  (the CHIRPS fit period is the first), short of the third caller that
  would justify a shared editor.
- **Calibration record** (`#set-record`): the calibration window and flow
  series (`calibration/CalibrationWindowFields.svelte`), and the
  **calibration exclusions** (`calibration/CalibrationExclusions.svelte`):
  "Exclude a water year" and "Exclude a date range" add a row, each with a
  required **Reason**. A water year shows the dates it covers ("WY 2015/16:
  2015-10-01 – 2016-09-30"). A blank reason, a reversed range or a period
  listed twice shows an alert and blocks Save (the save bar links here).
  Excluded days are left out of Fit automatically and the run's calibration
  statistics (model.md §2.10).
- **Fit automatically** (`#set-fit`, `calibration/FitPanel.svelte`) fits the
  selected model's parameters in a Web Worker (`lib/calibration/`). It takes
  the objective, **Bounds** (a select: "Wide (default)" — each parameter's
  full calibration range — or "Typical (Perrin et al. 80 %)" — a tighter,
  published range, with a hint under it; model.md §2.10b), the model runs per
  fit (default 1 500), the **seed** (default 1; the same seed, data and
  engine version give the same fit, and the seed is recorded), the
  **starts** (default 5, 1–10: separate searches of the whole record from
  their own seeds, the best kept; model.md §2.10b), which parameters to fit
  (GR4J X2 only when exchange is on), and whether to validate. Validation
  runs the split-sample and dry → wet tests: two more fits. The run count is
  budget × (starts + 2 with validation + 1 with the WR2012 penalty), and the
  progress line names the start. The fit always leaves out the stored
  exclusions; the result line gives the bounds, the seed, the starts and the
  number of excluded periods. With more than one start a **Starts** table
  lists each start's seed, score and fitted parameters, the kept one marked,
  and a note says when near-equal scores come with scattered parameters.
  - **Also validate against** appears only when the project has both a gauge
    and a logger record. It offers the record the fit doesn't use (the
    calibration flow series above, else the default gauge) and defaults to
    "No other record". Choosing one adds an independent-record column: the
    fitted parameters scored against that record over its own days (model.md
    §2.10b). It costs no extra fit.
  - While it runs there is a progress bar (`role="progressbar"`) with the
    stage and the best score so far. **Cancel** stops the worker at once and
    discards it.
  - The result shows the engine's plain-language notes (for example "wet-year
    behaviour is weakly constrained"), current against fitted parameters, and
    a scores table. Its columns are current parameters, fitted, then each
    test's fitted part and validation part, then the independent record if
    one was chosen; the validation columns are shaded. Each column header
    gives its period: a date range, except for the dry → wet test, whose
    years interleave and are listed (for example "WY 2001/02, 2003/04"). Its rows are KGE′, year-balanced KGE′, non-parametric KGE, the NSE
    variants, the low/high-flow KGE′ on Q and 1/Q (engine ≥ 1.19.0; "–" on a report made
    before it), volume error and the FDC signatures. From engine 1.19.0
    (CR-5, model.md §2.10b) KGE′, NSE and the low/high-flow KGE′ show their
    90 % bootstrap interval in brackets ("0.62 (0.48–0.71)", "to" when a
    bound is negative), with a line saying what it is; a period of fewer than
    3 water years shows the bare score. Below it, a **benchmarks** table
    (`data-testid="fit-benchmarks"`) scores the model, the mean flow every
    day and the day-of-year climatology (±7 days) on the fit's objective,
    over the same columns, and a warning sentence
    (`data-testid="fit-climatology-warning"`) names the fitted or validation
    periods where the model scores no better than the climatology. A report
    made before 1.19.0 has neither. The formatting lives in
    `lib/calibration/fit.ts` (`scoreCellText`, `benchmarkRows`,
    `climatologyWarning`).
    With a dry → wet test, a line under the table says what ranked its
    years: the reference gauge (other catchment), "a regional wet/dry index
    that is never scored", or the fitted record's own mean flow (engine ≥
    1.19.0, `rankedByText` in `lib/calibration/fit.ts`; model.md §2.10b); the
    fit record's dry → wet line says the same.
    Under it, **How representative is the record** (engine ≥ 1.19.0, CR-34;
    `calibration/representativeness.ts`): the record's length and its mean
    rain as a share of the long-term mean in the heading, the engine's
    one-sentence summary, a table of each scored water year (scored days,
    rain, its percentile in the run's long-term water-year rain and Dry /
    Near normal / Wet), and a key naming the reference and the 33rd / 67th
    percentile thresholds (model.md §2.10b). Any limit it implies ("all dry:
    it can't show how the model behaves in wet years") is among the notes
    at the top of the result.
  - Under it, **WR2012 statistics** (`calibration/Wr2012FitTable.svelte`,
    helpers in `lib/calibration/wr2012Fit.ts`; engine ≥ 1.19.0, CR-28,
    model.md §2.10): MAR, mean of log annual flows, SD, log SD and seasonal
    index on complete water years of monthly flows, each observed, simulated,
    the signed difference, the band ("< 4 %") and a **Within** / **Outside**
    badge in words (Outside amber), or "Not computed" (the SDs with one
    year). A **Period** select switches between the fit, the current
    parameters and each test part that has a complete year. Below: how many
    are within, over which water years, and while the bands are unconfirmed
    (`WR2012_GOOD_FIT_BANDS.confirmed`) the column is headed **Indicative
    band** with a note that they come from a consultant report citing WR2012,
    not yet checked against WRC TT 689/16 and TT 690/16. A report from before
    engine 1.19.0 shows no table.
  - **Apply to form** (editors only) writes the fitted parameters into the
    form, with a **fit record** (`settings.fitRecord`, model.md §2.10b), and
    the form then shows "Unsaved settings". Nothing is stored until Save.
    Below the panel, **Fit record of these parameters**
    (`calibration/FitProvenance.svelte`) shows the record: model and time,
    objective, seed, model runs, engine version, the record and window fitted
    to, the pan coefficient and A-pan evaporation it ran under (month by
    month, or "not recorded" for a fit made before this was tracked) and the
    CHIRPS bias correction mode and zero-rain run handling it ran under (each
    "not recorded" for a `forcing` made before that field was added to it),
    the exclusions, the fitted
    values, and a table with the in-sample score ("Calibration period
    (in-sample)") next to each validation score, plus the notes. Editing a
    fitted parameter by hand shows a **Parameters edited since fit** badge and
    names the parameters at once; the server records the same on save. A
    fit of the legacy runoff model (only in a run snapshot from before engine
    1.0.0: the heading says "Legacy (removed in engine 1.0.0)"; a project's
    own settings no longer hold one, migration 064) and a change of window,
    exclusions or flow series since the fit are called out too, and a change to the pan coefficient, A-pan, PE input, CHIRPS
    bias correction or zero-rain runs since the fit shows a **Forcing changed since fit** badge
    and a caveat explaining why (evaporation trades off against X1/X3, and
    CHIRPS bias correction changes the rain GR4J sees on fallback days, so the
    fit needs redoing). So does a CHIRPS series that now holds another product
    or version than the fit ran on (issue #40 part c; the fit records it, and
    Settings compares the series a run would use), with its own caveat. The
    record's **CHIRPS series** row names the product and version the fit ran
    on, and the series' current one when it differs. Its **Daily A-pan
    series** row (engine ≥ 0.38.0, issue #45) gives the daily A-pan record
    the fit ran on (its first day, length and a 12-character SHA-256, or
    "none (monthly means only)"), and the series now when it was added,
    replaced or removed since, which also shows **Forcing changed since fit**
    with its own caveat (Settings fetches and hashes the series only when the
    record tracked one). Its **Rain source
    periods** row lists the periods the fit ran under (engine ≥ 0.30.0; a
    fit made before them ran with none), and a change of periods also shows
    **Forcing changed since fit**. Its **GR4J potential evaporation** row
    (engine ≥ 0.31.0) gives the PE input the fit ran under: "pan coefficient
    × A-pan", or the monthly total and source with the 12 values (a fit made
    before it ran on pan coefficient × A-pan). Under a monthly PE the pan
    coefficient row adds "(not used by GR4J under a monthly PE)". A change
    of kind or of the monthly row shows **Forcing changed since fit**; a
    reworded source doesn't, and under a monthly PE neither does a change to
    the pan coefficient or A-pan alone.
    Viewers can fit but not apply. With no observed record the panel says to
    upload one. The fit uses the form as it stands, and the network with
    unsaved edits if there are any.
  - When the WR2012 MAR penalty is on (below) the panel says so, the fit runs
    once more without it (stage "Fitting again without the WR2012 penalty"),
    and the result adds a table (`calibration/MarPenaltyResult.svelte`) with
    the weight: the objective score, simulated natural MAR ÷ the target (the
    scaled WR2012 MAR, or the MAR band when one is set) and the fitted
    parameters, with and without the penalty. With a band, the row instead
    reads "Simulated natural MAR ÷ band (low–high Mm³/a)" and the caption
    below says the penalty is zero inside it.
- **WR2012 check** (`settings/Wr2012Section.svelte`, helpers in
  `settings/wr2012.ts`; model.md §2.10c). Off until "Compare runs with WR2012
  naturalised flow" is ticked. Then: quaternary code, area (km²), MAP (mm,
  optional), naturalised MAR (Mm³/a), the reference period (first and last
  water year), the source, and a 12-month row of mean naturalised flow in
  **Mm³ per month** with its sum and an m³/s equivalent row, so a unit slip
  shows. Then the scaling (area, or area and rainfall; the current area ratio
  is shown), the dry-season months (from each run, or chosen), the four
  deviation thresholds (%), and the calibration penalty (off; weight 0.5).
  Ticking it shows the weight, then **Use a MAR band instead of one target**:
  unticked (default), the penalty pulls towards the scaled WR2012 MAR above;
  ticked, two fields (**Band low** / **Band high**, Mm³/a, already at the
  modelled catchment's scale — not the quaternary's) replace it, for when two
  published natural-MAR estimates for the catchment disagree.
  Blank fields and the engine's plausibility checks (MAR above the rain on
  the quaternary, monthly means more than 5 % off the MAR, a one-sided or
  inverted band) show next to the field and block Save; the save bar links
  to the WR2012 group.
- **Flow share between hydrological units**.
- **EWR**: m³/day per month, with l/s, then (under the row, so the twelve
  months get the full width) a bar chart captioned "Pragmatic EWR by month,
  Oct–Sep, m³/day" (`MonthlyBars`' `caption`) and the annual volume, the
  curtailment reporting window (also the assurance of supply's window), and
  the **annual assurance threshold** (%, `settings.assuranceAnnualThreshold`,
  default 90 %: a water year counts as met at that supply ratio; engine ≥
  0.32.0), and **Registered volumes** (engine ≥ 1.18.0, issue #72): the
  **allocation mode** (`settings.allocationMode`: *Compare only*, the
  default; *Cap use at the registered volume*; *Full allocation*, [model.md
  §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72))
  and the **comparison band** (± %, `settings.allocationTolerance`, default
  10 %, the Allocations tab's "within band"), each with its help tip and
  field history. Either is a model setting: saving it makes the latest run
  out of date.
- **Reserve rule tables** (`#set-reserve`, `settings/EwrRulesSection.svelte`,
  helpers in `settings/ewrRules.ts`; engine ≥ 0.21.0, [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)).
  Optional; with none, runs report days below the pragmatic EWR only. **Add a
  rule table** starts one at the first EWR site without one (the outlet, then
  each gauge in network order; a farm can't be a site, and a table at a gauge
  unticked as an EWR site is skipped by the run with a warning); it is disabled once
  every site has one, with a hint to add a gauge on the Network tab. Each
  table (a group headed "Rule table at …") has the **EWR site**, the
  required **Source**, the **Kind of source** (not stated, gazetted Reserve,
  desktop estimate, other; engine ≥ 1.5.0, the Reserve panel's confidence
  line), what **the table covers** (total flow, or low flows
  only), the **Unit** (Mm³ per month, or m³/s, the month's mean), where the
  **natural-flow percentile** comes from (the run's natural flow at the site,
  the default, or the table's natural flows), a **scale** (1 unless the table
  is for a different catchment size), the optional **Natural MAR in the
  determination** (Mm³/a, engine ≥ 1.11.0; blank = not recorded; its hint
  says the run warns beyond ±15 % when the percentile is from the run) and the **% points** (default 10, 20 …
  90, 99; changing them keeps each value under its point and leaves a new
  point blank). Then the **EWR** grid (Oct … Sep rows × one input per point,
  each labelled "EWR, Oct, 10 %, Mm³"), and the **Natural flow** grid when the
  table is the natural source. **Paste from a spreadsheet** takes the 12 month
  rows copied from a spreadsheet (tabs), a CSV or a PDF (spaces), with or
  without the heading row of % points (a range heading such as 0–10 is read as
  its upper bound, and a note says so) and with or without month names in the
  first column (any order; without them the rows are Oct … Sep); a comma
  between digits in a tab- or semicolon-separated paste is a decimal comma.
  **Fill the EWR values** / **Fill the natural flows** put it in the grid, and
  a status line says what was read (or what is wrong: not 12 rows, a value
  that isn't a number, a heading that doesn't match the rows). Plausibility
  notes ("Check: the EWR rises with the % point in Jan …", an EWR above the
  natural flow) show under the table without blocking Save; a missing source,
  a bad point list or a blank cell, and two tables for one site, block Save
  and the save bar links here. **Remove the rule table at …** deletes one.
  From engine 0.33.0 ([model.md §2.9d](./model.md)): a *total* table has
  **Also enter the low flows (maintenance and drought)**, which adds a blank
  **Low flows (maintenance to drought)** grid (blank cells block Save; switching
  the table to *Low flows only* drops it) and a **Fill the low flows** button;
  **Load a CSV file** reads a file into the paste box, and two links download
  synthetic example layouts (a total-flow and a low-flow table, DRM style).
  Under each table, **High flows: freshets and floods**
  (`settings/EwrHighFlowsEditor.svelte`) lists the components (name, the
  months it may peak in typed as "Nov-Jan" or "Nov Dec Jan", the
  **daily-mean** peak m³/s (labelled so from engine 1.11.0: a gazette's peak
  is instantaneous and the hydrologist converts it; the hint says so and that
  the run warns when natural flow rarely reaches it), event
  days from rise to recession, events per year; engine ≥ 1.9.0, model.md §2.9d) with **Add a high flow** and Remove, a **Paste high
  flows** box with **Fill the high flows**, **Load a CSV file**, and a synthetic
  example CSV. The two status lines are named *Paste result* and *High-flow
  paste result*.
  From engine 1.3.0 (issue #64, [model.md §2.9c–§2.9d](./model.md)), once
  there is a table, two choices sit under the tables, both pending the
  hydrologist and both defaulting to what earlier runs did: **EWR charge
  follows** (`settings.ewrChargeSource`: *The pragmatic EWR*, the default, or
  *The rule tables*: at a site with a table the month's requirement sets the
  EWR charge, curtailment and the water account's EWR required vs met) and
  **Low flows judged on** (`settings.lowFlowMeasure`: *The month's total
  flow*, the default, or *The month's base flow*, from the Lyne–Hollick
  filter, so a flood month can't pass its low flows). Each has a help tip;
  scenarios can change both with `settings.set`.
- **Simulation period**: start and end, blank by default, which runs from the first to the last day with rain (engine ≥ 0.45.0; a run that leaves flow out warns, [model.md § 2.1](./model.md#21-pipeline)).
- **Data quality**: the gauge-vs-logger thresholds (lowest and highest ratio
  in %, shown to one decimal; minimum shared days; defaults 66.7 % (two
  thirds), 150 %, 90 days). Out-of-range
  values block Save with a message. They only change which water years are
  flagged, never the results.
- **Automatic runs** (WP-2.11, `settings.autoRun`): **Re-run the model after
  new data** (off by default); **Wait after the latest new data** (minutes,
  0–120, default 15; more data within the wait pushes the run back, never
  more than 2 hours after the first of it); **Publishing**: *Never: a person
  publishes* (the default) or *Publish if there are no new warnings*. The
  wait and publishing are disabled while it is off; a wait outside 0–120
  whole minutes blocks Save. Saving only this group doesn't mark the runs as
  out of date (it changes no input).
- **Outcome matrix** (`#set-outcomes`, issue #53 R4, `settings.outcomes`;
  `outcomes/OutcomeSettingsSection.svelte`, part of the form): how the Runs tab's
  [outcome matrix](#outcome-matrix) reads a demand sweep. **Water-year
  classes**: *Automatic* (terciles, quintiles once the record has 25
  complete years; the default), *Terciles* or *Quintiles*. **Risk
  cut-offs**, one group per measure, each with **Use the default
  cut-offs** ticked by default and a **Defaults pending the hydrologist**
  badge while it is: *Reserve months met* (lower risk from 90 %,
  increasing risk from 75 % of months met) and *Days below the pragmatic
  EWR* (lower risk up to 5 %, increasing risk up to 20 % of days). Unticked,
  the two cut-offs are editable in %, starting from the defaults; cut-offs
  out of order or outside 0–100 % block Save (the engine's
  `validateOutcomeCutoffs`, as the API checks them). The cut-offs'
  defaults are placeholders until the hydrologist confirms them (O1; the
  client agreed, issue #90); the class method's default is confirmed (O2,
  plan.md § Decision-support outputs). Viewers see the group read-only. Like
  automatic runs it changes no input: saving only this group doesn't mark
  the runs as out of date.
- **Seasonal outlook** (`#set-outlook`, issue #53 R5, `settings.outlook`;
  `outlook/OutlookSettingsSection.svelte`, part of the form, like the
  outcome matrix's): how the Runs tab's
  [seasonal outlook](#seasonal-outlook) is set up. **Season**, with **Use
  the default season (1 Oct – 30 Apr)** ticked by default (O3); unticked,
  the decision date and the season end as a month and a day each
  (29 February and a one-day season block Save). **Planning share**, with
  **Use the default planning share (80 %)** (O6); unticked, a % of
  analogue years in (0, 100]. The defaults are the engine's
  (`DEFAULT_OUTLOOK_SEASON`, `DEFAULT_PLANNING_SHARE`), confirmed by the
  client (issue #90), so no badge marks them pending. Viewers see it read-only; saving only this
  group doesn't mark the runs as out of date.

### Data feeds

Below the settings form (it saves on its own, never through the save bar) is
**Data feeds** (`#set-feeds`; `lib/components/feeds/DataFeedsPanel.svelte`,
part of the Settings tab's chunk; WP-2.10,
[architecture.md § Data feeds](./architecture.md#data-feeds)).

- **The list**, one card per feed: a state chip in words (**OK**, **Stale**,
  **Failing**, **Waiting**, **Off**; colour is never the only signal, and the
  card carries `data-state`), the source, the series it writes ("→ Rainfall —
  forecast"), where it reads ("cell -20.12, 25.17" or "station X0H000"), the
  what a CHIRPS feed writes ("· CHIRPS sat v3.0"), the schedule and who it
  runs as, the health sentence ("The last fetch
  failed: the source is unreachable: HTTP 503. Newest data 1 Sep 2026.",
  written by the panel from the server's reason code and days, `healthMessage`
  in `feeds.ts`, its days like the rest of the app's calendar days), and
  "Last data 21 Sep 2026 · checked 2026-09-24 06:00" (the data day is a
  calendar day, never shifted by the time zone). CHIRPS says how many of the
  days are preliminary.
- **A version conflict** (issue #40 part c): when the feed's series holds
  another CHIRPS product or version, or an unrecorded one, the card says
  every fetch is refused and why ("The series holds CHIRPS v2.0 and this feed
  writes CHIRPS sat v3.0 …"), and owners get **Replace the series** (after a
  confirm naming the full backfill, the History tab keeping the old values,
  and the refit). Once confirmed the card says the feed backfills the new
  record and then replaces the series whole, with **Withdraw the
  replacement** (discards what was backfilled). While it backfills, the
  health sentence says how far it has got ("Replacing the series: the new
  record runs 1 Jan 2001 to 30 Apr 2001 so far …"), or that it stalled; the
  Data tab marks the series **Being replaced** and both the Data and Runs
  tabs note that runs use the current series until it completes.
- **A warning** above the list counts the feeds that are stale or failing
  ("1 feed needs attention: …", `role="alert"`).
- **Run now** (editors) queues a fetch at once and says so; the status
  updates once the background worker has run it (**Refresh status**).
  **Switch off / on** and **Remove** (with a confirm; the series keeps its
  days) are for owners.
- **Attach a feed** (owners): source, **Into series** (the kinds that source
  may write; CHIRPS into the catchment rain series gets a hint under the
  select, tied to it by `aria-describedby`, that CHIRPS then is the catchment
  rain, used raw, `feeds.ts` `targetHint`, issue #51), an optional series name, the schedule, and either **Grid cells**
  (one "latitude, longitude[, weight]" per line, up to 25; the rainfall is
  their weighted mean) or a **DWS station** code (checked as `A2H012`; only river gauges, H codes).
  CHIRPS also has **Daily product** (*sat: from 1998, with preliminary
  days*, the default, or *rnl: from 1981, final days only*: one product end
  to end, never one spliced onto the other) and an optional **Start date**,
  checked against the product's first day (a sat date before 1998 says to
  choose rnl). The
  form explains a bad cell or code before anything is sent, and a second feed
  for the same series is refused.
- **Attaching to a series that has data.** A feed keeps the values already
  in its series, uploaded or imported ones included, and fills only the days
  without one ([architecture.md § Data feeds](./architecture.md#data-feeds),
  #30), so the series would mix two records. So when the chosen series already
  holds data (read from the project's series list), **Attach feed** first
  asks, inline (`role="alertdialog"`, named and described by its text):
  "“Rainfall — catchment” already has data (1,200 days)", that the values
  already there stay and the records would mix, and a suggested separate
  series name no series or feed of that kind uses ("CHIRPS", "CHIRPS 2",
  "DWS A2H012"). Focus lands on **Use a separate series: CHIRPS**, which
  fills the name and focuses the name field; **Fill its empty days**
  attaches into the existing series; Escape backs out to the name field.
  Changing the series drops the question. Once it runs, the card says how
  many days the last fetch left alone ("· 12 days kept your own values",
  `keptNote` from `last_meta.kept`). When the series holds another CHIRPS
  product or version (or an unrecorded one), filling it would splice two
  records, so the question says so instead ("It holds CHIRPS v2.0, and this
  feed writes CHIRPS sat v3.0 … never splices one onto the other"), and the
  second button is **Replace the series with CHIRPS sat v3.0**: the feed is
  attached with the replacement confirmed (`replaceSeries`), backfills the
  new record from the series' first day in a stage, and swaps it in whole
  when caught up.
- **Keyboard and screen readers**: opening the form focuses **Source**, and
  closing it (Cancel or a successful attach) returns focus to **Attach a
  feed**; a bad cell or code marks its field `aria-invalid`, describes it by
  the message and focuses it; busy buttons are `aria-disabled` so they keep
  focus; after **Remove**, focus goes to the section heading. Messages land
  in a live region that is always in the page. A failed action re-reads the
  list (it was usually changed elsewhere), and a failed refresh keeps the
  list shown.
- When the server reads the synthetic fixtures (`FEED_SOURCE=fixtures`, the
  default in dev and CI), a **Sample data** badge says so, and the cells hint
  names the sample grid's extent.
- Viewers see the list and the health, with no buttons. Tested by
  `e2e/tests/data-feeds.spec.ts` (including axe on the panel with a failing
  feed and the form open).

### API keys

Below Data feeds, for **owners only**, **API keys** (`#set-api-keys`;
`lib/components/apiKeys/ApiKeysPanel.svelte`, part of the Settings tab's
chunk; WP-2.9, [api.md § Ingest](./api.md#ingest)) makes keys a logger gateway
or a script uses to push daily readings into the project's series.

- **Make an API key**: a name, how long it works (until revoked, 90 days, 1
  or 2 years) and what it may write: any series of the project, or only the
  ticked ones (the project's current series).
- **The new key** is shown once, in a highlighted box with **Copy** and the
  warning that it won't be shown again, above a copyable `curl` example that
  pushes one day with a `$WM_INGEST_KEY` placeholder (never the key itself).
- **The list**: each key's name, its `wm_<prefix>_…` (never the secret), its
  state (**Live**, **Expired**, **Revoked**), what it writes, who made it
  and when, when it ends (or "Revoked … by …"), and when it was last used.
  **Revoke** asks first; the key is refused from its next request, and the
  row stays.
- Editors and viewers don't see the panel (the API answers them `403`).
  What a key writes shows in History by `API key “<name>”`.
- Tested by `e2e/tests/api-keys.spec.ts` (make a key, push the fixture with
  `scripts/ingest/push-fixture.mjs`, the series on the Data tab and the key
  in History, a revoked key refused, axe on the panel, no panel for an
  editor) and `apiKeys/apiKeys.test.ts`.

### Scheduled reports

Below Data feeds (and API keys, for an owner), **Scheduled reports** (`#set-report-schedules`;
`lib/components/report/ReportSchedulesPanel.svelte`, part of the Settings
tab's chunk; WP-2.15 Phase B, [§ Report](#report)) emails a PDF of the latest
run's report to chosen members every week or month.

- **The list**, one card per schedule: "Every Monday at 07:00
  (Africa/Johannesburg)" or "On the 1st of every month at 06:00 (UTC)", who it
  goes to and who it sends as, and "Next: …" with, when the last due time sent
  nothing, why ("the project had no runs to report on"); a paused one says
  **Paused.**
- **Add a schedule** (editors and owners): every week (on a weekday) or month
  (on day 1–28), the hour, the time zone (an IANA name, the browser's own by
  default), and **Send to**: checkboxes of the project's members who can read
  the report (farmers are not offered; you are ticked if you are one).
  **Pause / Resume** and **Remove** (with a confirm) on each card.
- Viewers see the list, with no buttons.
- Tested by `e2e/tests/server-report.spec.ts`.

## River & reserve

`?tab=river` (alias `?tab=reserve`), under *Outcomes* after the Summary
(issue #17, option A: the outcome pages). One run's river against its EWR:
the Runs & results tab's former **River & Reserve** group, moved here with
its panels unchanged, laid out as a dashboard (`river/RiverTab.svelte`, its
own lazy chunk, which carries the panels every run shows: the uncertainty
bands, the outcome matrix, the seasonal outlook and the water account, used
by no other tab; the flow chart, the water-year bars and Reserve compliance
stay lazy. Rules in `river/river.ts`, links in `river/links.ts`). Every
role that reads runs sees it (`TAB_GROUP.river = 'core'`: owners, editors,
viewers); an applicant and a farmer get their own views, as for every tab.

- **Which run.** `run=<id>` picks it; without one (or when it names a run
  that is gone) the newest run by `createdAt`, as the Summary shows
  (`pickRiverRun`). The run before it (by `createdAt`) is what the changes are
  against. The **Run** menu in the header (named for screen readers only,
  `aria-label="Run"`, like Hydrological units's picker, so on a phone the select fills a row of its own with
  no "Run" line above it) lists every run, newest first
  (`runOptionLabel`, the compare picker's labels); picking one is a new
  history entry (`?tab=river&run=<id>`), so Back returns to the run before and
  a reload keeps it. **Open in Runs & results** goes to `?tab=runs&run=<id>`.
- **Header.** The shared section header (`workspace/SectionHeader`, title
  from `TAB_LABELS`); the tab fills its context line (`fillHeader`): the run's
  label (with the *Workbook comparison* and *Evidence* badges), its period,
  its engine, and the EWR it was tested against (`ewrRuleText`: "EWR:
  pragmatic, by month", plus "Reserve rules at …" with the sites of the
  project's rule tables), and its actions: the **Run** menu and **Open in
  Runs & results**, before the page's Add data. With no run the context says
  what the page is for.
- **Tiles** (`riverKpis`), each with its change from the previous run where
  both runs have the figure (`Delta`, as on the Summary):
  *Reserve met* (share of days the outflow met the pragmatic EWR at the
  outflow gauge, "N of M days", and with a rule table "Reserve rules: x% of
  months"; flagged above 5 % of days not met); *Days below the reserve* (the
  count, and how many in an average year; the change compares the per-year
  figure, since runs can differ in length); *Mean simulated outflow* (m³/s and
  % of natural, moved here from the line under the Summary's cards, same
  figure as `overview/latestRun.ts`); *Worst month* (the month of the water
  year with the largest share of days below the EWR over the run, from the
  EWR grid's "All years" row, `ewr/heatmap.ts` `monthProfile`; "None" when the
  EWR was met every day; its change is that same month in the previous run).
- **First screen.** The Summary's **Flow vs reserve** chart
  (`overview/FlowVsReserve.svelte`, `#res-ewr`: EWR vs simulated outflow, log
  axis, the **30 days / 1 year / All** switch, the days below the reserve
  shaded and counted in its caption, a forecast run's band). It keeps the two
  controls the Runs tab's EWR chart had, which the Summary's copy leaves off
  (`FlowVsReserve` `units` and `pannable`): the **m³/s ↔ m³/day** switch
  (the shading is days, so it is the same in both units) and **◀ Earlier /
  Later ▶**, which step by the window picked (a year, or 30 days) with that
  window's button still pressed, stop at either end of the run (disabled
  there), and step aside under *All*; Shift+drag moves the view too. It sits beside **Days
  below the reserve, each water year** (`#res-reserve-years`, Compare runs'
  `ReserveYearsChart` with this one run: the engine's
  `reserveDaysByWaterYear` over the run's `ewr_shortfall`, part years faded,
  a table behind *Show as a table*). From 1100 × 620 the tiles and this row
  are exactly the height left below their top (measured with a
  ResizeObserver, less the save bar), the chart filling what the tiles
  leave, as the Summary's first screen does; narrower, the two stack.
- **Below it**, full width, the moved panels, with their ids:
  **Reserve compliance by month** (`#res-reserve`, with a rule table),
  **EWR compliance by month** (`#res-ewr-grid`, `EwrHeatmap`), the
  **Uncertainty bands** (`#res-uncertainty`, with the **Sensitivity runs**
  under them in the same panel, [§ Sensitivity runs](#sensitivity-runs)), the **Outcome matrix**
  (`#res-outcomes`, [§ Outcome matrix](#outcome-matrix)), the **Seasonal
  outlook** (`#res-outlook`, [§ Seasonal outlook](#seasonal-outlook)) and the
  **Water account** (`#res-water-account`). Each is described under
  [§ Runs & results](#runs--results), where it used to be.
- **On this page.** A **River sections** menu ([§ On this page
  menu](#on-this-page-menu)) sits under the header, above the tiles (the first
  screen fits the window below it; one row from 1280 px), and sticks down the
  panels: **Flow vs reserve**, **Days below, by year**, **Reserve
  compliance** (with a rule table), **EWR by month**, **Uncertainty**,
  **Outcome matrix**, **Seasonal outlook** and **Water account**, by the ids
  above (`river/river.ts`, `riverNavGroups`), in three groups named for
  screen readers (The reserve; How sure, and what if; Water balance).
- **Links in.** A `#res-…` fragment scrolls to its panel once the run is in
  and holds it there (`holdAnchor`), with focus on the panel's heading, waiting
  for a lazy panel's heading to arrive. An old link to one of these panels on
  Runs & results (`?tab=runs&run=<id>#res-reserve` …, `RIVER_ANCHORS`) is
  replaced by the same link here. The Summary's flow chart and outflow line
  and the run headline's "by month of the year" link here too.
- **No run yet:** the header, a "No run yet" panel saying what the page will
  show, and (editors) **Run the model** (`?tab=runs`); a viewer reads that an
  editor can run it.

## Hydrological units

`?tab=supply` (aliases `?tab=units`, `?tab=farms`), under *Outcomes* after
River & reserve (issue #17, option A: the outcome pages; the issue's
*Farms & supply*, named for the workspace's word for a farm node since
#54 2a, as its Summary card *Supply by hydrological unit* and the Runs group *Units &
users*). How much of each unit's irrigation demand one run supplied: the
Runs & results tab's former **Units & users** group and its unit results
table, moved here unchanged, beside a card per unit and the picked unit's
chart (`supply/SupplyTab.svelte`, its own lazy chunk, which carries the
moved panels: the curtailment panel with its reporting window and
share-the-pain board, and assurance of supply, used by no other tab. Rules
in `supply/supply.ts`, links in `supply/links.ts`). Every role that reads
runs sees it (`TAB_GROUP.supply = 'core'`); farm names show as on Runs &
results, to the same members, so nothing is shown to anyone who couldn't
read it before.

- **Which run.** `run=<id>` picks it; without one the newest run by
  `createdAt`, as the Summary shows (`pickRuns`). A `run=` naming a run that
  is gone shows the newest with a note. The run before it (by `createdAt`,
  `previousRunOf`) is what the change is against. The header's **Run shown**
  menu lists every run; picking one is a history entry. **Open in Runs**
  goes to `?tab=runs&run=<id>`.
- **Header.** The shared section header; the context line (`supplySummary`)
  is "8 units · 3 short this week · run “Baseline”, ran today", with the
  unit count alone before a run.
- **Tiles.** *Irrigation supplied* (% of demand over the whole record, the
  Summary card's figure and its change from the previous run, from
  `overview/latestRun.ts` `headlines`); *Hydrological units below 95 %* (N of M, every unit
  under `SUPPLY_TARGET`, the Summary's count); *Short this week* (units with a
  deficit above float noise on any of the 7 days to the run's last day of
  recorded rain (on a forecast run, the 7 days before the forecast, issue
  #51), the reporting window's *Last 7 days* and the publication's own rule,
  so the portfolio's count and this page agree,
  `backend/src/publish/recent.ts`; with the number the curtailment table asks
  to cut; the tile links to the curtailment over those days); *Total
  shortfall* (Mm³/a and mean m³/day of demand not supplied). The week needs
  each unit's `deficit` series: fetched four at a time through the Runs
  cache; "…" until they are in, with a Try again if one fails.
- **Hydrological unit cards**, worst supplied first (`unitCards`; units without demand
  last): the name (today's, or the run's for a unit removed since), % supplied
  with a bar, in the Summary's and the Network's supply bands
  (`network/supplyColour.ts`: accent at or above 95 %, amber from 70 %, red
  below, grey without demand) with the band in words beside the %; then
  (`cardFacts`) the mean shortfall (m³/day and Mm³/a), the demand days short
  in the reporting window (assurance of supply, engine ≥ 0.32.0), the days
  short in the last 7 when there were any, and the cut the curtailment table
  asks for; links to its node on the Network (`?tab=network&node=`) and its
  planted areas (the farm drawer, `farm=`). The whole card picks the unit:
  `unit=<nodeId>`, a history entry, so Back returns and the link can be
  shared; a `unit=` the run doesn't have picks the worst unit.
- **Hydrological unit detail** (`supply/UnitDetail.svelte`, `#res-farm`): the unit detail
  panel of Runs & results, moved. Its demand, supply, share and dam size in a
  line, then one chart at a time: **Supply vs demand** (the days the unit was
  short shaded, from its `deficit` series) or, for a unit with a dam, **Dam
  storage** (% of the capacity the run had, `runDamCapacity`); the **30 days
  / 1 year / All** switch (opening on a year), Earlier / Later, and a forecast
  run's band.
- **Layout.** From 56rem of page width the cards are a column beside the
  chart; with a window at least 620px tall that block is exactly the height
  left below it (measured, less the save bar), the cards scrolling inside
  their column and the chart filling its panel, as on Dams. Narrower, one
  column; picking a card scrolls the chart into view.
- **Below it**, under *Tables for this run*, the moved panels with their
  ids: **Hydrological unit results** (`#res-farms`, `supply/UnitResultsTable.svelte`, the
  table that was in the run summary; the printable report still shows it
  there), **Curtailment** (`#res-curtailment`, with the
  [reporting window](#report-window), `window=`) and **Assurance of supply**
  (`#res-assurance`). Each is described under [§ Runs & results](#runs--results).
- **On this page.** A **Hydrological units sections** menu ([§ On this page
  menu](#on-this-page-menu)) sits under the header, above the tiles (one
  row; the cards and the chart fit the window below it), and sticks down the
  tables: **Hydrological unit detail** (`#res-farm`), **Hydrological unit results**, **Curtailment**
  and **Assurance of supply** (`supply/supply.ts`, `SUPPLY_NAV`). Until it,
  the three tables ran four screens under the cards with no way to them but
  scrolling. Not shown with no run or no units.
- **Links in.** A `#res-farm`, `#res-farms`, `#res-curtailment` or
  `#res-assurance` fragment scrolls to its panel once the run is in and holds
  it there (`holdAnchor`), focus on its heading. An old link to one of them on
  Runs & results (`SUPPLY_ANCHORS`) is replaced by the same link here, with
  its `run=` and `window=`. The portfolio's and team page's "units short this
  week", the Summary's *Supply by hydrological unit* and its short-units card, and the
  run header's *Hydrological units* link on Runs & results lead here.
- **Empty states:** no run yet (editors get **Run the model (Runs &
  results)**; a viewer reads that an editor can run it); no units in the model
  (a link to the Network); a run with no units (added since: run again).

## Runs & results

- **The page** (issue #17): a reading page with the runs list beside the
  shown run. The section header's line counts the runs and says when the
  newest ran ("20 runs · newest ran today", "No runs yet"), and for an
  editor the **run form** sits where the other pages have Run model, last in
  the header: a **Run label** field, **Run forecast** (with a forecast
  series) and **Run model**. Its status (what a run still needs, flow shares
  over 100 %, unsaved model changes, inputs changed since the latest run,
  the progress while a run goes, else "Runs use the saved network…") is one
  slim line under the header (`#run-note`, the buttons' accessible
  description), with the progress bar under it. A viewer gets no form, and
  the inputs-changed note as before.
- **The rail.** Where the page is at least 50rem (700 px) wide (a container
  query, `runs-page`), a 250 px left rail holds the runs list beside the
  results. It is sticky and never taller than the window from where it
  starts (under the header at the top of the page, at its sticky offset
  once scrolled, less the save bar): a long list scrolls inside its panel
  (at least 7.5rem tall), so nothing in the rail is clipped. Narrower, the
  rail stacks above the results and the list scrolls inside its panel past
  20rem (about five rows), so the shown run starts near the top.
- **Outcomes for this run.** The run header has one line, "For this run:
  River & reserve → · Hydrological units →" (a navigation landmark, *Outcomes
  for this run*; the links are named "River & reserve for this run" and
  "Hydrological units for this run"), to the [River & reserve](#river--reserve)
  and [Hydrological units](#hydrological-units) pages for the shown run. It replaced
  the two link rows (`#res-river`, `#res-units`) and their groups, which a
  link still reaching Runs & results with those anchors is sent to (the page
  itself, same run, and the reporting window for Hydrological units; the entry
  is replaced, so Back skips it; `movedHref` in `runs/sections.ts`).
- **Forecast runs** (roadmap WP-2.12, [model.md §2.4f](./model.md#24f-forecast-mode-engine--0370-roadmap-wp-212)).
  When the project has a forecast series (`rain_forecast_mm`, uploaded or
  fed by CHIRPS-GEFS), the run form has **Run forecast** beside Run model: the
  record as an ordinary run, then the days after the last recorded rain on
  forecast rain, shown apart. The project keeps one forecast run (a new one
  replaces the last unless it is pinned, published or cited). **Run model**
  itself now stops at the last recorded rain, so an ordinary run never
  contains forecast days. A forecast run carries a **Forecast** tag in the
  list and a "Forecast from …" badge in its header linking to its own panel
  (`forecast/ForecastPanel.svelte`, its own chunk, `#res-forecast`, the menu
  entry **Forecast** right after Summary): which days, from how much forecast
  rain after which recorded day; per farm the lowest dam level expected, the
  days short expected and the share of demand supplied, farms short on a
  forecast day first; and the outlet's EWR days at risk, counts only. No
  misleading certainty (the persona rules): every figure is "expected" or
  "about", in whole percent (`forecast/forecast.ts`, which a test holds to
  never saying "will"), under a "Modelled on forecast rain, not measured"
  tag, with a line saying every other figure of the run covers the days
  before the forecast only, and every "X of N days" beside them counts N
  over those days too (`overview/latestRun.ts` `historyDays`, issue #51: the
  EWR card, River & reserve's tiles, the unit results table's record). Every daily chart of a forecast run (EWR vs
  outflow, the hydrograph, dam storage, supply vs demand, the explorer)
  shades the forecast days with a hatched band and a dashed edge, labelled
  "Forecast" on the plot and in a text key under it (`LineChart`'s `band`
  option), so the band never rests on colour alone; the figure carries
  `data-band-from`. The flow-duration curve has no time axis, so no band: it and its Q table rank
  only the days before the forecast, and the caption says how many forecast
  days it left out (issue #51).
  The daily CSVs lead with an `F` column and the `.xlsx` sheets with a 1/0
  flag ([api.md § Export](./api.md#export)).
- **On this page.** Above the results, the same menu as Settings &
  calibration (`common/SectionNav.svelte`; the "Result sections"
  navigation) links to each panel (`#res-summary` … `#res-explore`, listed by
  `runs/sections.ts` in groups: Summary, Model quality, Record, Dig deeper). Each group's name leads its pills, and each
  group is a list labelled by that name. It sticks at the top (under the
  phone bar on a phone) down the long results page, marks the section being read, takes at most two
  rows on a laptop (three at 1280 px until its groups could break across rows; [§ On this page
  menu](#on-this-page-menu)), and on phones is one sideways strip.
  Runoff model only for a GR4J run, WR2012 check only with a reference, and
  Plausibility checks only on a run made by engine 0.25.0 or later. The
  page's `scroll-padding-top` includes the menu's height, so a jumped-to
  section, or a focused control, clears both the phone bar and the menu.
- **Page order.** The results are grouped by the question they answer
  (`resultGroups` in `runs/sections.ts`; the page repeats each group's name
  as a quiet heading, `RunCharts.svelte`), so the panels that are read
  together sit together:
  1. **Summary**. The run header carries the evidence line and a one-line
     preview of the run's notes (`notesPreview`), each a link to the Record
     group. The summary opens with the run's warnings in two parts
     (`runs/credibility.ts` `warningGroups`): **things to check before relying
     on this run** (a warning box; any warning not known to be a data note
     lands here, so a new engine warning is never hidden), then, collapsed,
     **notes on how the input data were handled** (CHIRPS bias correction,
     rain treated as missing, accumulations spread, zero-rain runs, flat
     stretches). Then one line of **model checks** (`credibility`): the
     self-checks, the plausibility findings, the WR2012 flag and the calibration
     fit (called in-sample only when it is, below), each in words with a coloured edge and a link to its panel.
  2. **Model quality**: the hydrograph with the flow-duration curve under it
     (compared together on every calibration iteration), calibration (with
     where the parameters came from), runoff model, WR2012 check, EWR vs
     observed, plausibility checks.
  3. **Record**: notes & evidence (with the run's inputs), the validation
     statement, publication: sign-off, after the results. The **validation
     statement** (`#res-validation`, menu entry **Validation**;
     `liability/ValidationPanel.svelte`) is the report's own
     `ValidationStatement.svelte` (§ Report), folded shut in a `<details>`:
     closed it shows its heading and "Engine x.y.z: its checks, …"; opened, the
     statement loads as its own chunk, its headings (Calibration, Data
     quality, Known limitations) one level under the panel's. Nothing is
     computed twice: both call the engine's `validationStatement`.
  4. **Dig deeper**: self-checks (with Trace a day), Explore outputs.

  Everything after the flow-duration curve (the rest of Model quality,
  Record, Dig deeper) renders once the hydrograph has drawn and been painted,
  so the first chart isn't held behind a second of rendering on a busy
  machine (`runs/RunCharts.svelte`); a link to a panel down there
  (`#res-notes`, `#res-calibration`) renders them at once. The menu names the same groups. The river's panels (Reserve compliance,
  EWR vs outflow, EWR by month, the uncertainty bands, the outcome matrix,
  the seasonal outlook, the water account) are on River & reserve and the
  units' (curtailment, assurance of supply, unit detail, the per-unit table)
  on Hydrological units (issue #17); a link to one of them here (`#res-reserve`,
  `#res-curtailment`, …) is sent to its panel there. They are still
  described below. The bullets below describe each panel; the order above
  is the page's.
- **Run model** (in the section header, above) takes an optional **Run label** (e.g. "Baseline"). The
  button is disabled, with links, until the project has a network and a
  rainfall series, and while the farms' flow shares add up to more than 100 %
  (the engine refuses those runs, [model.md §2.5](./model.md); the note gives
  the total and links to Network and Settings). While a run is going it shows progress. A note says when
  inputs changed since the latest run.
- **The runs list** (newest first, the newest marked "latest") selects the
  run shown; editors delete one with its ✕ (a run already gone, deleted
  elsewhere or trimmed, just leaves the list; a run that can't be opened
  because it's gone says so in words, `runs/runList.ts` `runErrorText`, never
  the API's "not found"). A list read that a change (a run made, deleted,
  pinned) overtakes is read again, so a deleted run never comes back
  (issue #77). Rows are compact so several fit
  the narrow rail: the label (two lines at most; the full label is the row's
  tooltip and the results heading), when it ran and the years it covers
  ("2026-09-23 15:06 · 1979–2024", `runs/runList.ts`), then small tags
  (latest, Auto for an automatic run made after new data, Published, Evidence / Former evidence, Pinned, Scenario / Scenario
  base, **Inputs not stored** for a run from before stored inputs, which
  can't be re-run from them, Workbook comparison). Pin and
  ✕ stack in a narrow column beside it. The full period, days, author and
  engine version are in the results header. From 7 runs up
  (`RUN_FILTER_FROM`) a **Filter runs** box above the list keeps the runs
  whose label contains every word typed (any case), with "N of M runs". Its header links to **Compare
  runs** (the Compare runs tab, `?tab=compare`, [run-comparison.md](./run-comparison.md)).
  Viewing an older run, the header offers "go to latest".
  **Which run opens** when the URL names none (`defaultRunId` in
  `runs/runList.ts`): for an editor or owner the newest run, the one they are
  working on; for a viewer the published baseline when there is one (the run
  stakeholders are meant to read), else the newest. An explicit `?run=`
  always wins. Viewing any run other than the published one, the results
  header offers **Compare with published** (the Compare runs tab,
  `?tab=compare&a=<published>&b=<this run>`, [run-comparison.md](./run-comparison.md)).
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Pinned runs** (015_run_pinned). Each row has a pin toggle for editors
  (`aria-pressed`, labelled "Pin run <label>"): a pinned run is badged
  **Pinned**, is never pushed out by newer runs, and loses its ✕ until it is
  unpinned. A project holds at most 10 pinned runs; pinning an 11th shows the
  server's `409` reason in the tab's error. Viewers see the badge but no
  toggle. The compare page's run pickers add "· pinned" to a pinned run's
  option (read only), and "· published" to the published one.
- **Publishing a run** (WP-2.3, 022_publication; `runs/PublicationPanel.svelte`,
  in the Runs chunk, helpers in `runs/publication.ts`; `#res-publication`,
  menu entry **Publication**). Says whether the shown run is the project's
  published baseline ("This run is the published baseline … Published … by
  …"), another run is, or nothing is published yet, and shows the current
  notice: the level with its percentage ("Advisory · 10 %"), its text in
  each language written (table order, `noticeLanguages`), the next update
  date and who last changed it. Editors get
  **Publish this run** on any other run: a confirm dialog says what changes
  for stakeholders (each farmer sees this run's figures for their own farm
  from 1 October, and the notice; it replaces the current baseline, which
  stays in the history), warns when farm dams have no stop level ("N farm
  dams have no stop level (0 %)…", from the run's model snapshot, design
  §3 Q3), and holds the notice fields (level, cut %, next update date,
  one "Notice in …" text field per language of the language table, English
  first, each with its `lang` so the browser spell-checks it in that
  language: `noticeTextFields`; issue #58) and an optional note for the staff
  ("farmers don't see it"). **Publish** answers "Published. N farm views
  updated." **Edit notice** changes the current notice in place (`PATCH`,
  no re-publishing): "Notice saved." A legacy-model run (a stored run from
  before engine 1.0.0) says why it can't be published: that model was
  removed and the run is a workbook comparison only. In the runs list the current published run carries a
  **Published** tag, and no run a publication holds has a delete button (the
  server refuses with `409`); the run header repeats the badge as a link to
  the section. Viewers see the status and the notice, no actions. The farm
  page farmers read it on is WP-2.6's (`routes/farm/`).
- **Summary** (the "Run summary" region): it opens with one to three plain
  sentences (`runs/runSentence.ts`, built only from the stored summary so they
  always agree with the cards): the river measure the cards lead with (Reserve
  rules met in X % of months at the headline site when there is a rule table,
  else the % of days below the pragmatic EWR at the outflow gauge), then the
  farms (how many got less than 95 % of their demand and the lowest one, or
  "Every hydrological unit got at least 95 %"; left out when the run has no farms), then,
  only when the run was scored against observed flow, the NSE and PBIAS with
  PBIAS in `rating.ts`'s plain words (NSE unrated), "in-sample" only when the
  parameters were fitted on those days, else with the reason in brackets. Then the headline cards give mean natural
  flow and simulated outflow in m³/s and Mm³/a, EWR days not met (when the
  project has a Reserve rule table, a **Reserve rules met** card comes first:
  the share of months met at the outlet, else the first site, with "X of Y
  months", the longest run not met and a link to the panel; the days card is
  then labelled "Days below the pragmatic EWR", the secondary measure), irrigation
  supplied, and NSE and PBIAS (no rating words: model.md §2.10; PBIAS read
  in plain words by `runs/rating.ts`), labelled by whether they are in-sample
  (issue #45, `calibration/sample.ts`, from the run's
  `summary.calibration.fitStatus`, engine ≥ 0.39.0): **calibration period
  (in-sample)** only when the run's parameters came from Fit automatically for
  its runoff model, unedited, on the same calibration window, exclusions and
  flow record; otherwise **calibration period (parameters not fitted)** (set
  by hand, imported or defaults), **(parameters edited since the fit)** or
  **(not the period fitted)**; a run from before engine 0.39.0 says only
  "calibration period". The calibration panel's note, the checks line, the
  plain-words sentence, the Summary tab's card and the run comparison use the
  same words (compare: one label when both runs agree, else "run A …, run B
  …"). When the parameters came from Fit automatically, the fit's validation
  scores sit beside the fit's own score under **Where the parameters came
  from** (below). The per-unit table below them moved to
  [Hydrological units](#hydrological-units) (issue #17; the printable report keeps it
  under the run summary): sortable, in network
  order by default, with farms under 95 % supplied flagged in text (a "below 95 %"
  badge and a tinted row). The **Supplied % of demand** column has a small bar
  beside the number (`aria-hidden`, width = the fraction clamped to 0–100 %,
  green at or above 95 %, amber below; themed tokens, so it follows dark mode, and
  solid `CanvasText` under forced colours); the number stays the content.
  The farm table and the **Irrigation supplied** card are means over the
  **whole record**, and say so ("Daily averages over the whole record,
  <first day> to <last day> (N days); the curtailment targets cover the
  reporting window", "over the whole record"), so they can't be mistaken for
  the curtailment table's figures, which cover the reporting window.
- <a id="report-window"></a>**Reporting window** (issue #44;
  `runs/ReportWindowPanel.svelte`, pure helpers in `runs/reportWindow.ts` and
  `runs/windowedCurtailment.ts`). A picker at the top of the curtailment panel
  (`#res-curtailment`) chooses the days the curtailment, other water users and
  EWR sites tables average over: **Project window** (the window the run
  reported over, from the project setting, with its dates in the option; the
  default), **Last 7 / 14 / 30 days** (ending on the run's last day of
  recorded rain, `reportWindow.ts` `runDataUntil`, the publication's rule,
  with a note when the run goes on past it as dry days), **Whole
  record**, or **Custom range** (From / To date fields, starting from the days
  shown, cut to the run with a note; a backwards range or one outside the run
  says so and shows the project window). Any window other than the run's own is
  worked out **in the browser** from the run's stored daily series by the
  engine's `prepareCurtailment` / `curtailmentOverWindow` (the recompute the
  farmer projection's season uses, [model.md §2.11](./model.md#211-curtailment-targets-shortfalls)):
  per node its inflow from upstream and outflow; per farm demand, supplied,
  runoff, dam storage, EWR charge and its irrigation part (and the net
  transfer when a transfer rule joins it to another farm); per other user
  demand, supplied, return flow and EWR charge; per EWR site shortfall,
  charged and natural (`curtailmentSeriesKeys` lists them). They are fetched
  once per run the first time another window is picked, and the run is read
  once, so switching between windows is instant. Every column is recomputed,
  the **EWR site setting each farm's charge** included: a run from engine
  1.5.0 stores each day's binding site (`ewr_binding_site`, per farm upstream
  of two or more sites), so the panel fetches that instead of the flows and
  the column is exact. For an older run the engine recomputes each day's
  binding site from the stored flows (the inflow, outflow, runoff, dam storage
  and transfer series above, fetched only then, or each rule's own
  `transfer_rule@<rule id>` volume in place of the transfer series when the
  run stores them, engine ≥ 1.6.0); only when the transfer rules form a loop
  in a run without those is that column approximate, and the status line says so. Nothing is re-run and nothing is saved: the project
  setting, the stored run, the downloads and the printable report keep the
  project window, and the status line under the picker says so. A viewer can use
  it (it only reads the run). The choice is `?window=` in the URL (`last7`,
  `last14`, `last30`, `all`, or `YYYY-MM-DD..YYYY-MM-DD`; absent = the project
  window), a history entry of its own, so back / forward step through the
  windows looked at and a reload or a shared link keeps it; it stays as you move
  between runs. Every period is labelled: the curtailment table leads with the
  window's name and dates ("Last 7 days: daily averages over 2022-01-22 –
  2022-01-28 (7 days)", also in its caption), and the other water users and
  EWR sites tables repeat the dates. The status line adds how many of the days
  fall in the forecast period (`RunSummary.forecastRain`). On a forecast run
  *Last 7 / 14 / 30 days* end on the day before the forecast, and the note says
  so (issue #51): the latest days of the record, never forecast days read as
  "this week". *Whole record* and a custom range end there too, with a note
  ("Cut to the record before the forecast: …"; a range wholly in the forecast
  is refused): a historical figure never averages over forecast days. A run saved before
  engine 0.17.0 (no EWR charge series), or missing any series the recompute
  reads, disables the picker and asks for a new run. The engine's
  `views/curtailmentOverWindow.test.ts` checks the table, binding sites
  included, against `runModel` run with the same window as the project
  setting on seeded synthetic runs (and against the stored table over the
  run's own window); `windowedCurtailment.test.ts` checks the panel's wiring
  (the series it fetches, each preset); `e2e/tests/report-window.spec.ts`
  checks whole rows, the binding site included, against a second run in the
  app, the URL, back / forward, and axe in both themes and on a phone.
- <a id="self-checks"></a>**Self-checks** (`#res-checks`,
  `runs/SelfChecksPanel.svelte`, helpers in `runs/checks.ts`; engine ≥ 0.12.0,
  [model.md § Verification](./model.md#verification)). It has three
  parts. First, one line saying all checks passed, or how many failed (a failure
  is a model bug, so it asks to be reported). Then each check with ✓/✗ in text,
  in the workspace's words (the engine's "farm" reads "hydrological unit", `checkLabel`),
  the first problem (the node's name and date) under a failed one, which engine
  made the run and ran its checks, and the largest daily balance error of any
  unit (column V). Second, the **water balance by water year**: rain,
  runoff coefficient, start storage, unit runoff, transfers, rain on dams,
  consumptive use, dam evaporation (both engine ≥ 0.16.0, blank before),
  outflow and end storage in Mm³, and the residual in m³. A network's
  optional terms get a column only when the run has them (groundwater
  pumped, storage set by a storage reset, other users' use, stream depletion,
  seepage lost; `balanceColumns`), and the equation above the table names
  exactly the columns shown (`balanceEquation`), so the row adds up to its
  residual by eye, as in the summary CSV. A red residual
  if it isn't float noise; a GR4J run adds the runoff model's residual in mm.
  The last row is the whole run. Third, **Trace a day**: pick a farm (or gauge)
  and a date (it opens on the farm-day with the largest residual) and it
  fetches `GET …/runs/:runId/day` and lists every column in FarmTemplate order,
  with its letter, value and formula, starting from the day before's storage
  (and, engine ≥ 0.14.0, the day before's soil-water store, from which the
  day's effective rain used and the store can be redone), then works the day's balance out from the numbers shown: in (H + I + J +
  rain on dam) − used (G − T) − evaporated − stored (Q − Q[t−1]) − out (U). Parameters and names come from
  the run's input snapshot, not today's model. The picker's first option,
  **Catchment (rain to natural flow)**, traces the runoff model's day instead
  (`GET …/runs/:runId/day` without a `nodeId`): for GR4J, rain used P, PET E,
  AET, each store (production S, unit-hydrograph water in transit UH, routing
  R) the day before and at the end of the day, the groundwater exchange F
  (shown as 0 when X2 = 0 stored none), natural flow Q in m³/day and as mm
  over the catchment, each with its formula from `GR4J_COLUMNS`; then the
  store balance, stores before + P + F − AET − Q − stores after, with its
  residual in mm. On a run's first day each store's starting value is shown
  as – (only their total after the warm-up is recorded) and the balance uses
  the total. A legacy run lists its [Flow data] columns (`LEGACY_RUNOFF_COLUMNS`)
  and says it keeps no stores, so there is no store balance to close.
  A run saved before 0.12.0 says
  it has no checks, balance or working columns, and to run it again.
  Not yet: an Excel audit workbook, and
  model columns in the Data tab downloads ([followups.md § Verification](./followups.md#verification)).
- **Land cover** (engine ≥ 0.24.0, only with land cover): the mean natural
  flow invasive plants and forestry took, its share of natural flow, the
  low-flow threshold, and per class the condensed area, reduction and mm/yr
  over that area (`RunSummaryView.svelte`).
- **Groundwater** (engine ≥ 0.23.0, only when a farm or user has boreholes):
  a table of each one's mean pumping, its share of what was supplied, and the
  stream depletion it causes (`RunSummaryView.svelte`). From engine 0.36.0
  (WP-3.9, `HumanImpactTables.svelte`, `runs/groundwater.ts`), **Groundwater
  by water year**: the GN 538 context note (area × Table 2 rate, at most
  40 000 m³/a, in any 12 months; the ceiling only where a property's area or
  rate isn't entered; the GA's exclusions; modelled use only, the app never
  decides legality), the low-confidence note, then per farm or user the mean
  pumped per year (partial years weighted by their days), the most in one
  year, the annual caps, the **GN 538 volume** ("(ceiling only)" when
  unknown), the **most in any 12 months**, how many years were above the GN
  538 volume over the water year or any 12 months ending in it (flagged; engine
  ≥ 1.12.0, `aboveGa`) and how many reached a cap; and per node a collapsed
  table of every water year: days, pumped, into the dam, stream depletion, the
  most in the 12 months to then, and each borehole's volume (of its cap,
  marked when reached).
- **Other water users** (engine ≥ 0.22.0, only when the run has any): a table
  under the farms with each user's priority, demand, taken, deficit, % of
  demand supplied (flagged below 95 %), returned and EWR charge, whole-run
  means (`RunSummaryView.svelte`).
- **Farm table columns.** *Demand* is the farm's **abstraction demand**: its
  crop water requirement after effective rainfall ÷ irrigation efficiency (D =
  F / e, [model.md §2.3, §2.7](./model.md)), what it has to take to meet the
  requirement; supplied, deficit and % supplied are measured against it. The
  farm detail's supply chart calls the line "Abstraction demand". *EWR charge*
  is a positive volume charged (m³/day), the same sign the curtailment table
  and every export use (below).
- <a id="share-the-pain"></a>**Share the pain** (issue #53 R3,
  `curtailment/ShareThePainBoard.svelte`, view model
  `curtailment/shareThePain.ts`; [design/planning-outputs.md §3.3](./design/planning-outputs.md#33-r3-the-share-the-pain-board-s-presentation-only)).
  On the Runs tab the curtailment panel leads with a board under its
  *Curtailment targets* heading and period line, over the same reporting
  window (it follows the [picker](#report-window)); the per-farm table
  follows under a *Per hydrological unit* heading. The printable report leaves the board
  out (`CurtailmentTable`'s `board` prop). Three stages, side by side, each
  as a share of the group's own demand: **1. Today** (supplied ÷ demand),
  **2. Equitable share** (equitable share volume ÷ demand: the same % for
  every farm, marked * for the fixed `EQUITABLE_SHARE_FOOTNOTE`, plus a line
  that SA restrictions are set per user category), **3. EWR met** (volume
  left ÷ demand: the equitable share less the farm's EWR supply cut). A row
  of three cards gives the farm totals per stage; the table has one row per
  farm (a bar, the whole %, the m³/day), an **All hydrological units** total row, then
  **Other water users (outside the equitable share)**: each user its own
  row with a *senior, not curtailed* or *junior, curtailed* badge, *not in
  the share* at stage 2, and at stage 3 what it takes after its supply cut
  (junior) or all it takes (senior), with an **All other users** total.
  Every figure is the engine's `CurtailmentSummary`; nothing is recomputed.
  The % uses *Demand left %*'s rules (`fmtDemandLeft`): bounded to 0–100 %,
  "no demand" for a group with no demand (never a negative demand, which the
  client's sketch showed), "—" under 1 m³/day. A note under stage 3 names
  what the % leaves out: a farm's *store less / pass inflow* charge, an EWR
  cut beyond its equitable share, a senior user's charge that stands, or a
  junior user's charge beyond what it takes. The middle stage is a
  `ShareRule` (`{ kind: 'equal' }`): every category is cut by the same %,
  which the client confirmed (O4, issue #90,
  [plan.md](./plan.md#decision-support-outputs-2026-09-26)). Still open to
  the client: whether the town's uses count as domestic or irrigation.
  Tests: `shareThePain.test.ts` (bounding, zero demand, senior / junior, the
  equal share, and seeded engine runs whose totals match the engine's),
  `ShareThePainBoard.test.ts` (the markup, via Svelte's server renderer) and
  `e2e/tests/share-the-pain.spec.ts` (the rendered board against the tables
  under it, the window picker, axe in both themes and on a phone).
- **Curtailment targets** (`curtailment/CurtailmentTable.svelte`,
  view model `curtailment/curtailment.ts`; [model.md §2.11](./model.md)): per farm
  demand, supply, the *equitable share volume* and *above (−) / below (+)
  equitable share* under "Equitable share (fairness benchmark, ex EWR)", then
  the EWR columns. No label or badge says "gain" (audit Q11): a farm below its
  share reads "below its equitable share by X m³/day", and the table ends with
  the fixed footnote "Fairness benchmark only: … Not an allocation or licence
  condition." From engine 0.17.0 (audit Q17, [model.md §2.7b](./model.md)) the EWR
  column is the farm's **EWR charge**, followed by *Irrigate less*, *Store less /
  pass inflow*, the *Supply cut* (m³/day and l/s) and the *EWR site* setting
  the charge, with a note on the rule. **Sign convention** (issue #45): the
  charge, its irrigate-less and store-less parts, the other users' charge and
  charge left standing, and the EWR sites' shortfall, charged and natural
  parts are volumes, shown positive (`fmtCharged`), as the Farms table shows
  the charge, so one farm reads the same in both tables; the changes they ask
  for (above/below the equitable share, supply cut, total change) keep − =
  reduce. The engine's curtailment fields stay ≤ 0 (the workbook's column R
  sign, so S = N + R holds): only the display and the exports flip them; older runs show the single "EWR
  shortfall" column (AB). *Total change* and *volume left* count only the
  supply cut (Q13): a farm with no demand shows no cut, and a farm with only a
  storage charge gets a "store less / pass inflow X m³/day" badge; a farm
  whose EWR cut exceeds its equitable share gets a warning badge. *Demand left*
  is a whole % in 0–100: "no demand", "—" with a tooltip below 1 m³/day of
  demand, "<1%" / ">99%" at the ends. When the run has other water users, an
  **Other water users** table follows (engine ≥ 0.22.0, §2.7c): demand, taken,
  returned, EWR charge, the supply cut, and the charge left standing, with
  "junior (curtailed)" or "senior (not curtailed)"; they are not in the
  equitable share or its totals. Below it, the **EWR sites** table (outlet first, then
  gauges): farms upstream, days not met, and the mean shortfall, the part
  charged to farms and the natural part over the reporting window (all three
  tables follow the [reporting window picker](#report-window)); with the
  outlet as the only site it says *EWR assessed at 1 site (outlet). Add gauges
  at the Reserve determination's EWR sites to protect upstream reaches.* The hydrograph (observed flow as a line
  under simulated outflow, labelled by instrument, *Observed gauge* or
  *Observed logger* (from the stored series' label); when the project has
  both records (engine ≥ 0.39.0, issue #45) both are drawn: the calibration
  record solid in the observed colour and labelled "(calibration record)",
  the other dashed in `--series-4` (its own light and dark value) and not
  scored, with the caption saying which is which; the flow-duration curve's
  observed line and Q table row carry the same label. Each record is broken on every day without a reading and never
  bridged, a lone reading between gaps shown as a dot; natural flow starts
  hidden and its legend entry shows it, and a legend toggle survives the log
  scale and unit switches; a switched-off entry is struck through in the
  muted text colour, not faded, so it keeps AA contrast; m³/s or m³/day, log
  scale, last 3 years or the full period). **Periods excluded from
  calibration** (settings.calibrationExclusions, model.md §2.10) are tinted
  behind the lines (`--warning` at 16 %, `LineChart`'s `shade`, light and
  dark), and a key under the chart (`shadeKey`) names them in words, one line
  each with its reason ("WY 2015/16: suspect rain"), so the tint never rests
  on colour alone. They are the run's own exclusions, from its settings
  snapshot (else, for a detail cached before runs carried settings, the ones
  its calibration statistics applied), never the project's current ones, so
  an old run shows what it was fitted and scored with. Each is clipped to the
  hydrograph's days; one that runs past them says "(partly outside the run)",
  and one wholly outside isn't listed (`runs/exclusionShading.ts`). A plain
  drag draws a box to zoom
  into, as on every chart; **Shift+drag** moves the view back and forth
  through the record at the same width, and **◀ Earlier / Later ▶** move it
  by half a window (the non-drag route, and the only one on touch). Neither
  goes past the ends of the record, and the window survives the log scale
  and unit switches. The figure carries the visible range as
  `data-view-start` / `data-view-end`. Every daily chart has the same moves
  (`LineChart`'s `pannable` prop is on by default; Earlier / Later appear once
  there is somewhere to move to): EWR vs outflow, farm storage and supply vs
  demand, Explore outputs, the model stores, the Data tab's series chart and
  the run comparison's daily series overlay. The m³/s ↔ m³/day switch sits on every flow chart
  (hydrograph, flow-duration curve, EWR vs outflow, and Explore outputs while a
  flow series is picked), and one click sets all of them; the run comparison's
  overlay has its own while a flow series is picked. The calibration panel (it opens with the same
  calibration-period note, in-sample or why not, and adds the gauge vs logger table when years disagree;
  the volume bias is one tile, *Volume bias (PBIAS)*, in words, "57.6% too dry" or "12.3% too wet",
  and the annual water balance's *Simulated vs observed* column says the same, never a signed PBIAS beside
  a signed volume error of the opposite sign, issue #51; the CSV keeps both signed, each labelled;
  from engine 1.19.0 the same **WR2012 statistics** table as the fit results, for the run's scored
  days, above the annual water balance, CR-28),
  then **Where the parameters came from**: the fit record the
  run was made with, from the run's own settings snapshot (same layout as in
  Settings, with the in-sample score beside its validation scores, the
  "Parameters edited since fit" badge when they were edited, and a
  "Forcing changed since fit" badge when this run's pan coefficient, A-pan,
  PE input, CHIRPS bias correction or zero-rain runs differ from what the fit was made under, or its
  CHIRPS series held another product or version, or its daily A-pan series
  differs from the fit's, from the run's `inputSeries`, or its monthly CHIRPS
  factors drifted more than 2 % from the fit's, from its `summary.chirpsCorrection`,
  issue #51), or "No fit
  record" when the parameters were set by hand or imported. It also lists the
  calibration exclusions the run's statistics left out, which the calibration
  panel shows as "Excluded" with the observed days removed (or explains that
  every observed day was excluded). The calibration window shown is the run's,
  not today's. The **runoff model** panel for GR4J runs (`RunoffPanel`:
  the parameters, a table of where the rain went (rain, evaporation, flow,
  exchange, change in storage, in mm and as a share of rain;
  `runs/runoff.ts`), and the production and routing stores through time,
  the chart beside the table only where the panel is 44rem wide or more (a
  container query on the panel, so at 1024 px, with the sidebar and the runs
  rail, it stacks under the table)),
  the **WR2012 check** when the project has a reference (`Wr2012Panel`,
  `#res-wr2012`, helpers in `runs/wr2012.ts`): the scaling rule and factor,
  the deviation flag in words (not colour alone), the MAR table (overlapping
  years and whole run: simulated, scaled WR2012, ratio), the 12-month table
  (simulated, WR2012 scaled, ratio) with dry-season months marked "dry", the
  dry-season ratio and the monthly pattern correlation,
  and (its own panel on [River & reserve](#river--reserve), beside the findings it qualifies) the **Uncertainty bands** on every run (engine ≥ 0.26.0, issue #4 phase 9,
  [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9);
  `uncertainty/UncertaintyPanel.svelte`, in River & reserve's chunk,
  `#res-uncertainty`; helpers in
  `uncertainty/bands.ts`). It shows the run's newest stored ensemble: the
  **decision rule** in a box above every band (thresholds, split date,
  percentiles, the 30-set gate, coverage test, sample), a line with the
  options (sets, seed, bounds, pan shift, rain sources, records, model, who
  stored it), **Parameter sets kept** (with the rejections by reason) and
  whether the run's own parameters pass, the **held-out coverage** per record
  (a warning, in words, below 70 %), then the tables: 5 %, median, 95 % and
  this run's own value for EWR days not met, the shortfall, natural and
  outflow MAR and the Reserve compliance rate per site with a rule table; EWR
  days not met by month (Oct … Sep); curtailment per farm (m³/day, negative =
  cut); annual natural and outflow volumes per water year (collapsed); and
  the **monthly flow-duration curve** of simulated outflow as a shaded 5–95 %
  band with its median against the dashed EWR line, one month at a time from
  a select (`uncertainty/BandFdcChart.svelte`, log flow axis; the chart's
  title says at how many exceedance points the median falls below the EWR).
  With fewer than 30 sets kept no percentiles are shown, only the note why.
  An ensemble run on a newer engine than the run says so. **Reproduce in
  this browser** re-runs the stored ensemble from its seed and options and
  reports "Reproduced: the same … members, verdicts, outputs and coverage" or
  the first differences. Below, **Every ensemble of this run** lists each one
  ever started, newest first (who, when, stored or "started, never stored",
  seed, sets, kept), each with how its rule differs from the shown one, and a
  line counts the starts never stored. Editors get **Run an ensemble**: sets
  (30–1 000, default 300), bounds (the fit's, typical or wide), lowest skill
  kept, worst WR2012 flag kept, the low-flow bias limit (or off) and the pan
  coefficient shift (on a GR4J run with a monthly PE row, engine ≥ 0.31.0,
  the shift is 0 and the ensemble's notes say the pan coefficient is not
  varied); **Run ensemble** asks the server to fix the rule and
  draw the seed, runs every member in the calibration worker with a live
  count ("Running: 120 of 301 members, 41 kept so far", Cancel), then the
  server checks and stores it. A cancelled one stays in the list as never
  stored. Under the bands, in the same panel, the **Sensitivity runs**
  ([§ Sensitivity runs](#sensitivity-runs)). **Run notes** on every run (`runs/RunNotes.svelte`,
  `#res-notes`, helpers in `runs/notes.ts`): the modeller's written
  explanation of the run, the one thing about a run that can change after it
  is made. Editors get a textarea with a character count (4 000 at most) and
  **Save notes** (`PATCH …/runs/:runId`); viewers see the text, or "No notes on
  this run". When the WR2012 flag is *query* or *not usable* and there is no
  note, a prompt asks for the reason. "Last changed … by …" shows under a
  note. Saving updates the shown run, its cached detail and its row in the
  runs list; the note also appears on the compare page and in the summary CSV.
  The same panel then holds the **Evidence** section
  (`runs/EvidencePanel.svelte`, `#res-evidence`, helpers in
  `runs/evidence.ts`; the menu entry is **Notes & evidence**, one entry for
  the panel): whether the shown
  run is the project's nominated evidence run ("Nominated as evidence on … by
  …", or "…; replaced by “B” on …" for a past one) and, when another run is,
  which. Editors get a required **Why this run is the evidence** textarea (2 000
  characters at most) and **Nominate as evidence** (or **Nominate this run
  instead** when another run is current; `POST …/evidence`). A legacy-model
  run (a stored run from before engine 1.0.0, which removed the model) and
  the current evidence run say why they can't be nominated instead.
  While a run is nominated, editors also get **Withdraw the nomination…**,
  which opens a required **Why the nomination is withdrawn** textarea and
  **Withdraw the nomination** (`POST …/evidence/withdraw`, 098); afterwards
  the section says "The project's nomination was withdrawn: no run is its
  evidence now." and any run may be nominated again.
  Under it the **Nomination history**, newest first: "Nominated “A” on … by
  …", then each "Replaced by “B” on … by …" or "Withdrawn on … by …" (a run
  nominated after a withdrawal reads "Nominated" again), each nomination with
  the run's runoff model and engine version, every row with its reason, the
  current one badged. Nothing in the
  history can be edited or removed. In the runs list the current evidence run
  carries an **Evidence** badge and a replaced one **Former evidence**; neither
  has a delete button (the server refuses with `409`). The run header repeats
  the badge and the evidence line (a link to the section). Above the results,
  a warning appears when a run made **after** the nominated run uses a
  **different runoff model** ("1 run made after the nominated evidence run “A”
  uses a different runoff model (legacy (b023 workbook), not GR4J). The
  nomination still stands: …"), so neither an applicant nor an assessor can
  miss a later model switch. Since engine 1.0.0 every new run is GR4J, so
  only a stored legacy run made after the nomination can raise it.
  Below the evidence, **Reproduction** (`runs/ReproducePanel.svelte`, in the
  Runs chunk, helpers in `runs/reproduce.ts`; WP-3.1): for a run with stored
  inputs, **Check reproduction** (viewers too) re-runs it on the server from
  them (`GET …/runs/:runId/reproduce`) and says **Identical** (with the engine
  version), **Differs in N places** (each listed: a summary value, or a
  node's series with its differing days, first date and largest difference;
  an error when the engine is the same version, a warning when it changed),
  **Not reproducible**, or why a stored input can't be used. A run from
  before stored inputs says so instead of offering the check. The
  flow-duration curve with Q10–Q95 (engine `views/fdc.ts`: the Q table is
  `fdcPercentileTable`, the same function the run summary CSV, the .xlsx
  workbook's Summary sheet and the report's Calibration section read, so an
  export carries exactly the chart's numbers, issue #45; when the observed
  record misses some of the run's days, every curve and the Q table rank only
  the days with a reading by default, `onDaysOf`, so they compare like with
  like, and **Observed days / Whole run** switches; the caption says which
  days each curve ranks),
  EWR against outflow and **Reserve compliance by month** (both on
  [River & reserve](#river--reserve) since issue #17) when the run has a rule
  table (`#res-reserve`, `runs/EwrAssurancePanel.svelte`, helpers in
  `runs/ewrAssurance.ts`; engine ≥ 0.21.0, model.md §2.9c): a site picker
  when there are several, the method in one sentence and the table's source,
  led by its confidence when the table states its kind (engine ≥ 1.5.0:
  "Gazetted Reserve: …", "Desktop estimate, low confidence: …" set apart in
  the caution colour, "Other source, confidence not stated: …"; the printed
  report shows the same line, since it reuses the panel), then, when the
  table records the determination's natural MAR (engine ≥ 1.11.0), the run's
  natural MAR against it ("Natural MAR at the site: 12.0 Mm³/a in this run,
  20 % above the determination's 10.0 Mm³/a", in the caution colour with the
  reason when it is beyond ±15 % and the percentile is from the run),
  a verdict line ("Met in 18 of 24 months (75.0%); not met in 6.", with a
  coloured edge and the words, never colour alone), a caution when a calendar
  month has fewer than 10 years, four figures (months met, longest run not
  met, deficit in Mm³ with the mean shortfall, the FDC check), a bar chart of
  the share of months met per month of the year on a fixed 0–100 % axis with
  each bar's value written above it, the same by month of the year as a table
  (years, met, %, mean required and simulated flow in the table's unit, deficit,
  FDC points met), and, from engine 1.19.0 (calibration research CR-29,
  helpers in `runs/ewrReporting.ts`): a fifth figure, **EWR as % of natural
  MAR** ("50.0 %nMAR", with the mean annual EWR and the site's natural MAR in
  Mm³/a, and the low flows' % with a low-flow grid); **from daily data**
  (`runs/EwrDailyCompliance.svelte`) a sentence for the whole run ("Below the
  day's requirement on 10 of 365 days (2.7% of the time); 2.7% of the
  required volume was not delivered") and a table by month of the year with
  the monthly verdict beside the days not met, % of time and % of volume not
  met, a month of the year whose every month was met but had short days
  marked **short days** in words; and the **flow-duration curves on the EWR**
  (`runs/EwrFdcOverlay.svelte`): a month select (opening on the first month
  whose simulated curve falls below the EWR at a point), a key naming each
  line, the run's natural flow (dashed), present-day flow (solid) and the EWR
  curve (dash-dot, the text colour) at the table's % points on a log scale,
  and, collapsed, **Values for** the month as a table. Then, collapsed, **Month by month**: every complete month's
  natural flow, its condition (% exceedance, or wetter / drier than the table),
  the requirement, the simulated flow, the share of the requirement and met or
  not met (rows not met shaded). From engine 0.33.0 ([model.md §2.9d](./model.md)),
  a **heat map** of the chosen site: water-year rows × Oct … Sep, each month
  blank when met, light blue with ◐ when only the high flows were short (the
  low flows met; only with a low-flow grid), dark blue with ● when the low
  flows (or, without a low-flow grid, the month) were short, the number the
  simulated flow as % of the requirement, each cell's full reading in its
  title and for screen readers, and a key; with a low-flow grid, a **Low flows
  met** figure, a column in the by-month table and two in Month by month; and
  with high-flow components, a **High flows** table (each component, its
  months, peak, days, per year and "Met in 3 of the 4 water years whose
  natural flow had it") and, collapsed, **High flows year by year** (natural,
  simulated and required events). The daily requirement is the series
  `ewr_rule` in the explorer and the daily CSV. Then the monthly EWR compliance grid (per farm, from engine
  0.17.0, the days it was charged and the volume charged, "(EWR charge)" in the
  site picker), the **EWR test
  against observed flow** (`ewr/EwrAgreementTable.svelte`, `ewr/agreement.ts`;
  [model.md §2.9b](./model.md)): a one-line verdict on the frequency bias, the
  hit rate, false-alarm ratio and frequency bias, the 2×2 table of observed
  days (model below / at or above the EWR × observed below / at or above, with
  totals), a per-month table (Oct … Sep, every month listed, months without
  observed days shown as dashes) and, collapsed, a per-water-year table. A run
  without a gauge or logger record, or saved before engine 0.5.3, says why
  there is no table. The **Plausibility checks** (`#res-plausibility`,
  `runs/PlausibilityPanel.svelte`, part of the Runs tab's chunk, helpers in
  `runs/plausibility.ts`; engine ≥ 0.25.0, [model.md §2.10d](./model.md);
  only on runs that have them): the dry season in one sentence, a line per
  check (*no finding*, *see below* or *not checked*, with a coloured edge and
  the words), then (1) **Natural flow ≥ observed + net abstraction**: a row per
  water year with natural, observed, the abstraction split into use, dams and
  land cover, observed + abstraction, the gap as % of natural and passes /
  fails / not judged (failing rows shaded); (2) **EWR days by rain source**:
  the share of days not met in good-rain and fallback-rain years, the Reserve
  months met split the same way per rule-table site, and, collapsed, each
  water year's station days, rain, fallback shares and days not met; (3)
  **Observed flow against rain (double mass)**: the whole-record runoff ratio
  and a row per break with the observed and simulated ratios, the change
  beyond the model overall and by season, and what it points to; (4) the
  **dry-season low-flow duration curves** (log axis by default): gauge and
  logger dashed, simulated outflow and natural flow, and the simulated outflow
  of the latest run of another runoff model (since engine 1.0.0 only a stored
  legacy run can be one; fetched on demand, left out with a note when it used
  another dry season); *Simulated outflow over* switches this
  run's curve to one record's days; a verdict on the Q90 comparison and a
  Q70 / Q90 / Q95 table; then, when a gauge inside the network has its own
  record (engine ≥ 1.4.0), **At gauges in the network**: a row per gauge with
  its record, the share of the catchment's natural flow above it, check 1's
  failing water years and check 4's Q90 ratio with *within* / *outside the
  factor of 2* (a failing gauge's row shaded), and a line in the check
  list. From engine 1.19.0, after the low-flow curves, **Recession
  diagnostics** (`runs/RecessionDiagnostics.svelte`, helpers in
  `runs/recession.ts`; [model.md §2.10d](./model.md), *Recession
  diagnostics*, CR-13): the segment rules in one sentence, a verdict (the
  simulated recession rate at the observed points' median flow as *n× faster
  / slower*, the difference in b, and whether that is within the indicative
  limits; *Not judged* with fewer than 8 segments), a scatter of −dQ/dt
  against Q on log–log axes for the record and for the simulated outflow on
  the same days with each fitted line (`LineChart` in `xy` mode: x is
  log₁₀ Q labelled as flows, y its log scale; the points are rebuilt in the
  browser from the run's stored `observed_flow` and `simulated_outflow`
  series with the engine's `recessionPoints`, so the summary holds only the
  segments and fits), and a table of a, b, −dQ/dt ÷ Q at the reference flow,
  points and segments per fit. The check list gains a *Recessions* line on
  those runs; an older run shows neither. The Compare page sets these checks side by side
  ([run-comparison.md](./run-comparison.md#plausibility-checks)). Hydrological unit detail (on Hydrological units since issue #17; dam
  storage as % of the capacity the run had, from its model snapshot, not
  today's model, `runDamCapacity`; supply against demand), and an explorer for any
  stored series, grouped by node. The catchment's series include the final
  catchment rainfall, CHIRPS as uploaded and bias-corrected CHIRPS
  (`rain_final`, `rain_chirps`, `rain_chirps_corrected`, engine ≥ 0.10.1)
  and the day's CHIRPS factor (`chirps_factor`), which the catchment daily CSV
  puts in adjacent columns after rain used. The summary CSV lists the 12
  monthly factors.
- **Assurance of supply** (`#res-assurance`, on Hydrological units after the
  curtailment table, under *Units & users* on the Runs tab until issue #17;
  `reliability/AssurancePanel.svelte`, helpers in
  `reliability/reliability.ts`, in the Hydrological units chunk; engine ≥ 0.32.0, WP-3.4,
  [model.md §2.11a](./model.md)): per farm and other water user over the
  reporting window, the % of demand days fully met, the % of demand
  supplied, complete water years met against the annual threshold (Settings;
  from engine 1.11.0 a part year at either end of the window is left out, and
  the note under the table says how many), the
  failures and their mean and longest length, and the mean and largest
  deficit per failure. Below it the **stress classes by month**: a heat map
  in the EWR grid's pattern (water-year rows × Oct … Sep, arrow keys move
  between cells), for all farms and users together or one of them (a *Show*
  picker), each cell carrying the class name (Low, Mod, High, Sev, Crit) so
  colour is never the only cue, with a legend of the ranges and a count of
  months per class.
- **Outcome matrix** (`#res-outcomes`, on River & reserve after the
  uncertainty bands; `outcomes/OutcomeMatrixPanel.svelte`, in River & reserve's chunk):
  the run's inputs at a few demand levels by class of water year, described
  in [§ Outcome matrix](#outcome-matrix) below.
- **Seasonal outlook** (`#res-outlook`, on River & reserve after the outcome
  matrix; `outlook/OutlookPanel.svelte`, in River & reserve's chunk): the season from the
  run's state at a few demand levels over the record's past years, described
  in [§ Seasonal outlook](#seasonal-outlook) below.
- **Water account** (`#res-water-account`, last on River & reserve;
  `reliability/WaterAccountPanel.svelte`, in River & reserve's chunk; [model.md §2.11b](./model.md)):
  two bars for the chosen period (*Period*: the whole run or a water year),
  what came in and where it went or was stored, each with a labelled key;
  then a table of every term per water year and the whole run (terms a
  network doesn't have are left out), the change in dam storage and the
  residual (to two significant figures, float noise), and the EWR required
  vs met at each site. Runs before engine 0.32.0 show *Not computed by
  engine x.y* in both panels.
- **Small flows and volumes** (issue #45). Figures in m³/s, l/s and Mm³ keep
  their fixed decimals (3 for m³/s and Mm³), but a non-zero value those
  decimals would show with fewer than two significant figures is shown to two
  significant figures instead (`fmtQty`, `lib/format/number.ts`): a dry
  season's Q90 of 0.00042 m³/s reads *0.00042*, never *0.000*, and a small
  dam's volume in the water balance by water year is no longer *0*. Zero stays
  0 and values from 1 up are unchanged. This covers the headline cards, the
  FDC percentile table, the water balance, the WR2012 check, the EWR
  assurance volumes and the farm totals line; the plausibility warnings'
  text follows the same rule (engine `plausibility/format.ts`). Tables in
  m³/day (farms, curtailment) keep their decimals: one m³/day is already a
  fine enough step.
- Series are fetched one at a time when a chart needs them, and cached
  (`runs/cache.ts`). A run stores well over a hundred series of one value per day of the run
  on a multi-farm catchment (more since engine 0.12.0: each farm adds 11 working columns).
  Large arrays live in `$state.raw` and are replaced, never mutated.
- **Report**, beside the Download menu in the run header, opens the shown
  run's printable report (§ Report below).

### Sensitivity runs

Calibration research CR-21 ([model.md §2.10g](./model.md#210g-sensitivity-runs-ewr-compliance-as-a-range-engine--1180-calibration-research-cr-21)):
how far EWR compliance moves when one input the record can't settle is
changed at a time. On [River & reserve](#river--reserve), under the
uncertainty bands in the same panel (`#res-uncertainty`; the **Uncertainty**
link of the page's menu reaches both), `uncertainty/SensitivityPanel.svelte`
with its chart `uncertainty/TornadoChart.svelte` and helpers
`uncertainty/sensitivity.ts`.

- **Anyone who can see the run** can press **Run sensitivity**: the page
  fetches the run's own inputs (`…/model-input`) and the calibration worker
  runs the central case and each factor's low and high (at most 11 model
  runs, under a second on the examples), with a count ("5 of 11 runs") and
  Cancel. **Nothing is stored**: it is a live diagnostic, like
  `pnpm pan-sensitivity`, and **Run again** repeats it (the same inputs give
  the same numbers).
- A line names each factor's settings (Rain × 0.9 / × 1.1 · Pan coefficient
  × 0.85 / × 1.15 · Dam evaporation factor × 0.85 / × 1.15 · Abstraction
  (demand) × 0.7 / × 1.3 · Initial dam storage empty / full), the reporting
  window and the engine version. Factors that don't apply (no dam, no
  demand, a monthly PE row) are listed under **Not run** with the reason.
- **Thresholds**: the share of days the EWR must be met, and with a rule
  table the share of months meeting it, both 80 % by default (a note says
  they are defaults pending the hydrologist). Changing one re-judges at once,
  without a re-run.
- **The verdict**, one line per EWR site, with a coloured edge and its name
  in words: *Meets the threshold*, *Below the threshold*, *Not determinable
  with current data* (the range over every run crosses the threshold) or
  *Nothing to judge*, then the engine's sentence with the range, the central
  value and the threshold.
- **The tornado** for one site (a select when there are several) and one
  result: EWR days not met, the shortfall (Mm³), and with a rule table the
  months meeting it (shown first then). One row per factor, largest swing
  first: a blue bar from the central run to the low setting and an orange one
  to the high, each setting named beside its bar; the central run is the
  solid line, the threshold the dashed one (on days not met, the days the
  threshold allows; none on the shortfall). The chart's accessible name
  carries every number, and the table under it gives the same rows (low,
  its result, high, its result, swing).

### Outcome matrix

Issue #53 R4 ([planning-outputs.md §3.4](./design/planning-outputs.md#34-r4-year-classes-and-the-outcome-matrix-m),
[model.md §2.14](./model.md#214-water-year-classes-and-the-outcome-matrix-issue-53-r4-engine-half)).
A panel on [River & reserve](#river--reserve) (`#res-outcomes`; until
issue #17 under *River & Reserve* on the Runs tab; `outcomes/OutcomeMatrixPanel.svelte`, in River &
reserve's chunk, view model `outcomes/matrix.ts`).

- **Starting a sweep** (editors): **Demand levels** (% of today's farm
  demand, default *100, 85, 70*; up to 12, 0–200 %, separated by commas)
  and **Run demand sweep** queue a [sweep](./scenarios.md#sweeps) of the
  shown run: one member per level, each a single `demand.scale` op on every
  farm, named "85 %". Only on an ordinary run of the model (a scenario or
  forecast run says it can't), and only when the run stores its natural
  flow. Viewers see the newest sweep, with no button.
- **Pending and complete** follow the sweep's own status and its job's
  (`GET /projects/:id/sweeps/:sweepId`, polled every 1.5 s while pending):
  *Queued: waiting for the background worker*, *Running the demand
  levels…* with a progress bar, a retry, or, for a sweep whose job died,
  why it couldn't run. The panel shows the base run's **newest demand
  sweep** (a sweep whose every member is one plain `demand.scale`; other
  sweeps, such as R5's, are skipped) and carries `data-state` (`loading`,
  `empty`, `pending`, `stuck`, `complete`).
- **The matrix**: rows are the demand levels in the sweep's order,
  columns the water-year classes of the **base run's** natural flow at the
  outlet, by the project's method (Settings → Outcome matrix), each headed
  with its bounds in m³ of annual natural flow and its **n years**. Each cell
  is coloured by risk (green, amber, red, plus a coloured edge) **and**
  names it (*Lower risk*, *Increasing risk*, *High risk*), with the
  engine's sentence counting years (`describeOutcomeCell`: "EWR met on
  every day in 2 of 3 dry years (below it on 4 % of days)"); a class with
  fewer than 3 years reads *Not enough years*, uncoloured. A member whose
  ops didn't apply, or that the engine refused, is a row saying so, with the
  reason. The classes and colours are worked out in the browser from the
  stored sweep, so changing the settings re-reads a sweep without running
  it again.
- **Reserve site** (`settings.outcomes.siteNodeId`): a picker, shown when
  there is more than the outlet to pick, of the outlet and every gauge above
  it with a Reserve rule table (Settings → Reserve rule tables), in network
  order. It is a **project setting**, not panel state, so the matrix a
  viewer or a colleague sees is the one the editor chose: an editor's
  pick is saved at once (`PATCH` `settings.outcomes`), a viewer sees it
  disabled. At a gauge the matrix reads that gauge's Reserve months met,
  from each member's stored run summary (no new sweep needed); at the outlet
  the measure is chosen as before. A sweep with no results at the chosen
  gauge (its base run was made before the gauge had a table) shows *This
  sweep has no Reserve results at gauge X … Run the model again, then run a
  new demand sweep of the new run.* instead of a table. A stored site that
  has lost its table or gauge falls back to the outlet with a notice saying
  so. The Settings form doesn't edit or send the site.
- **Around it**: badges for the **measure**, naming its site (Reserve months
  met at the chosen site when every level has a rule table there, else days
  below the pragmatic EWR at the outlet), the method and number of complete years,
  and **Risk cut-offs pending the hydrologist** while the measure in use has
  the default cut-offs; the cut-offs in words; the water years not classed
  (part years, or a missing day); and the engine's warnings (e.g. only some
  levels have a rule table, or too few years for every class to judge).
- **No recommendation.** The panel reports how past years went at each
  level ("Historical, not a forecast; the choice of level is the WUA's") and
  never picks one (a unit test holds the view model to that).

Tests: `outcomes/matrix.test.ts` (the adapter, NaN mapping, n years, not
enough years, default vs custom cut-offs, problem members; the site list,
an ineligible stored site, the metric switching with the site, a sweep
without the gauge's results), `backend/src/projects/outcomeSettings.db.test.ts`
(who reads and writes the site, which nodes it accepts, copies) and
`e2e/tests/outcome-matrix.spec.ts` (settings, sweep, worker, the rendered
matrix against the stored series; a gauge's matrix against its stored
Reserve months, the viewer, the fallback).

### Seasonal outlook

Issue #53 R5 ([planning-outputs.md §3.5](./design/planning-outputs.md#35-r5-the-seasonal-outlook-ml),
[model.md §2.15](./model.md#215-seasonal-outlook-an-esp-ensemble-from-a-decision-date-issue-53-r5-engine-core)).
A panel on [River & reserve](#river--reserve), after the outcome matrix
(`#res-outlook`; until issue #17 under *River & Reserve* on the Runs tab;
`outlook/OutlookPanel.svelte`, in River & reserve's chunk,
view model `outlook/view.ts`). For the WUA; English, like the workspace.
There is no farmer view yet (ask E3 waits on the client's O5).

- **Starting an outlook** (editors): **Demand levels** (% of today's farm
  demand, default *100, 85, 70*; up to 6, 0–200 %, separated by commas),
  each one `demand.scale` op on every farm from the decision date. **Add a
  monthly plan** adds one more level: a name (default *Monthly plan*) and
  a % per month of the project's season (Oct … Apr by default), sent as
  R1's `months` form, one `demand.scale` per distinct % (so the plan and
  the levels together are at most 6). **Run seasonal outlook** queues an
  [outlook](./api.md#seasonal-outlooks) of the shown run; the season and
  the planning share are the project's settings (Settings → Seasonal
  outlook), the decision date the latest one the run's state reaches. Only
  on an ordinary run (a scenario or forecast run says it can't). Viewers
  see the newest outlook, with no button.
- **Pending and complete** follow the outlook's own status and its job's
  (`GET /projects/:id/outlooks/:outlookId`, polled every 1.5 s while
  pending): *Queued: waiting for the background worker*, *Running every
  demand level in every analogue year…* with a progress bar, a retry, or,
  for an outlook whose job died, why it couldn't run. The panel carries
  `data-state` (`loading`, `empty`, `pending`, `stuck`, `complete`).
- **Badges**: the season (*1 Oct 2018 – 30 Apr 2019 (212 days)*); the
  planning share (*80 % of analogue years*); the
  measure (days below the pragmatic EWR at the outlet, or Reserve months
  met with a rule table there); the number of analogue years. Then the
  farm dams' storage on the day before the decision date, which every year
  starts from.
- **The table**: one row per demand level, in the order given: **dam
  storage at season end**, **hydrological unit demand met** and **days below the EWR**
  (or **Reserve months met**), each the median in bold with its 10–90 %
  range under it, and **years met in full** ("EWR met on every day in 7 of
  12 years"). The planning figure's level carries a **Planning figure**
  badge. A level whose ops didn't apply is a row saying so, with the reason.
  Under it, plainly: lower demand doesn't always mean fewer days below the
  EWR, because part of the water irrigated from a dam drains back to the
  river (model.md §2.15's invariants).
- **Planning figure**: the engine's `describePlanningFigure`, counting
  years ("70 %: met the EWR on every day of the season in 12 of 12
  analogue years, the highest demand level to do so in at least 80 % of
  them"), and that the WUA decides the level and publishes it as the
  restriction notice. **Too few years** (fewer than 10): a warning, no
  ranges and no planning figure; each year's values are still shown.
- **Every analogue year** (collapsed): per year and level, the days below
  the EWR (or months met) and the season-end storage. Then the years not
  used and why (outside the record, a rainless day, the season itself,
  over the 40-year limit, a failed member), members the engine refused,
  the engine's warnings, and the disclaimer's first and third paragraphs
  (not predictions; not official restrictions or allocations), with the
  draft note only while the wording is marked draft (D10).
- **No recommendation.** The panel reports how past years went at each
  level and never picks one (a unit test holds the view model to that, and
  the e2e spec checks the rendered panel).

Tests: `outlook/view.test.ts` (the request and monthly plan, the state,
the view against the engine's `summariseOutlook` on invented members, the
pending badges, too few years, the wording guard, the settings check) and
`e2e/tests/seasonal-outlook.spec.ts` (settings, outlook with a monthly
plan, worker, the rendered table against the stored per-year values
re-summarised by hand, a viewer).

## Compare runs (`?tab=compare`)

Board A4 of issue #17: a baseline and up to two what-ifs on one page
(`compare/CompareView.svelte`; also the standalone `/compare` page, which
gives it an `h1` and **Back to runs**). The full reference is
[run-comparison.md](./run-comparison.md); the layout, top to bottom:

- **Header:** in the workspace, the section header (the page's only title)
  carries the view's context line ("Baseline “…” against 2 what-ifs · same
  period, 2021–2024 · engine 0.45.0") and its actions, filled with
  `fillHeader`; the view draws no title of its own there. The standalone
  page has no section header, so the view draws its `h1`, the context line
  and the same actions beside **Back to runs**. The actions:
  - **Export impact report:** the what-if's printable report with an
    *Impact against the baseline* section first
    (`/projects/<what-if's project>/report?run=<what-if>&against=<baseline ref>`,
    § Report). A plain link with one what-if; with two, a menu naming each
    ("What-if 1: <label>", its colour key beside it), which Escape or a
    click outside closes.
  - **+ New what-if** (owner and editor of the baseline's project only):
    the Scenarios tab's create dialog, `?tab=scenarios&new=1&base=<baseline
    run>`, with the baseline as its base run (left to the dialog's default
    when the baseline is itself a scenario run). Its run then compares here
    like any other.
- **Run cards** in three columns (one on a phone): Baseline, What-if 1 and
  What-if 2, each a fieldset (legend = its name) with a coloured top edge
  (baseline grey `--text-muted`, what-if 1 `--series-2`, what-if 2
  `--series-1`, the same colours in the table keys and the chart), the run's
  label, one line (the baseline's years, when it ran and its tags; a
  what-if's lead input change, `summary.ts` `leadChange`, with **all N
  changes**) and its project and run pickers, each label beside its select.
  With no second what-if the third column is a dashed **+ Add a second
  what-if** card; What-if 2 has **Remove**. Focus moves to the new card's run
  select on add, and back to the add button on remove.
- **What changes** (left, ~55 %): the outcomes table (reserve met, days
  below the reserve per average year, irrigation supplied, farms below 95 %,
  up to two most-changed farms, dam storage at the end of the run (when a
  run has a dam), mean outflow, calibration NSE when there is one), each what-if cell its value over its `Delta`, the unit on its own
  line under the outcome; then the takeaways box (the first worse, else
  better, takeaway in bold, the rest listed; red, green or grey by that
  lead's tone, whose words also say the direction).
- **Days below the reserve, each year** (right): grouped bars per water year
  (`ReserveYearsChart.svelte`, a chunk shared with River & reserve; part years faded), a legend,
  a note and **Show as a table**. Its value axis is labelled "days below";
  when every year is 0 the plot says "No day below the reserve in any
  year" rather than showing empty bars. It fills the height of its row.
- **Full comparison:** a divider, "Baseline (run A) against What-if 1 (run B)",
  a **Baseline vs What-if 1 / 2** radio switch when there are two what-ifs,
  then every panel of the two-run comparison, unchanged.

At 1440×960 the header, cards, table and chart fit above the fold; below
1100 px the table and chart stack, below 900 px the cards. The standalone
`/compare` page sits in the app frame with **Projects** as its current
section; on a phone neither it nor the tab scrolls sideways (the delta
cells' screen-reader words are clipped by their table's box, app.css
`.table-wrap`; `e2e/tests/report-pages.spec.ts`).

## Scenarios (`?tab=scenarios`)

Issue #18 stage D, WP-3.2 ([scenarios.md](./scenarios.md)):
`lib/components/scenarios/`, a lazy tab after Runs & results. A scenario is a
named list of changes (ops) on a base run, run and compared without copying
the project. Viewers read every scenario and its comparison; farmers never
see the tab (the workspace sends them to the farm page, and the API refuses
them scenarios).

- **Layout** (issue #17, option A; the Dams and Hydrological units pattern of a
  list beside the picked item): the section header's context line counts
  the scenarios by status and how many have results ("5 scenarios · 4
  drafts · 1 submitted · 2 with results", `scenarios/summary.ts`), and its
  action is **+ New scenario** (editors, once there is a run to start
  from). The list is a rail beside the scenario from a 784 px wide section
  (a container query), as tall as the window from where it starts (less the
  save bar) and sticky, so it stays in view while the scenario scrolls; its
  rows scroll inside it. The scenario is an editing page and scrolls with
  the page. Narrower, the list stacks above the scenario, capped at a few
  rows that scroll inside it. With none picked, the first (newest) opens in
  place (`replaceState`, so Back leaves the section rather than stopping on
  the bare list).
- **The list**, newest first: each scenario's name (two lines at most),
  status as a pill in words, number of changes, base run and last run.
  Empty: "No scenarios yet. A scenario changes the published baseline
  without copying it.", with **Start a scenario** for editors, or, with no
  runs, that the model must be run first. The chosen scenario is
  `&scenario=<id>` in the URL.
- **New scenario** (`&new=1`, a dialog; Back, Esc, Cancel and the ✕ close
  it, dropping `new` in place): a name and a base run, the published run by
  default, else the latest, or the run named by `&base=<runId>` (Compare
  runs' **+ New what-if** opens it on its baseline) when that run can be a
  base; scenario runs aren't offered (a scenario run can't be a base).
  Closing drops `base` with `new`. **Create scenario** picks the new one and
  replaces the dialog's history entry. `new=1` opens nothing for a viewer or
  with no run.
- **The banner**: "Based on run *X* (run date, published)", and that the base
  is kept while the scenario exists.
- **Changes** (`OpList.svelte`): the ops in order, each in words against the
  input it meets, so a second change to one value shows the first one's
  value as "was" (`ops.ts` `describeOp`, `stepInputs` over the base run's
  model and settings snapshot from `GET …/runs/:runId`). Each carries its
  class, **Proposal** or **Baseline assumption**, from the server's check,
  and when it doesn't apply to the base, "Doesn't apply: …" with the
  engine's reason (ids named). Any baseline op puts the red **Baseline
  assumptions changed** callout above the list. When any op doesn't apply,
  a warning says so and **Run scenario** is disabled (the server refuses the
  run with `422` too).
- **Add a change** (`OpForm.svelte`, editors, drafts only): one form for every
  op of the engine's `ScenarioOp` union: change a node's value, add a node
  (a leaf farm or other water user), remove a node, set a farm's crop area,
  add a crop (optionally starting from another crop's factors), add, change
  or remove a transfer, add or remove land cover, change a setting, scale
  rainfall by a % change over a date range, scale demand (farms' irrigation
  or other water users', as a % of what they'd take, for ticked nodes and
  months; none ticked is all; `demand.scale`, issue #53 R1), set an EWR
  site's Reserve rule table (`ewrRule.set`, engine ≥ 1.6.0: the outlet or a
  gauge marked as an EWR site, then the Settings tab's own table editor,
  starting from the site's table; always a baseline assumption,
  [scenarios.md § Reserve rule tables](./scenarios.md)). A setting's value is typed as
  the Settings tab takes it; GR4J's PE input (`pe`, issue #39) has its own
  control, the source (pan coefficient × A-pan, or a monthly row in mm with
  a required source note), checked with the Settings tab's own rules
  (`settings/peInput.ts`), and a new monthly row starts from the PE GR4J
  runs on now. Targets come from the model as
  the listed ops leave it, so a node the scenario adds can be changed next.
  A field starts at its current value with "Now: …" under it; percentages
  are typed as %, areas in ha. The op is built and checked with the engine's
  own validator (`ops.ts` `buildOp`, `validateScenarioOps`), so a bad value is
  refused in the form in the units typed ("Must be at most 100 %"); whether
  it applies to the base is the server's check, shown once it is saved.
  Every edit is a `PATCH` of the whole op list, answered with the check.
  **Undo** steps back through this visit's edits; each op also has a ✕.
- **Edit in the model tables** (override mode, drafts only, for whoever may
  change the scenario: an editor on a team scenario, only its owner on an
  application; an applicant edits the applicant projection, with a note that
  other farms' values are blank;
  `OverrideEditor.svelte`, loaded when opened): the Network, Crops and
  Transfers tables, switched with a **Network / Crops / Transfers** control,
  on the scenario's model (its base run with its changes applied), under a
  banner in the warning colour, scrolled to the top of the window as it
  opens (below a long scenario the sticky record bar would otherwise cover
  it and its Close button): "Editing the scenario *X*, not the
  catchment", saying the catchment's own model isn't touched, with **Close
  override mode**. Notes, farmer links, the yield panel and colouring farms
  by a run's results are left out (they belong to the live model). The
  Network is its node table inline (`NetworkTab only="table"`), not the map:
  the map's Grids menu and farm links open the page's grid modal and farm
  drawer, which edit and save the catchment's model, and neither opens over
  the Scenarios tab. A navigation that stays on the scenario doesn't ask
  about unrecorded edits; leaving it does. **Edits to record**
  (sticky at the foot on wide screens) lists each edit as the change it will
  be, in the same words as the Changes list; **Record N changes** appends
  them (one Undo takes them back), **Discard edits** reverts. An edit no
  change can express (a crop's factors, a node's kind or what it drains
  into…) is listed there and disables Record until it is undone; the
  tables' own problems ("Fix before saving") block it too. While there are
  unrecorded edits the Changes list's ✕, Undo, Run, the status moves and
  Delete wait, and leaving the page asks first. The status moves (an
  application's Submit, Withdraw, Reopen and decision included) also wait
  while a run is in flight: the run re-reads the scenario when it ends, and
  that read could otherwise land after a submit and show the old status. The "Add a change" form and rebase are hidden while
  override mode is open.
- **The proposer's nodes**: a checkbox per node of the base. Changes to them
  (and to nodes the scenario adds) are proposals; the rest are baseline
  assumptions ([scenarios.md § Classification](./scenarios.md#classification-proposal-or-baseline-assumption)).
- **Actions** (editors), in the scenario's head row beside its name, status
  and Rename, so they're on the first screen however long the changes and
  the node list get; a run's error shows under the base banner: **Run
  scenario** (labelled with the scenario's name;
  the run joins the runs list and counts toward the 20-run cap), the status
  moves (**Submit** behind a confirm, **Withdraw**, **Mark decided**, **Back
  to draft**; only a draft's changes, nodes and base change), **Delete
  scenario** (draft or withdrawn; its runs stay as ordinary runs), and
  **Rename** (name and description).
- **Rebase onto another run** (drafts): pick a newer run of the model,
  **Check** (a dry run listing any change that no longer applies, for
  example a node removed since), then **Rebase onto this run**. A change on
  a node the new base lacks is still named, after a reload too: the server
  keeps the names each change needed with the scenario (`opNames`, 047).
  Only a node no base ever named reads "a node the base run doesn't have".
- **Scenario against its base** (`ScenarioCompare.svelte`): the latest run of
  the scenario against the base run *that run* was made on (so an older run
  of a rebased scenario is still compared with its own base), through
  `GET /compare/runs`: headline results, the farms table and the per-node
  daily overlay (the compare page's `CompareOverlay` and `overlay.ts`, issue
  #8). A feature the scenario adds or removes shows against 0 in the run
  without it: a river-first farm's *Pumped from the river* series (the base
  drawn as zeros, "run B only") and farm column ("A: none (0)"), under
  [run-comparison.md § Series and metrics only one run has](./run-comparison.md#series-and-metrics-only-one-run-has); with **Open the full comparison** (the Compare runs tab; for an
  applicant, who has no workspace tabs, the `/compare` page). A note says when the changes were
  edited since that run. Under the comparison, the scenario run's
  **Validation statement**, folded shut (the same `ValidationPanel` as a
  run's Record group, § Runs & results).
- **Runs tab.** A scenario's run is tagged **Scenario**; a run a scenario is
  based on is tagged **Scenario base** and has no ✕ (it is cited: kept, no
  delete or unpin, `RunMeta.citedBy`). The runs list reloads after a
  scenario is created, rebased or deleted, so the tag follows.
- **Compare page.** When either side is a scenario run, a **Scenario
  overrides** section above "What changed" lists that run's ops as it
  recorded them, with their classes and the callout (`ScenarioOverrides.svelte`,
  its own chunk).

## Allocations (`?tab=allocations`)

WP-3.10 first slice (`lib/components/allocations/`, a lazy tab;
[allocations.md](./allocations.md)); laid out as an option A page (issue
#17). A core tab: owners, editors and viewers see it; farmers never reach the
workspace.

**Section header.** The context counts the registered volumes, the ones not
matched to a unit, and the units above registered in the run shown ("40
registered volumes · 4 not matched · 6 units above registered";
`allocationsContext` in `allocations.ts`; "No registered volumes yet" when
there are none). The actions: the **run picker** (with more than one run;
`run=`, else the published run, else the latest; a `run=` that no longer
exists shows the default with a note), **Download CSV** (the export, names
for editors only), and for editors **Import** (`import=1`) and **+ Add
volume** (`volume=new`), each a side sheet that closes in place, so Back goes
to where it was opened from. A viewer opening a sheet link gets the page.

**Under the header**, a sentence naming the run and saying modelled use is
*modelled, not metered* and a difference is something to look into, not a
finding; slim notes for volumes not matched to a unit (editors: "Change a
volume to match it"), or matched to a unit the run doesn't have. A run made
with an allocation mode (engine ≥ 1.18.0, Settings › Registered volumes)
says what it did first (`MODE_NOTE`, `allocation-mode-note`): a cap ("This
run capped each unit’s use at its registered volume per water year …") or a
full allocation ("… what the river would look like if every registered user
took their entitlement, not what they take").

**Modelled use vs registered volume** is a list of each unit and water
source with use or a volume, the ones to look into first (`unitRows`): above
registered (most whole years over, then the largest ratio), use with no
registered volume (the most use), below registered (the smallest ratio),
within the band, then neither. Each row: the unit (a link, `unit=`), the
source, a status in words ("Above registered in 3 of 3 whole years", *No
registered volume*, *Below registered*, *Within band*), modelled ÷
registered, and the mean water year's registered volume and modelled use
("Nothing registered" when there is none; the part year's own figures when
the run covers no whole water year). The left edge is amber for above
registered or unregistered use, green within the band, grey otherwise; the
words say the same.

**The picked hydrological unit** (`unit=`, else the first row) sits beside the list: its
name with links to it **On the Network** and in **Hydrological units**; a bar per
water year and source under the caption "Modelled use per water year
(October–September), m³" (modelled use, amber above registered, green within
the band, with the registered volume as a line across it, and its modelled
m³ written beside it; hidden from screen readers, the table under it
carries the numbers); the same years as a table (registered
m³, modelled use m³ "modelled, not metered", modelled ÷ registered, the
status badge with its full sentence in the title, "part (N d)" for a part
year); its registered storage beside the dam capacity in the run; and its
registered volumes (volume, source, authorisation, registration number, the
holder for editors only, validity), each with **Change** and **Delete** for
editors. From 1100 × 620 the list and the picked unit are the height left in
the window, each scrolling inside its card; a link to a unit further down the
list scrolls the list (not the page) to its row.

**Registered volumes** (below the first screen): the list, stacked so it
fits at 1280 without sideways scroll: unit (or **Not matched**, highlighted)
with the registration number under it, the registered user for editors only,
authorisation with purpose, volume with source, storage, validity with where
it came from (the file name and the first 12 hex digits of its SHA-256, or
"Entered by hand") and, when it states any, its licence conditions in one
line ("Oct–Mar only · at most 0.05 m³/s · 2 conditions", `conditionsSummary`,
the conditions themselves in its title), and **Change** / **Delete** for editors (the form's unit
picker is how a row is matched by hand). Viewers see "Names of registered
users are shown to editors only." Under it, **Imported files**: each with its
full hash, reference, row count, who and when, and **Remove this import**.

**Every hydrological unit and water year**: the whole comparison as one table (one row
per unit, source and water year, the run's order; a source with neither use
nor a volume is left out) with the band note under it, scrolling inside its
box.

**Import registered volumes** (the Import sheet, `AllocationImport.svelte`):
what the file is (WARMS extract or CSV template), a reference, the file, and
**Download the CSV template**. The preview says how many rows matched,
didn't, or have problems; the table lists rows with problems first (the
problem in red), then unmatched rows, each with a unit picker ("by farm
name", "chosen by you"); type and source share a column. **Import N rows**
(pinned at the sheet's foot, with Cancel) stores the valid ones, closes the
sheet and says how many were imported, left out and still unmatched. Errors
(a refused file, a file already imported) show in an alert in the sheet;
closing the sheet drops a preview.

**Add or change a volume** (`AllocationForm.svelte`, `volume=new` or
`volume=<id>`): unit or water user (or "Not matched yet"), authorisation,
source, purpose, volume, storage, valid from/to, registration number,
property, the registered user (editors), reference, and **Licence
conditions** (issue #72; "shown, not yet applied by the model"): the months
water may be taken (twelve boxes in water-year order, none ticked = none
stated, each a 24 px target), the maximum rate (m³/s) and the other
conditions one a line; Save and Cancel pinned.

**Phone and narrow windows**: one column (list, picked unit, volumes, every
year); the list shows six rows until **Show all N hydrological units and sources** and the
volumes eight until **Show all N registered volumes**; each volume and each
year row is a card with its values two to a line under their labels
(container queries); picking a unit scrolls its detail into view.

- e2e: `e2e/tests/allocations.spec.ts` (import, manual match, comparison, a
  viewer without names, phone cards, axe) and
  `e2e/tests/allocations-page.spec.ts` (the header, the order, window fit,
  `unit=` and Back, a shared unit link, the sheets, `run=` and a deleted run,
  empty states, 1280 and phone layouts, a viewer, axe in both themes; a
  30-unit catchment with 40 volumes from `e2e/support/allocations.ts`).

## Applications (WP-3.3)

A **contributor** (a licence applicant or their consultant; the Members
panel calls the role "Applicant") never sees the workspace's tabs, which the
API refuses them. `/projects/:id` shows them the **Applicant view**
(`lib/components/scenarios/ApplicantView.svelte`, a lazy chunk; the page
detects the role from the project list after the `403`, as it does for a
farmer). It has the same frame as every workspace section (issue #17): a
section header titled **Applications** with an "Applicant view" badge, a
context line (the catchment's name, "Baseline published <date> by <who>",
and links to their own farms' farm view if they have links) and one slim
notice (their applications start on the published baseline; other farms
show only by an anonymous name). Under it, the Scenarios tab in applicant
mode ("Your applications"; `?scenario=<id>` selects one):

- **New application**: the section header's action, opening the same
  dialog at `new=1` with a name only; it starts on the current
  publication's run. With nothing published, the list says so and there is
  no button. The list scrolls inside its card, so the header and its
  button stay on the first screen with thirty applications.
- **The editor** is the Scenarios editor, with the base from
  `GET …/scenarios/:sid/base` (other farms as "Farm 1", "Farm 2", their
  values blank, so an op on one isn't described "from" a value). Their own
  farms are the proposer's nodes, set by the server (no checkbox list); no
  rebase. **Run scenario** runs it; instead of the comparison, a note says
  the assessors compare each run with the baseline (an applicant view of
  results is a follow-up).
- **The Application panel** (`ApplicationPanel.svelte`) under the changes:
  where it stands ("Draft: only you and the people you share it with can see
  it", "Submitted: the assessors can see it, and its changes are frozen", …),
  the owner's **Submit to the assessors** (confirmed; disabled while a change
  doesn't apply), **Withdraw** and **Reopen as a draft**, the decision once
  made (outcome, by whom, when, the reasons), and **Shared with**: the
  people who read it, Remove / Leave, and for the owner a **Share with**
  picker of the people they may share it with (`…/share-candidates`: an
  applicant's own applying party; no address box, so it says nothing about
  who else is a member). With nobody to pick it says why ("Nobody to share
  it with yet: the project owner lists who is in your party", or "Everyone
  you can share it with already reads it"). An assessor opening an
  application whose names displaced a hidden farm's or crop's sees which
  ("… in this application's runs Kalkoenkrans is called “Kalkoenkrans (2)”",
  `check.renamed`), and likewise a new item given the id of one the
  applicant can't see (`check.reIds`, "their transfer … is …-2"); the
  applicant never does.

The assessors (owners and editors) get an **Applications** tab
(`?tab=applications`, issue #17 option A): every submitted, withdrawn or
decided application (drafts stay with the applicant). A viewer never sees it.

- **Section header:** the count, how many await a decision and how long the
  oldest has waited ("30 applications · 20 awaiting a decision, the longest
  for 30 days"; "No applications submitted yet"), and **Decide the longest
  waiting**, a link to that application in the Scenarios tab (only while
  one awaits a decision). The counts and wording are `applications.ts`.
- **Submitted applications** card: a one-line note (on the published
  baseline; open one to see its changes and runs and decide it; drafts stay
  with the applicant), a status filter (**All**, **Awaiting a decision**,
  **Decided**, **Withdrawn**, each with its count; `&status=awaiting|decided|withdrawn`
  in the URL, so Back steps through the filters and a link keeps one; an
  unknown value shows all) and **Sort by** newest first or status (awaiting
  a decision first, the longest-waiting on top).
- **The table:** name (a link to it in the Scenarios tab), applicant ("shared
  with N" under it), status as a pill in words (Awaiting a decision;
  Approved, Approved with conditions or Refused in the band colours, with
  "decided <date>" under it; Withdrawn), submitted (date and time, and
  "waiting N days" while it awaits a decision), changes and runs.
- **Fit:** from 1100 × 620 the card fills the window and the rows scroll
  inside it under a sticky header; below a 640 px column each application is
  a card (name, status, applicant, submitted, "1 change · 0 runs") and the
  page scrolls.
- **States:** loading, error ("Retry"), empty ("No applications submitted.",
  with where they come from: applicants on the Project page, the baseline
  published in Runs & results) and a filter with none ("Nothing is awaiting a
  decision." and **Show all**).

In the Scenarios tab an
application shows an "Application" tag and "… application by <name>" in the
list; only its owner edits it, and an editor who isn't its owner gets the
**Decide** form (outcome radios, reasons and conditions, **Record the
decision**; final). Evidence packs (WP-3.14) will be linked from the list.

e2e: `e2e/tests/applications.spec.ts` (the applicant's flow to submission,
the assessor's decision, the empty list, axe in light and dark) and
`e2e/tests/applications-page.spec.ts` (the assessors' page: header, window
fit and a 30-application queue, the status filter's URL and Back, empty
states, a viewer, the phone cards, axe at desktop light and dark and phone).

## History (`?tab=history`)

WP-2.4 (`lib/components/history/`, a lazy tab; laid out for issue #17 option
A). A timeline of model and settings revisions and audit events, grouped by
the viewer's day, with a request's change set folded into one entry.

- **Section header:** the fact the page is opened for, the latest change of
  the whole history (whatever the filters), who made it and when, and since
  when changes are recorded: "Latest change today 14:05 by Ann: Model
  changed · recorded since 3 Sep 2026"; "No changes recorded yet · recorded
  since …" (`timeline.ts` `historyContext`). No actions of its own beside
  Add data and Run model.
- **The card** "Changes, newest first": a line on what it holds (and for
  editors "Restoring a version saves it as a new change: nothing is ever
  erased"), then the filters: **Hydrological unit** ("All hydrological units"), **Kind of change** and
  **Parameter** (typed words). Unit and kind are the server's filters and
  live in the URL (`&unit=<nodeId>`, `&kind=revision|series|run|…`), pushed,
  so Back steps back through them and a link keeps them; an unknown kind, or
  a unit not in the model, is no filter. The parameter words narrow what's
  loaded as you type, then go into the URL after a pause (`&q=`, replaced,
  not pushed), where the server keeps only revisions with a matching line on
  every page, so an old match isn't lost behind 50 newer changes (events are
  still filtered in the page). A field's history line links here with all
  three ([§ Field history](#field-history)).
- **Wide (the card's column from 840 px):** a list of compact rows beside the
  picked change. A row is a link: time and author, what it was (a revision's
  title, or an event's sentence), its first line with "+N more", and its
  reason, one line each. The pick is `&entry=<key>` (Back returns to the
  previous one; with none, or one no longer loaded, the newest shows,
  without writing the URL). The detail: a heading (the revision's title, or
  the kind of change: "Data series", "Members"), the day, time and author,
  **Newer** / **Older**, every line and the reason, the restore buttons, and
  for a revision **Differences from now**: the lines between the saved inputs
  now and that version, grouped by area (`GET …/history/revisions/:id`'s
  preview, cached per version until the list reloads), "what restoring it
  would change" for an editor. From 1100 × 620 the card fills the window
  (`.history.fit`) and the list and the detail scroll inside it; a linked
  entry further down is scrolled into view inside the list, never the page.
  **Show older changes** (50 items a page) sits at the foot of the list.
- **Narrow (a phone):** no detail; each entry shows whole under its day, with
  its buttons (44 px targets), and the page scrolls. The two selects share a
  row, the parameter box has its own.
- **Restore this version** (editors) opens a confirm that previews the diff,
  with an optional reason; restore buttons are disabled while there are
  unsaved model edits (a note says so), and a restored farm lists the
  farmers to re-link (a link to the Project page's Farmers list). After a
  restore the new entry (the restore itself) is picked, in place.
- Viewers read everything, the differences included, with no restore
  buttons; farmers never see the tab. Empty: "No changes recorded yet.
  History starts from {date}."; a filter with none: "Nothing matches these
  filters." `?tab=changes` is an old name for it.

- The **save bar** and the Settings save row have an optional "Reason for
  this change", kept with the revision.
- **Runs**: a collapsible "Changes since this run" and **Restore these
  inputs** (not for a scenario run).
- **Elsewhere** (issue #42): the compare page's *What changed* says who
  changed each model or settings line between two runs and when
  ([run-comparison.md](./run-comparison.md)), and the Project page lists
  the three newest changes (**Recent changes**, [§ Project](#project)).
- **Series values** aren't part of a version. A series change that kept
  the values it replaced (a replace, a person's merge, a delete, or a restore
  of them; `timeline.ts` `seriesRestore`) shows **Restore the earlier
  values** to editors, behind a confirm (`POST …/series/:id/revisions/:rev/restore`).
  The values it replaces are kept in turn, so it can be undone the same way.
  A feed's or an API key's merge keeps none, so it has no button. A series
  keeps its newest 5 earlier versions for up to 180 days; an older one
  answers "Those values are no longer kept". Afterwards the page reloads the
  series list. e2e: `e2e/tests/history.spec.ts`.
- **Field history** on the inputs themselves: [§ Field history](#field-history).

### Field history

WP-2.4 UI (`history/FieldHistoryLine.svelte`, `fieldLine.ts`,
`fieldHistory.svelte.ts`). A quiet line under a model input, "Changed 3× ·
last by Ann, 12 Aug 2026: 40% → 60%", that links to History filtered to that
field (`?tab=history&kind=revision&unit=<unit>&q=<words>`, the unit only for a
unit's own fields). A field never changed since it was set shows nothing.

- **Where:** the node sheet's numeric fields and **Drains into**, the farm
  drawer's planted area per crop (under the crop's name), and Settings &
  calibration's scalar parameters (effective rainfall, soil-water store, dam
  evaporation factor, days in February, catchment area, GR4J X1–X4 and
  warm-up, the rain threshold, the flow-share method, the annual assurance
  threshold, the data-quality thresholds). Monthly tables and rule editors
  have none.
- **Data:** one `GET …/history/fields` for the whole project
  ([api.md § Field history](./api.md#field-history)), fetched only when the
  first line renders (opening a node sheet, the drawer or Settings), never at
  first paint, and again after a model save, a settings save or a restore.
  The page shares it through context and sets it only for members whose tabs
  include History (not farmers or applicants), so no one else fetches or sees
  it. A failed fetch leaves the lines hidden; the fields work as before.

e2e: `e2e/tests/history.spec.ts` (the restore flows, a viewer, a field's line
after two saves and its link) and `e2e/tests/history-page.spec.ts` (the page: header line, window fit and a
44-entry history over eleven days from `e2e/support/history.ts` and
`spreadHistoryOverDays`, the pick's URL, Back, reload, Newer/Older and a
deep link, the filters' URL and Back, pagination, a restore picking itself,
empty states, a viewer, the phone layout, `?tab=changes`, axe at desktop
light and dark and phone).

## Notes

WP-2.7 (`lib/components/notes/`; [api.md § Notes](./api.md#notes)). Knowledge
that lives in people's heads ("dam raised in 2019 per owner", "logger moved in
March") is kept against what it is about.

- **Where.** A notes button with a count badge opens the notes on one target
  in a side sheet down the right, full width on a phone (`NotesDrawer.svelte`
  around `NotesList.svelte` with `formFirst`): the add form on top, the notes
  newest first under it, scrolling inside the sheet, and **Close** pinned at
  the foot, so thirty notes push neither the form nor Close off the screen
  (`notes.spec.ts` checks 30). It is not in the URL: it opens from inside
  other overlays (the Node table's grid modal) and from several places that
  can show the same target at once (a node's card and its grid row), so a
  param would open two. Opened from:
  - on each **Network** node row, beside its name (icon and number; only on a
    node the server has, not one added since the last save:
    `ModelEditor.savedNodeIds`);
  - in a run's **Record** group, under the run's own written explanation
    (the run notes stay the modeller's one explanation; these are comments
    from anyone on the team);
  - in the head of each **Settings** group (Demand, Flow calibration, Rain
    gaps, Calibration record, Flow share, EWR, Simulation period, Data
    quality), keyed by group (`SETTING_NOTE_GROUPS` in `notes.ts`);
  - on the **Summary**: *Recent notes*, the newest 8 across the project,
    each naming and linking to its target, and the project-level notes
    button.
  One `GET /notes/counts` per project feeds every badge
  (`counts.svelte.ts`), refreshed after any change. Only the open project's
  counts are kept: opening another project drops them (coming back loads
  them again), and signing out forgets them.
- **Writing.** Every member can add a note; the author edits theirs (marked
  *edited*); the author or an editor deletes (a confirm, then a soft delete:
  hidden from everyone, kept for the audit trail). On a farm, *Also show to
  this farm's farmers* makes a note farm-visible, marked *Shown to its farmers*;
  everything else is read by the project team only.
- **Farmer view.** *Notes about your hydrological unit* (`farm/FarmNotes.svelte`) lists
  the farmer's own notes and the WUA's farm-visible ones on that farm, and
  adds a note, always shown to the farm. The WUA previewing the page sees the
  same farm-visible notes, read only. It is the same `NotesList`, given the
  catalogue's words (`words` prop, `farm/notesWords.ts`; server errors
  through `errorText`), so the farmer's copy is translated while the
  workspace's stays English and never loads the catalogue.
- **Plain text only.** The body is rendered with Svelte's escaping, never
  `{@html}` or markdown; line breaks are kept with `white-space: pre-line`
  (the e2e test pins markup showing as typed).

## Report

`/projects/:id/report?run=<runId>` (`routes/projects/[id]/report/+page.svelte`,
WP-2.15 Phase A, issue #19): a meeting-ready catchment report of one run, for
anyone who can view the project. Without `?run=` it reports the latest run. It
uses only existing API routes (the project, the run with its settings and model
snapshot, the series list, four catchment series) and is its own lazy route
chunk. A non-member gets the workspace's "This project doesn't exist or you
don't have access to it"; a project with no runs, or a run that no longer
exists, says so with a link to Runs & results.

- **Impact report** (`&against=<projectId>:<runId>`, Compare runs' **Export
  impact report**, issue #17 A4): the same report with the cover's eyebrow
  reading *Impact report* and a first section, **Impact against the
  baseline** (`report/ImpactSection.svelte`, its own chunk, loaded before
  `data-report-ready` only for an impact report), from `GET /compare/runs`
  with the baseline as A and this run as B: a line naming the baseline
  (label, project, period, when it ran), the outcomes table of Compare runs
  for this run (Outcome, Baseline, This run, Change, from the same
  `compare/summary.ts` rows, dam storage included), the takeaways ("In
  short", naming the run by its label in quotes) and the input changes
  (`ChangesList`). A baseline that can't be read (deleted, or its project
  not shared) leaves the report loading, with the reason in that section.
  The bar's back link reads **← Back to the comparison** (the Compare runs
  tab on this pair). **Generate PDF** / **Email me the PDF** make the
  server-side PDF of the impact report itself: the request carries the
  baseline (`against`, 082), and the renderer opens this route with it. A
  baseline that can't be read has no server PDF (the API would refuse it);
  **Download PDF** (the browser's print) stays.
- **Sections**, in order, from `report/sections.ts` (data-driven, so the
  licensing evidence pack, #15, can add its own): the cover (project, run,
  period, when and by whom it was made, engine version, evidence badge, a
  legacy-model warning for a stored run from before engine 1.0.0, the run's
  summary sentence, for a forecast run (WP-2.12) the engine's
  `FORECAST_RAIN_NOTE` line, "From <first forecast day>, this run uses
  forecast rain, not recorded rain. …", as a warning (`report/sections.ts`
  `forecastNote`); it names "(CHIRPS-GEFS, Climate Hazards Center,
  doi:10.15780/G2PH2M)" only when the run's `forecastRainSource` is
  `chirps_gefs` (a CHIRPS-GEFS feed wrote every forecast day), never for an
  uploaded forecast; a **Read this first** box above the summary sentence
  (`report/sections.ts` `readFirst`, the engine's `REPORT_READ_FIRST`): the
  disclaimer's key points with the Disclaimer's section number, then who
  signed the run, "Signed off by <name> (<body> <number>)", or "Not signed
  off by a registered professional."; an unsigned run nominated as evidence,
  or any unsigned impact report, adds **Not signed off: not for use as
  evidence in a licence application.** in bold; then the contents), then numbered
  sections: **Network** (the schematic of the run's own model, farms
  coloured by supply; the screen scrolls the usual drawing, paper prints the
  wrapped one, in page-high bands when it is taller than a page;
  `report-schematic-print.spec.ts` measures its names in the PDF with
  `pdftotext -bbox`, and checks a 25-gauge main stem prints every name whole
  on one page, none across a page edge), **Inputs** (the run's settings, monthly A-pan, pan
  coefficient and pragmatic EWR, nodes, crops and planted areas, transfers, and
  each input series' dates and days inside the run; `report/inputs.ts`.
  The **Runoff model** row reads "GR4J", or for a run whose settings don't
  name GR4J (a stored run from before engine 1.0.0) "Legacy (b023 workbook,
  removed in engine 1.0.0): workbook comparison only", never today's default.
  A GR4J run adds a **GR4J potential evaporation** row, "pan coefficient ×
  A-pan" or the monthly total and source, engine ≥ 0.31.0; under a monthly
  PE the monthly table shows **GR4J monthly PE (mm)** in place of the pan
  coefficient),
  **Calibration** (the calibration panel with the annual water balance, where
  the parameters came from, the hydrograph over the whole run, and the
  flow-duration percentiles Q10–Q95 in m³/s on the days the Runs tab's FDC
  chart ranks by default, `report/fdc.ts`, issue #45),
  **Shortfalls and curtailment**, **EWR compliance** (EWR vs outflow, Reserve
  compliance for every rule-table site with Month by month open, the EWR grid
  for the outlet and every farm), **Hydrological units, warnings and checks** (the run
  summary: warnings, headline cards, the farm table; the self-checks and the
  water balance by water year, without Trace a day) and **Notes** (the run's
  notes, when it has any). A section appears only when the run has its data;
  nothing is printed as a placeholder. Every report then closes with three
  sections (WP-3.13, `components/liability/`):
  - **Validation statement** (`ValidationStatement.svelte`, the engine's
    `validationStatement`, [model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)):
    engine version, the build's invariant and soak results (*Not recorded
    for this build* until CI injects them), the run's self-checks, the
    runoff coefficient (flagged above 1, audit W1), a legacy-model warning
    ("Legacy runoff model (b023 workbook, removed in engine 1.0.0): …"),
    NSE / PBIAS / KGE / log-NSE with Moriasi ratings and the monthly-flows
    caveat, the flagged data-quality years and checks, and the **known
    limitations** table (ID, limitation, where it stands) generated from
    engine-audit.md. The same component is on screen, folded shut, in a
    run's Record group and under a scenario's comparison (`ValidationPanel`).
  - **Professional sign-off** (`SignoffSection.svelte`): each sign-off
    (signer, date, the self-declared registration as "Pr.Sci.Nat.
    (Professional Natural Scientist), SACNASP, Water Resources Science, no.
    400123/15", then **Check it**: the body's public register with its
    address written out, since reports are printed, then the scope it
    limits; an older sign-off prints its free-text body and number with
    "(category and field not recorded)"; the statement version
    and a 12-digit prefix of its SHA-256 with the full hash as the title,
    the disclaimer version), or **Not signed off.** in bold; then the ten
    statements a signer of the current version confirms (`signoff-3`). When
    a listed sign-off was made under an earlier version, a line says it
    confirmed that version's wording, recorded by its hash, not the
    statements below. An editor or owner gets **Sign off this
    run…** (screen only); a legacy run (from before engine 1.0.0) says why it
    can't be signed; a viewer
    sees neither. Loaded with the report (`GET …/signoffs`), so
    `data-report-ready` waits for it and the server-side PDF prints it.
  - **Disclaimer** (`Disclaimer.svelte`, engine `DISCLAIMER`): its five
    paragraphs and its version (`2026-09-28.2`, agreed: accepted by the
    operator after a pre-counsel review). Paragraph 5 ends with the Terms of
    use URL in full, on the site's own address (`withSite`, the page's
    origin). While the engine marks a wording
    `draft`, a bold *Draft wording, pending the client's legal review
    (decision D10)* line stands above it.

  Not yet: the published-by line and restriction notice (WP-2.3), changes
  since the previous publication (WP-2.4).
- **Sign-off dialog** (`SignoffDialog.svelte`, its own chunk, loaded when
  opened): full name, the registration as three selects (body, SACNASP by
  default or ECSA; category; SACNASP's field of practice or ECSA's
  discipline, whose list follows the body, and choosing another body clears
  both; engine `liability/registration.ts`), registration number (its
  placeholder an example of the body's format) and what the sign-off covers
  come first, since the first statement is about "the person named above".
  Candidate, certificated and specified categories are listed but disabled,
  with a note that their supervising professional signs; Pr Techni Eng, Pr
  Cert Eng and any field but Water Resources Science (SACNASP) or Civil and
  Agricultural (ECSA) show an inline warning and may still sign
  (`signoffForm.ts` `registrationAdvice`). Then the ten statements, each ticked on
  its own (who signs and their registration, competence, conflicts of
  interest, input data, calibration, EWR tables, works, assurance levels,
  plausibility, limitations); the known
  limitations in a focusable scroll box (keyboard-scrollable, a labelled
  region) that must be scrolled to its end (a list too short to scroll counts
  as read), with a polite live line saying whether the end was reached; the
  notes (registration details are the signer's own declaration, with where
  to check them on the ECSA and SACNASP registers; dam safety under NWA
  Chapter 12 and DW793 isn't covered; no finding on lawfulness; the
  signature relies on the app's calculations and doesn't verify its
  software; this run only). **Sign off** stays
  disabled, described by the list of what's missing, until everything is
  done (`signoffForm.ts` `signoffBlockers`). It sends back the statement's
  hash; a `409` (the statement changed) shows the error and reloads the
  statement, which clears the ticks and the read state. The Runs tab tags a
  signed run **Signed off**, and the History tab reads "Signed off a run as
  …, Pr.Sci.Nat. (Professional Natural Scientist), SACNASP, …" (an older
  event: "… (SACNASP …)").
- **Components reused, in print modes.** `LineChart`'s `print` prop draws a
  fixed `printWidth` × `height` box at 2 device pixels per CSS pixel
  (`printScale`: uPlot has no pixel-ratio option, so on a 1× screen the plot
  is laid out twice as large and scaled back into the box), with no cursor,
  zoom or controls, the whole period and a plain legend. `EwrHeatmap`'s `site`
  and `print` show one site, named in the heading, without the pickers or the
  keyboard read-out; `EwrAssurancePanel`'s `print` opens Month by month (the
  report renders one panel per site); `SelfChecksPanel`'s `trace={false}`
  leaves Trace a day out.
- **Ready.** Each chart sets `data-ready="true"` on its figure once it has
  drawn (or has nothing to draw), and the page's `<main>` gets
  `data-report-ready` once every fetch is in (including the summary's lazy
  human-impact tables) and every chart has drawn (`isReportReady`). Until then
  the bar says "Preparing the report…" and **Download PDF** is disabled. The
  signal is what e2e waits on, and what the server-side render waits on.
- **Download PDF** calls `window.print()`; the hint says to choose **Save as
  PDF**. Print CSS: A4 (`@page`, added while the page is open), a page break
  before each section, headings kept with what follows, rows and figures not
  split, tables printed whole with their header row repeated, wide tables
  tightened to fit the page width, background colours kept (the heat map,
  flagged rows), and no app sidebar, phone bar, banner or on-screen bar
  (the frame hides its own sidebar and phone bar in print,
  `layout/AppShell.svelte`: A4 is narrower than 900 px, so the phone bar
  used to print on the cover, and whichever frame was drawn when the print
  began changed the whole PDF: with the phone bar the type printed at ~80 %
  of its size, with the sidebar's grid column 22 pages became 37). On screen only (`@media screen`), row headers get 11rem, so the
  curtailment table's unit names and verdicts aren't a word a line; paper
  keeps the tightened print fit.
- **Themes.** On screen the report follows the light or dark theme. A print
  is always light: on `beforeprint` the page and each print-mode chart set
  `data-theme="light"` on `<html>` (`report/printTheme.ts`, idempotent) and
  the charts redraw synchronously, so the canvas is light before the page is
  laid out; `afterprint` puts the previous theme back.
- **Generate PDF / Email me the PDF** (WP-2.15 Phase B, issue #26;
  `lib/components/report/ServerPdf.svelte`, in the report's chunk)
  sit beside Download PDF for any viewer. They queue a server-side render of
  the shown run: the background worker opens this same page in headless
  Chromium and prints it to A4 with `page.pdf()`, so the PDF is the same
  pages this page prints ([architecture.md § Server-side reports](./architecture.md#server-side-reports)),
  plus a running footer on every page: the page's `data-report-footer`
  (the engine's `REPORT_FOOTER`: project · run · "Model estimates; see the
  Disclaimer (section N, version …). The operator of this software accepts
  no responsibility to anyone who relies on this report.") and "Page X of
  Y" (`reports/render.ts` `footerTemplate`). The browser's own print
  (Download PDF) has no running footer.
  The bar then follows the job's status (`role="status"`: "PDF queued: waiting
  for the background worker…", "Making the PDF…", "The first try failed (…);
  trying again shortly…", "PDF ready (9 pages). The link is on its way by
  email.", or "The PDF could not be made: …"), polling the API every 1.5 s
  until it settles, and offers **Download the generated PDF** (a link valid
  for an hour). The wrapper carries `data-state` (`idle`, `starting`,
  `queued`, `rendering`, `retrying`, `done`, `failed`). Locally the worker
  must be running (`pnpm dev:full`, or `pnpm dev:jobs:tick` once).
- **The emailed link** opens `/projects/:id/reports/:jobId`
  (`routes/projects/[id]/reports/[jobId]/+page.svelte`, its own lazy route):
  signed out, the reader signs in first and comes back. A member sees the
  title, *Catchment report PDF*, with a context line naming the catchment and
  the run ("Upper catchment · Run “Baseline”", read from the project and
  its runs list, best effort), then one card: the state as a pill in words
  (Queued, Making, Retrying, Ready, Failed) beside the status line, when it
  was asked for (and "This page checks again every few seconds." while it's
  pending, polling every 2 s), **Download the PDF** once ready (a fresh
  one-hour link each visit), after a failure a line pointing back to the
  report, and **Open the report in the app** and **Go to the run** (**Go to
  Runs & results** for a scheduled PDF of the latest run). The card's
  `data-state` is the report's state. Anyone else, or a PDF past its 7
  days, gets "This report doesn't exist any more, or you don't have access to
  its project." Tested by `e2e/tests/server-report.spec.ts` and
  `e2e/tests/report-pages.spec.ts` (queued and failed states planted with
  `support/db.ts` `holdReportJob` / `failReport`, a viewer, not found, axe in
  both themes at desktop and phone).

## Help (`/help`)

Every help page shares one shell (`routes/help/+layout.svelte`): the search
box heads the page, above the text, and a contents list
(`help/HelpNav.svelte`: the overview, every guide by group, *Start here*,
*How it works*, *How to*, and the glossary) marks the page you're on
(`aria-current`). From 900 px the contents are a 13rem column in the page,
against the app sidebar, beside the text, sticky while you read, scrolling on their own only when
taller than the window (a short window, or the glossary's term list). The column fits the window exactly
(the page's top gutter above it and below it), and the reading space at the end of a long page belongs
to the text column, so a page that fits the window (search with nothing typed, no matches, an unknown
guide) doesn't scroll. They
don't go in the app sidebar's slot ([§ App shell](#app-shell-and-account-menu)):
a long list there made the sidebar scroll. On phones the contents fold behind a **Help contents** button
under the search box, and close again when you pick a page.

Each subpage (a guide, the glossary, search) heads its text the same way: a
breadcrumb (`help/HelpCrumbs.svelte`: *Help › How to › Add a transfer*,
*Help › Reference › Glossary*, *Help › Search*) over one `h1` of the
overview's size, at the same height on every page (`e2e/tests/help-pages.spec.ts`).

- **Pictures.** One Blender scene of an invented catchment, rendered as several
  shots (`lib/help/pictures.ts`): the whole catchment, one farm and its dam, the
  outlet weir, the soil layers on the block's cut face, the transfer pipeline
  and a reach of river, plus help-tip close-ups of the dam's stored water, the
  stream and slopes flowing into it, the wall and the stream below it, the
  irrigation line, the orchard and the gauging hut. `pnpm gen:help-art` (`bin/gen-help-art.sh`, scene in
  `scripts/help-art/catchment.py`) renders every shot at its full and half
  width to `static/help/<shot>-<w>.webp`, and projects each labelled feature
  through that shot's camera into `lib/help/pictures.json`, so a marker always
  sits on its feature. The output is committed; re-run it (needs Blender 5,
  ImageMagick 7 and python3) only after changing the scene, or pass
  `HELP_ART_ONLY=farm,soil` to re-render some shots.
- **Picture tours** (`help/PictureTour.svelte`): a shot with numbered markers
  and, under it, the numbered list of stops, which is the full text. The
  markers are a pointer shortcut (out of the tab order and hidden from screen
  readers, since the list says the same); clicking one lights its stop, and
  hovering or focusing a stop lights its marker. A stop with more to say has
  **Show more** (`aria-expanded`), which opens it in place across the full
  width: key points beside a close-up shot, or a diagram.
- **Overview** (`/help`): the catchment tour (eight stops from rain to the
  outlet, `lib/help/tour.ts`, every stop opens), the setup path (one step per
  setup tab, `SETUP_STEPS` over `SETUP_TABS` in `lib/help/guides.ts`, in the
  order of the workspace's *Build the model* section, which `tour.test.ts`
  guards) and the model guides. Help names tabs with `TAB_TITLES`, picked from
  the workspace's own `TAB_LABELS`, so a renamed tab can't leave help behind.
  *The whole process* has a **Getting around a project** section (the three
  sections, the Project and Dams pages, where the sections sit in the app
  sidebar under the catchment's name, Projects / Teams / Help at its top, the
  Data badge, the phone bar's Menu and the phone Sections button, the section
  header and each page's actions in it, the notice line, the Grids menu's grid
  modal and the node and crop sheets, and every way into the farm drawer),
  and *Compare runs and try what-ifs* points at the Compare runs tab.
  An old `/help#<term>` link goes on to `/help/glossary#<term>`.
- **Guides** (`/help/guides/<id>`, content in `lib/help/guides.ts`): one task
  or one idea each, with an "On this page" list (a box under the intro; when
  the Help text column is at least 56rem wide, a container query on
  `help-main`, a sticky rail right of the 42rem article instead, so the
  article keeps its reading width and the right-hand space is used). The list
  marks the section being read (`aria-current="location"`, in bold; the last
  heading past a line near the top, `lib/help/spy.ts`, or the last section at
  the end of the page; nothing while the intro shows), and a link to one
  section (`/help/guides/<id>#<section>`) lands on it and focuses its heading
  (`holdAnchor`). Numbered steps, tip and
  caution notes, formulas, diagrams, picture tours (a farm's day, GR4J's
  stores under the ground, the outlet gauge, the transfer, the EWR reach), the
  glossary terms it uses, related guides and previous / next. Guide text is
  plain strings with a small markup (`**UI label**`, `[[glossary-id]]`,
  `[[guide:id|label]]`) rendered by `help/RichText.svelte` via `inline()`, so
  nothing is rendered as HTML; a term link reads in lower case mid-sentence
  unless it is an acronym or name (`inSentence`), and `guides.test.ts` fails
  on a reference that doesn't resolve or a picture stop its shot doesn't have.
- **Diagrams** are inline SVG components in `lib/components/help/diagrams/`,
  wrapped by `help/Diagram.svelte`, which holds the only styles they use (the
  app's colour tokens, so they follow the light and dark themes). Each SVG is
  `role="img"` with a full text description, plus a visible caption. A
  drawing is never drawn so small that its smallest text is under 9.5 px
  (`Diagram` sizes its `min-width` from the SVG's viewBox and smallest font
  once it is on the page); narrower than that it scrolls sideways (a
  `data-scroll-region`): on a phone, and at 1440 for the five diagrams wider
  than 660 units (the model pipeline shrank its notes to 7 px there). A label
  on the figure's ground beside a wire (not in a box) is `.lbl`: a halo in
  `--surface`. A diagram carries no colours or `<style>` of its own,
  and marker ids are unique across diagrams (both guarded by
  `guides.test.ts`).
- **Help tips** (ⓘ) for terms that map to a part of the scene (`TIP_PICTURES`
  in `lib/help/pictures.ts`: a shot and the spot of the term's own feature)
  show that close-up above the text with a white ring on the feature, so
  neighbouring tips (capacity, inflow, spill, irrigation…) don't repeat one
  picture. No two tips share a shot *and* ring, and no shot serves more than
  eight tips (`tour.test.ts`). The picture is decorative
  (`alt=""`), since the bubble is a live region and its text says what the
  picture shows, and it has a fixed size so the bubble is placed correctly
  before it loads.
- **Glossary** (`/help/glossary`): every entry (`lib/help/content.ts` joins
  `tips.ts`, `articles.ts` and `farmer.ts`), grouped by topic, with a stable anchor per term (`/help/glossary#<id>`) that
  the ⓘ help tips link to. Its scroll spy (`lib/help/nav.svelte.ts`) tells the
  contents which topic and term are on screen; the contents list the current
  topic's terms and keep the current one in view inside their column. The
  legacy runoff model's six terms (peak coefficient, season factors, summer
  months, winter thresholds, recession curve, pulse index) became one
  **Legacy runoff model** entry (`legacy-runoff-model`) when engine 1.0.0
  removed the model; it still explains a stored legacy run's daily columns.
- **Search** (`/help/search?q=`): results update as you type in the box at
  the head of the page, which keeps focus; guides first, then glossary terms,
  each a list in columns (the overview's guide list: three across at 1440, so
  a common word's ~50 terms start on the first screen), one column on a phone.
  When both kinds match, **Guides (n)** and **Glossary terms (n)** under the
  count jump to each list.

## Farmer view (`/farm`)

The phone-first view for a farmer (WP-2.6); the design is
[design/farmer-view.md](./design/farmer-view.md) and its prototype boards.
It renders a `FarmView` (`packages/engine/src/views/farmView.ts`) from
`GET /projects/:id/farm/:nodeId`, the current publication projected for one
farm; `GET /projects/:id/farm` lists the farms and says whether anything is
published.

- **Routes.** `/farm` lists every farm linked to the user across projects
  (notice level, received %, dam %, or "Not published yet"), and goes
  straight to the only one. `/farm/[projectId]` is one farm (`?node=` and a
  switcher when the farmer has several there: a row of links above the name
  for up to 4 farms; past that, folded under "Your hydrological units in this catchment
  (N farms)", so the name and the WUA's notice stay on the first screen,
  which matters for WUA staff previewing, who see every farm), with `/why` ("Why about
  83 %?", three numbered steps) and `/dam`. `/farm/words` shows the help
  entries in the `farmer` category ("What do these words mean?"; since
  issue #47 one of them is *WUA (Water User Association)*, which says some
  areas still have an irrigation board). The root
  page sends a user whose every membership is `farmer` to `/farm`; the
  workspace (`/projects/[id]`) answers a farmer 403 and redirects them to
  `/farm/[id]`.
- **Frame.** The farm pages have their own header ("My hydrological unit", the EN | AF
  language switch, Menu: your farms, the words, Account, the privacy notice, "Don't keep a copy
  on this phone", sign out); the app shell isn't shown ([§ Language](#language)).
  A user whose every membership is `farmer` gets the same frame on
  `/account` and `/account/alerts` (the farm view's "Choose your alert
  emails" link lands there): the header's **Your hydrological units** back link in
  place of "My hydrological unit", and the page keeps its own `main` and styles (the
  farm pages' card styles apply only inside the farm pages' own `main`).
  The root layout decides (`lib/auth/frame.ts` `isFarmerOnly`, from the
  membership list, read once per signed-in user on the first account page
  they open, the page waiting for it rather than flash the wrong frame;
  FarmShell is loaded as its own chunk then). If that list or the chunk
  fails, the workspace frame is the fallback. A farmer who is also a
  member of a catchment keeps the workspace frame. One 560 px column, a 16 px base, 44 px targets,
  nothing under 13 px, existing tokens only, light and dark. The header is
  sticky at every width, so while it's on the page it sets `--header-h` to
  its 56 px (the app shell's 0 from 900 px would leave in-page links, such
  as Why?'s "Read the notice" (`#notice`, landed once the farm has loaded)
  and the words page's `#farm-…` entries, under it). It stays one 56 px row
  down to 320 px in every language (the EN | AF pair doesn't wrap;
  `lang-layout.spec.ts`). The frame has no
  minimum height, so a page that fits doesn't scroll (the confirm-your-email
  banner sits above it).
- **Main page, top to bottom:** the name and the dates line ("Published by
  the WUA on …. Data up to …", amber with its age when stale); the WUA's
  notice first (warning or danger fill, icon and level in words), or "No
  restriction from the WUA", then the estimate line (below). The notice is in the language the reader
  chose (the WUA's own Afrikaans follows the switch at once, even while
  the page's words are still English, and carries `lang="af"`), else in
  English, else in the first other language the WUA wrote, with "The WUA
  wrote this notice in {language} only" under it (design §7). `{language}`
  is the language's name in the page's words' language from the browser's
  `Intl.DisplayNames` ("Engels" on an Afrikaans page), the table's own
  name when the browser has none, so a new language needs no message of
  its own. `FarmView` carries every language the WUA wrote (`notice`, by
  code), so a switch needs no request and the saved copy holds them all
  (the engine's `pickNotice`, through `farm/notice.ts`, shared with
  `/share` and the alert emails); water received this season with the ML/m³
  switch (saved to the account, `app_user.volume_unit`, and kept on the
  phone for the saved copy); the dam
  (hidden without one) with the days-left line, or the no-stop-level
  wording; "Looking back", the model's card (dashed, neutral "Model: …"
  chip, never the notice's fills), a single link line under a `restricted`
  notice; the last 12 months (inline SVG bars at the rendered width, a
  summary sentence and a full table behind "Show the numbers"); last
  season; the farm on the river (counts, the outlet's last 30 days, the
  privacy sentence and "Who can see my hydrological unit", which loads the people by name
  and role when first opened, `GET …/access`, and falls back to the roles
  alone if that fails); "Notes about your hydrological unit" ([§ Notes](#notes)); the
  CSV download. The CSV download fetches the file and puts the estimate
  line (`cards.ts` `disclaimer()`), in the page's language, as a leading
  `# ` line (`farm/csvNote.ts`); a failed download says why under the
  links. **Next 14 days** (WP-2.12, `farm/ForecastCard.svelte`,
  wording in `farm/forecastCard.ts`) comes after "Looking back" only when
  the WUA published a forecast run: a "Forecast" kicker and a dashed edge
  set it apart from the cards about what happened; "Lowest dam level
  expected: about 38 % around 20 Jan" (no dam, no line), "You may be short
  on 3 of the 14 days" (or that the model doesn't expect a short day), and
  the forecast's own dates with "Forecasts change, and this is worked out
  by the model, not a promise. Only a notice from your WUA or from DWS is a
  restriction." A forecast made more than 3 days ago says how old it is
  first. The dam page shows the same card under its chart. That chart
  (`farm/DamChart.svelte`, "Last 12 months") says what its line is under its
  heading ("Dam level at the end of each month", the numbers table's caption
  reused, so it needed no new translation), with % ticks, a month under each
  point, and a caption with the months it covers and what the dashed line is.
- **The estimate line** (`farm/EstimateNote.svelte`, `role="note"`): "These
  figures are worked out by a computer model of the catchment. They are
  estimates, not measurements or instructions, and they can be wrong. Only a
  notice from your WUA or from the Department of Water and Sanitation (DWS)
  is a restriction." (`cards.ts` `disclaimer()`, quoted in the legal review
  pack, issue #47). A callout at body size with an info icon, before the
  first figure on every farm page: on the main page right after the WUA's
  notice, in the offline view after the notice and before "At a glance", and
  on the dam and *Why?* pages after the header (`farm-view.spec.ts` pins the
  order). It used to sit at the foot of the main page only.
- **"Before you look at your farm"** (`farm/FarmNoticeGate.svelte`, words in
  `farm/farmNotice.ts`): until the signed-in account has pressed **I
  understand** on the version in force (`/auth/me` `farmNoticeCurrent`, the
  engine's `FARMER_NOTICE_VERSION`), every farm page and the `/farm` list
  show this notice in place of the figures: four points (model estimates,
  nobody measures the dam; they can be wrong, check before you act; only a
  WUA or DWS notice is a restriction; the operator doesn't check the WUA's
  figures and accepts no responsibility, with a link to the Terms of use,
  section 13). The press goes to `POST /auth/me/farm-notice` (stored on the
  account, 093) and the figures follow at once. Pressed without a signal
  (issue #74), the press is kept on the phone for that user and version
  (`farm/noticeAck.ts`, `wm.farm.notice-ack.v1`) and the figures (the saved
  copy) show; the page sends it when the signal is back (the `online` event,
  or the next load), and the account's time is the server's when it
  arrives. A refusal (the notice changed meanwhile, 409) drops it and the
  notice shows again; another account on the phone never inherits it. A
  new version shows it again. Not shown to WUA staff previewing a farm, nor while there is
  nothing published (the no-publication state has no figures). The words
  are bound to the version (`farmNotice.test.ts`) and quoted in
  `docs/legal/disclaimer-review.md` § 3.
- **Wording.** Every visible string comes from the message catalogue
  ([§ Language](#language)); the number rules and the sentences built from
  them live in pure modules under `lib/components/farm/` (`format.ts`,
  `cards.ts`, `why.ts`, `dam.ts`, `chart.ts`, `forecastCard.ts`), pinned to
  the prototype with a Vaalbank fixture (`fixture.ts`); a test keeps the
  design's "never says" words out.
- **States.** Skeleton cards with a hidden status and "Slow signal?" after
  3 s; no publication; an error with Try again (a contact line after the
  second failure, never raw error text); access removed (403/404), which
  also clears the saved copy. The contact lines ("Questions? Contact …",
  the removed and second-failure lines) name the WUA when the project has
  its name (`wuaName`, set on the Project page's details), else say "your
  WUA" (`contactText` in `farm/cards.ts`). "Compared with last season"
  without a year of figures says "Not available: the model's data starts
  on 1 Jun 2023." from the projection's `dataFrom` (a copy saved before it
  says only that the data doesn't reach back).
- **Saved copy** (`savedCopy.ts`, design §9): the last good `FarmView` per
  user and farm in `localStorage`, shown at once with "Updating…". Without a
  signal it stays under a dark strip ("No signal. These are the figures
  saved on this phone at …") over a reduced view; its **Try again** button's
  focus ring takes the strip's own text colour (16:1 in both themes; the
  page's `--focus` was 1.67:1 on the swapped dark strip). Cleared on sign-out, on a
  403/404, when another user signs in, after 30 days unused, and by the
  Menu's opt-out. No service worker, no polling: the page refetches when it
  becomes visible again. Ages on it (the dates line, the forecast's) count
  to today where the catchment is (`farmToday`: the project's zone from the
  response, on this device's clock), never the phone's own zone, so a saved
  copy ages with the day and a phone set to another zone agrees with the
  server (issue #51).
- **Preview.** Viewer+ can open a farm's page ("Preview as farmer" in the
  Network tab's node detail); it shows under a "You're previewing … as its
  farmer sees it" banner and keeps no copy.

## Language

English and Afrikaans for everything a farmer touches (WP-2.5): the farm
view (`/farm/**`), the sign-in pages (`/login`, `/register`,
`/forgot-password`, `/reset-password`, `/verify-email`), the "confirm your
email" banner, the account page and its alert emails page
(`/account/alerts`), the unsubscribe page (`/alerts/unsubscribe`), the
public shared view (`/share`), the public landing page (`/` signed out,
`/welcome`, [§ Landing page](#landing-page)), and the emails a farmer receives (confirm
address, reset password, the farmer invite, the alert emails and their
digest). The modeller workspace stays English.

- **The language table.** Every language the site, the emails and the
  database know is one entry in `packages/engine/src/languages.ts`
  (`LANGUAGES`: code, own name, Intl locale, decimal mark; issue #58). The
  switch, browser detection, number and date formatting, plural rules, API
  validation, the invite dialog, the CSV language column and the database's
  `language` table ([data-model.md § Languages](./data-model.md#languages-080_languagesql))
  all read it; nothing else lists the languages. Frontend and backend import
  it from `@water-management/engine/languages`.
- **Switch.** `lib/i18n/LanguageSwitch.svelte`, drawn from the table. With
  two languages it is "English | Afrikaans" (each name in its own language,
  the button marked with that `lang`, `aria-pressed` on the current one;
  "EN | AF" in the phone headers, the full name as the accessible name, and
  that compact pair never wraps, so a 320 px header stays one row; below
  360 px the farm header shows its mark, or a back link's chevron, without
  the words "My hydrological unit", which stay for screen readers, since
  beside EN | AF and Menu they took three lines, `FarmShell.svelte`);
  from three it becomes a `<select>` named "Language", each `<option>` in
  its own language with its own `lang` (`LanguageSwitch.test.ts`,
  `testLanguage.test.ts`). It sits above the sign-in forms (`AuthCard`), in the farm
  pages' and the `/share` page's header, and under **Language and units** on the account page, which
  also sets the farm view's volume unit (m³ or ML). There it is `segmented`:
  the two buttons joined into one control sized like the form fields
  (36 px with a mouse, 44 px on touch and phones).
- **Which language.** The account's `locale` when signed in and chosen, else
  this device's choice (`localStorage` `wm.locale`, try/catch), else the
  first language in the browser's list (`navigator.languages`) that the
  table has, by primary tag (`["de-DE", "af"]` gives Afrikaans,
  `["en-ZA", "af"]` English), else English (`resolveLocale` through the
  engine's `matchLocale`, run by the root layout whenever the session
  changes).
  Choosing applies at once, is kept on the device and, signed in, saved with
  `PATCH /auth/me { locale }` ([api.md § Auth](./api.md#auth)). Signing up
  sends the page's language as the account's; an account created from an
  invite takes the invite's (`invite.locale`, 050).
- **Messages are their English** (gettext style, issue #9). The English is
  written where it is used, `t('Your dam')`, and is the message: no English
  catalogue ships. A message kept in a table or a variable is marked with
  `msg('…')` (`lib/i18n/msg.ts`, which imports nothing, so catalogue-free
  modules such as `emailAuth.ts` and `farm/notice.ts` can use it), and a
  counted word is `plural({ one: 'day', other: 'days' })` (the farm view's
  `DAYS`, `WEEKS`, `POINTS`, `FARMS` in `farm/format.ts`, `ORDINAL` in
  `farm/chart.ts`). `t()` takes a string literal or a `msg()`, never an
  arbitrary string (a type error), so the sheet's extractor can read every
  message. When the same English means two different things, the call gives
  a context, `t('Create account', {}, 'page title')`, and the two translate
  separately. A message's **id** is an 8-hex FNV-1a hash of its English (and
  context; `messageId` / `pluralId`), computed only when a translation is
  looked up (English pages never hash). `messages/af.ts` holds only
  **reviewed** Afrikaans, by id, with the English in a comment; it is loaded
  lazily, the first time someone picks Afrikaans. A message without
  Afrikaans shows in English. Hash ids rather than the English as the key:
  af.ts ships only translated entries, and 8 characters an entry is a
  fraction of the English (~40 on average); both are equally robust to an
  English edit, which changes the id, so the old translation is **stale**,
  never shown for the new words (below).
- **Which messages exist.** `scripts/guards/i18n_extract.mjs` reads them
  from the frontend's source: every `t()` / `tRich()` / `msg()` / `plural()`
  / `tn({…})` call in a file that imports the message code, each branch of a
  `?:` chain, the script and the `{…}` expressions of a component (not its
  text or comments). Each message sits in a sheet **section** set by a marker
  comment before it (`// i18n-section: farm.dam`, `<!-- i18n-section: account
  -->` in a component's markup), which holds until the next; one used in two
  sections goes to `common`. The sections' descriptions and per-message notes
  for the translator (keyed by English) are in `lib/i18n/sheet.ts`, never
  shipped. `pnpm gen:i18n:sheet` also writes every id to
  `messages/ids.generated.ts`; the build keeps only their count (a catalogue
  is complete when it has as many entries, since the tests keep af.ts free
  of stale ids), while dev and the tests use the list: under vitest a
  message that isn't on the sheet throws (a table without `msg()`, say), in
  the dev server it warns.
- **Loading.** Only the translated routes load the catalogue: they import
  it themselves, and the root layout imports `lib/i18n/locale.svelte` with a
  dynamic `import()` on the first translated route, then renders the route
  once the language is set (a readiness flag, with Try again if the chunk
  fails), so no route shows one language and then another. The workspace
  never downloads it: the number, date, notice and chart-size
  rules it shares with the farm view live in catalogue-free modules
  (`lib/i18n/state.svelte.ts`, `farm/numbers.ts`, `farm/notice.ts`,
  `farm/chartGeometry.ts`), `passwordProblem` returns a `msg()`, the notes list
  takes the farm card's words as a prop (`notes/words.ts`: `NOTES_EN` for
  the workspace, `farm/notesWords.ts` from the catalogue), and the
  "confirm your email" banner is imported only for an unconfirmed address.
  `/share` loads the catalogue but none of the workspace's code: it imports
  only its own modules, the farm view's shared ones and the i18n
  (`lib/i18n/boundary.test.ts` guards both).
- **Server errors.** The translated pages never show the API's English
  `error` text. The API sends a stable `code` with every error a farmer can
  meet (and `params`, e.g. the lockout's seconds; [api.md §
  Errors](./api.md#errors)); `lib/i18n/apiError.ts` `errorText` words it
  from its `CODES` table (a `msg()` per code; `apiError.test.ts` fails on a
  code of `ERROR_CODES` without one), or by status when there is no code
  (no signal, a server problem, a refusal). Stable codes rather than the
  server localising by `app_user.locale` / `Accept-Language`: every word a
  farmer reads stays in one catalogue and on the translation sheet, a
  signed-out page needs no language sent to the server, and the API keeps
  one language for integrators and logs.
  `lib/i18n/boundary.test.ts` guards it.
- **API** (`lib/i18n/locale.svelte.ts`): `t(english, vars, context?)` fills
  `{name}`; `tn(forms, n, vars, ordinal?)` picks the `one` / `other` (or
  ordinal `two` / `few`) form through `Intl.PluralRules`, a translated form
  missing falling back to `other`; `tRich(english, vars, context?)`
  returns a `Rich` sentence where `**…**` and `{ b }` values are bold
  (`lib/i18n/Rich.svelte` renders it); `joinAnd(items)`; `setLocale(l)`;
  `i18n.locale` (the choice); `wordsLang()` (the language the words are in).
  `t()` and `tRich()` drop a full stop that comes straight after a value
  already ending in one, since af-ZA abbreviates months with a dot and a
  sentence ending on "31 Des." must not read "31 Des.." (issue #51).
  They read runes, so a template that calls them re-renders on a switch.
  The backend's emails keep a keyed catalogue, `backend/src/mail/i18n/`
  (`mailT(locale)` → `{ t, tn, lang }`; `tn(base, n, vars)` picks a counted
  message's form, keys `<base>.one` / `<base>.other` and whatever else the
  language's `Intl.PluralRules` needs, so no mail says "1 days late", issue
  #51): the server ships no bundle, so its keys
  cost nothing, and the sheet lists its rows by key beside the site's ids;
  the alert emails'
  words are there too (`mail.alert.*`, WP-2.13), and so are the dates in
  them, in the language the words came out in. The alert emails' liability
  lines (`mail.alert.model`, `mail.alert.model.dam.staff`, `mail.alert.model.staff`,
  `mail.alert.restriction.wua`, [§ Alerts](#alerts)) are quoted in the legal
  review pack; `mail/i18n/liability.test.ts` fails when the pack's quote
  differs.
- **`lang`.** `<html lang>` is `wordsLang()` on the translated routes and
  `en` elsewhere: it stays `en` until the Afrikaans catalogue is complete, so
  a page of mostly English words never claims to be Afrikaans. An email is
  `lang="af"` only when every word in it came from the Afrikaans catalogue.
  The prerendered `/welcome` ships `lang="en"` (`app.html`) because its
  prerendered words are English; `lang` follows the words once the page
  hydrates (a per-language prerender is in followups.md § Landing page).
  A glossary entry on `/farm/words` shown in the other language carries its
  own `lang`.
- **Layouts, once per language** (issue #58). Afrikaans runs 20–30 % longer
  than English, with long compound words, and every language has its own
  reflow risk. `e2e/tests/lang-layout.spec.ts` runs once for each
  non-English language in the table, opening every translated page at
  360 px (sign-in, register, forgot password, the farm view with its why
  and dam pages, `/farm/words`, the account and alert pages, `/share`) and
  checking that `<html lang>` is that language's code, nothing scrolls
  sideways, no text is cut off in its box, and axe finds nothing, in light
  and dark. Specs read a language's words from its catalogues
  (`e2e/support/lang.ts`: `words(lang)`, `mail(lang)`), so a corrected
  translation doesn't break them.
- **Numbers and dates** (D8). The farm view writes the chosen language's
  decimal mark (the table's `decimalMark`) at once: a comma in Afrikaans
  ("83,6 ML"), with the app's narrow no-break space between thousands in
  every language (§ Number style).
  Dates and plural rules follow the words' language, in the table's Intl
  locale (`en-ZA`, and `af-ZA` once the Afrikaans words are in), so an
  English sentence never carries Afrikaans month names. The emails date in
  the same locale (`mail/alerts.ts` `dateText`, the day without a leading
  zero), and a timestamp in them (a notice's publication) by its day in the
  project's time zone, never UTC's (issue #51).
- **Translation.** Every farmer-facing string has Afrikaans (2026-09-26,
  issue #49): 505 site messages, 70 email strings and the 8 farmer glossary
  entries (the ones that name a farm node re-translated 2026-09-28 for
  "hydrological unit", issue #90 Q6). It was written by the `i18n-translator` agent and reviewed by the
  `i18n-checker` agent (`.claude/agents/i18n/`, language-parameterised since
  issue #58 — the target language is the first line of the prompt, with a
  per-language reference file for register, spelling authority and
  terminology, `.claude/agents/i18n/languages/<code>.md`: meaning,
  placeholders, bold, plural forms, register, and one term for one English
  word across the whole set, with §5.1 of `docs/design/farmer-view.md` as
  Afrikaans's word list); no native speaker has reviewed the Afrikaans yet.
  The client's native-speaker translator will, before farmers are invited
  in Afrikaans (confirmed by the client, issue #90; docs/followups.md
  § Afrikaans). The wording goes to real farmers, so a
  new string in any language goes through the same two steps:
  `pnpm gen:i18n:export <lang> <dir>` writes what's still on that language's
  sheet as JSON batches, the translator agent fills them, the checker
  reviews the whole set, and `pnpm gen:i18n:apply <lang> <translations.json>
  <corrections.json>` (`scripts/guards/i18n_apply.mjs`) refuses a
  translation that drops or adds a placeholder or bold mark, or covers only
  part of a counted word or a glossary entry, then writes the rest into
  that language's three catalogues (creating one that doesn't exist yet
  from a small boilerplate header; a brand new email catalogue also gets
  its line added in `backend/src/mail/i18n/catalogues.ts`) and rewrites
  that language's sheet. `docs/i18n/<code>-translation-sheet.md` (one per
  language, generated by `pnpm gen:i18n:sheet`, default every non-English
  language in the table) lists every untranslated string with its English,
  context and placeholders, and an empty column for the client's
  translator; the farmer glossary entries (`lib/help/farmer.ts`) are on it
  too (`lib/help/content.<code>.ts`, stamped with a `sourceHash` of the
  English so a later English edit makes the translation stale). The sheet
  lists every English string once, by id (a counted word one row per form,
  `<id>.one` / `<id>.other`), in section order; the translator's return is
  applied by id. `catalogue.test.ts` (frontend and backend) and
  `content.af.test.ts` fail when an untranslated message is missing from
  the sheet; the frontend's also fails on a catalogue id that is no current
  message's (a **stale** translation: its English changed, and is back on
  the sheet under the new id, or it is gone), on a translation that drops a
  placeholder or a bold marker, and on a note or section nothing uses.
  `pnpm check:i18n` prints what has no words yet and lists any stale
  translation, for every language, and fails when a sheet or the id list is
  out of date, a message can't be read, or a translation is stale. A stale
  site translation is moved to the new id once the translator has checked
  it against the new English, or deleted. When the English of a translated
  glossary entry changes, the entry goes back on its sheet (marked "the
  English changed"); once the translator has re-checked it (and any fix is
  in `content.<code>.ts`), `pnpm gen:i18n:stamp <lang> <id>`
  (`scripts/guards/i18n_stamp.mjs`) writes the current English's hash into
  its `sourceHash` and rewrites the sheet. It never writes a translation: an
  id without one is refused.

### Adding a language

A language is one table entry, three catalogue files, one index line and a
translation run. No other code changes; `frontend/src/lib/i18n/testLanguage.test.ts`,
`backend/src/mail/i18n/testLanguage.test.ts`,
`backend/src/auth/testLanguage.db.test.ts` and the tooling's own
`scripts/guards/i18n_sheet.test.mjs` / `i18n_apply.test.mjs` (a throwaway
fixture repo, never the real one) prove it with a stand-in `xx` that exists
only in the tests.

1. **Table entry.** Add `{ code, name, intl, decimalMark }` to `LANGUAGES`
   in `packages/engine/src/languages.ts`: `code` the BCP 47 primary tag
   (2–3 lower-case letters), `name` in the language itself, `intl` the Intl
   locale South Africa writes it in (e.g. `zu-ZA`), `decimalMark` `.` or `,`.
   The next migration run adds the code to the `language` table (no
   migration file).
2. **Catalogues**, each found by its file name, so they need no other line:
   - site: `frontend/src/lib/i18n/messages/<code>.ts` exporting
     `const <code>: Catalogue` (loaded lazily on first use);
   - email: `backend/src/mail/i18n/<code>.ts` exporting `const <code>`,
     **plus its line** in `backend/src/mail/i18n/catalogues.ts` (a Lambda
     bundle can't find files by name);
   - glossary: `frontend/src/lib/help/content.<code>.ts` exporting
     `const HELP_<CODE>` (loaded lazily by `/farm/words`,
     `lib/help/translations.ts`).
   Start each empty: a missing message shows in English, and the page keeps
   `lang="en"` until the site catalogue is complete. The unit tests fail
   until all three exist (`locale.test.ts`, `translations.test.ts`,
   `catalogues.test.ts`).
3. **Translation run.** `pnpm gen:i18n:export <code> <dir>`, translate,
   `pnpm check:i18n`, `pnpm gen:i18n:apply <code> …` (§ Translation above).
4. **Layout and axe.** `e2e/tests/lang-layout.spec.ts` already runs once
   per non-English language in the table, so the new one needs no new spec
   file — make sure it (and `language.spec.ts`) passes. From the third
   language the switch is a `<select>`: check it at 360 px in the headers
   and on the account page.

## Alerts

Email alerts (WP-2.13; [api.md § Alerts](./api.md#alerts), [security.md §
Alerts](./security.md#alerts)). The workspace's words are in
`lib/components/alerts/alerts.ts` (English, no message catalogue: the
workspace never loads it), the translated pages' in `alerts/words.ts` (from
the catalogue, [§ Language](#language)); both unit-tested.

- **Summary → Active alerts** (`alerts/AlertsPanel.svelte`, under Needs
  attention): the alerts firing now, each as a sentence ("Farm One: dam
  about 8 % on 20 Sep 2026 (alert below 30 %)", "EWR at the outlet at risk
  on 5 of 14 forecast days (alert at 3)", the late or failing feeds), or "No
  alert is firing". An editor gets **Set up alert emails**, which loads the
  rule editor (`alerts/AlertRulesEditor.svelte`, its own chunk, fetched on
  the click): a checkbox per catchment kind (EWR at risk in the forecast,
  restriction notice, background jobs failed, data feed failing), per farm
  dam, and, under **Data feeds behind**, per data feed ("CHIRPS daily
  rainfall (Upper)", "(feed switched off)" when it is), each with its level
  (dam % of capacity; days, a feed's past its own usual delay, defaulting by
  source; failures or jobs; range-checked in the form and by the API), a
  *Firing* mark, and Save. It says that nothing is sent until a kind is switched on,
  and that each alert is sent once per crossing.
- **The emails' liability line** (`mail/alerts.ts` `liabilityKey`, one per
  kind, each distinct line once in a digest; `mail/alerts.test.ts` pins it
  kind by kind and reader by reader). A dam alert to a farmer
  (`mail.alert.model`) says it is the catchment model's estimate from the
  figures your WUA published (true: dam_below reads the current
  publication, `alerts/evaluate.ts`), not a measurement of your dam and not
  an instruction, to check the dam and ask the WUA, and that only a notice
  from the WUA or DWS is a restriction. The same alert to the WUA's staff
  (`mail.alert.model.dam.staff`, chosen by the recipient's role, `send.ts`
  → `Recipient.farmer`) says the same in the third person, without the
  advice to check the dam. The EWR forecast alert,
  which only the WUA's staff can get (`mail.alert.model.staff`), says it
  comes from the newest forecast run, which may not be published yet, and
  is an estimate, not a measurement or a restriction; its body ends
  "Forecasts change." A restriction notice (`mail.alert.restriction.wua`)
  says it is the WUA's own, shown as published, and that questions go to the
  WUA; its percentage reads as a cut, "a 20 % cut in registered water use",
  written whole as the farm page writes it (`cutPctText`: never "12.5 %"),
  and the WUA's own words are marked with their `lang` when they are in
  another language than the mail (issue #51). The operational alerts (data feed behind, data feed failing,
  background jobs failed) are no model figure and carry no liability line.
- **`/account/alerts`** (linked from the account page's **Alert emails**
  panel and from every alert email; translated): the section header
  (`workspace/SectionHeader`, issue #17) is the page's one title, **Alert
  emails**, with what the page is for as its context line, **Back to your
  account** on the right, and under it one slim line with the daily cap (5
  right away, the rest in the next morning's summary) and, when mail is
  paused, the banner below. Then a card per catchment you can open, as many
  across as fit the page's own width (at least 34rem each: two at 1440 and
  1280, stacked on a phone; `auto-fit`, so a lone catchment takes the whole
  width and lays its rows out in two columns once the card is 66rem wide),
  in the account page's frame (capped at 92rem, a 1.5rem bottom gutter so a
  page that fits doesn't scroll). Each alert you can get is **one row**: its
  name (a fieldset legend) beside a joined three-way switch, *Right away* /
  *Once a day (06:00)* / *Off* (real radios under the segments, so arrow keys
  move the choice; the picked one tinted, bold and ticked; 32 px with a
  mouse, 44 px on touch and phones; in a narrow card the switch goes under
  the name at full width). A farmer sees a *Dam running low: <farm>* row per
  own farm and *Restriction notices from the WUA*, nothing else; a farm's
  dam row the WUA has switched on says under the switch at what level it
  warns, "Warns when the model puts your dam below 30 %. Your WUA sets this
  level." (also the row's description; `thresholdLine` in
  `alerts/words.ts`, issue #51); a viewer
  also the opt-in kinds (dam alerts for every farm, the EWR forecast);
  editors and owners the operational kinds. A choice saves when made
  ("Saved." in the card's head); the switch stays usable while it saves
  (disabling it dropped the keyboard's focus), and a catchment's saves go
  to the server in order, the page taking the server's answer once the last
  is back. An alert the catchment hasn't switched on yet is starred, and the
  card's footnote (also each starred row's description) says "Not switched
  on for this catchment yet: you get nothing until the WUA turns it on." A
  catchment muted by a digest's unsubscribe says so, with *Turn alert emails
  back on*. An owner's four catchments fit 1440 × 960 unscrolled; thirty
  farms read as two columns of rows (`alerts.spec.ts` pins both, and the
  phone).
- **Paused alert emails** (translated; on `/account/alerts` and in the
  account page's **Alert emails** panel): when SES stopped delivering to the
  person's address (`user.mailSuppressed`), a warning banner says so and
  why: "Your alert emails are paused. Our emails to <address> bounced back:
  the address may be wrong, or the mailbox full or closed." (or "… was
  marked as spam, so we stopped sending."), "Once <address> can receive
  email again, turn alert emails back on. Your choices are kept.", and
  **Turn alert emails back on** (`POST /me/alerts/resume`; "Alert emails are
  back on." in a status line). Turned back on and refused again within a
  day, it says to check the address and try tomorrow.
- **`/alerts/unsubscribe`** (an alert email's *Stop these emails* link;
  signed in or out, on the sign-in pages' `AuthCard`; translated): reads the
  token from the fragment (`#t=…`) once, strips it from the address bar,
  and **asks first**: *Stop getting these alert emails? …* with *Stop these
  emails*. Only the click posts the token (so a mail scanner that opens the
  link can't switch a farmer's alerts off). Then "You won't get dam level
  emails for Rustenvrede any more." (or "any alert emails", for a digest's link)
  with *Manage alerts*. A dead link ("This link doesn't work any more: a
  newer email may have replaced it, or you may no longer be a member") and a
  link without its token have their own states: only the API's 404 (or 400)
  means the link is dead; no signal or a server problem keeps the question
  and its button, with the reason above them, to try again. The page sets
  `no-referrer`, like the reset pages.
- **Farm view**: while the farm's own dam alert fires, an **Alerts** card
  under the WUA's notice (`farm/FarmAlerts.svelte`): "Your dam is below the
  alert level of 30 %: about 8 % on 20 Sep 2026" (or, on the forecast, "may
  fall below … around …"), with *Choose your alert emails*. Nothing shows
  otherwise, or when the alerts can't be loaded.
- **Portfolio**: an **Alerts** column (and card row): "None" or "2 firing"
  (a warning badge), from `alertsFiring`.
- Tested by `e2e/tests/alerts.spec.ts` (the pages, the banner, the rule
  editor's feed levels) and `e2e/tests/alerts-mailpit.spec.ts` (a forecast
  crossing mailed through Mailpit by the worker, its unsubscribe link, no
  mail on the next crossing; needs `pnpm dev:mail:up`).

## Share page (`/share`)

What a read-only share link opens (WP-2.3 phase 2; [api.md §
Share](./api.md#share), [security.md § Share links](./security.md#share-links)),
signed in or out, for someone outside the project, on a phone first.

- **The token** is in the fragment (`/share#t=…`). The page reads it once,
  strips it from the address bar (`replaceState`, as the reset pages strip
  `?token=`), and POSTs it to `/share/view`; a link pasted into the same tab
  (only the fragment changes) is picked up the same way. The page sets
  `noindex, nofollow` and `no-referrer`, and has its own header ("Water
  Management" with "Shared view" under it, and the EN | AF switch beside,
  one row on a 360 px phone; its content lined up over the page's), not
  the app's sidebar frame: it is a public page for someone outside the
  project, signed out or not, like the sign-in pages; it is
  a route chunk of its own, loaded only when opened. Its words come from the
  message catalogue (`share/share.ts`, the `share.*` keys, and the farm
  view's for the notice card; [§ Language](#language)), in this device's
  choice or the browser's language.
- **Top to bottom:** the catchment's name; "Published by *name* on *date*.
  Data up to *date*." (and the next expected update); in body type, "A model
  estimate that can be wrong, not a measurement, licence or restriction. As
  far as the law allows, the operator of this software accepts no
  responsibility to anyone who relies on this page." (`shareCaveat()`,
  quoted in [legal/disclaimer-review.md § 3](./legal/disclaimer-review.md)); the WUA's notice
  (the farmer view's `NoticeCard`: warning or danger fill, or "No
  restriction from the WUA"), in the reader's language, else English, else
  another the WUA wrote, with a "not translated" line, as on the farm view (marked with its `lang` when
  it isn't the page's); **The river's
  ecological reserve**: the outlet (unnamed, it may be a farm) and each
  gauge, with a check or warning icon, the last 30 days and the season in
  words; the **monthly flow chart** (mean flow at the outlet, solid, against
  the reserve, dashed, over the last 24 months; inline SVG at the rendered
  width, a summary sentence and a table behind "Show the numbers"), only
  when the series come back, otherwise a line saying that with so few farms
  the flows could reveal a farm's use; and **About this page** with the
  farm count, how long the link works, and that the result is no
  authorisation, licence, allocation or restriction under the National
  Water Act (that it is a model estimate that can be wrong is the caveat
  under the name, not repeated here).
- **Layout (issue #17):** one column on a phone (560 px at most). Once the
  page is 860 px wide (a container query) the result is 1120 px wide in two
  columns under the name: the notice and the reserve on the left, the flow
  chart and About on the right, so at 1440 × 960 it all fits without a
  page scroll (the caveat runs the full 1120 px, two lines, rather than a
  narrower reading measure that wraps it to three; the right column has
  little room to spare, so a longer caveat or About text needs this
  re-checked). The message states (dead link, error) stay
  one 560 px card. `share-links.spec.ts` pins both layouts and axe in both
  themes.
- **States:** loading; a dead link ("This link has expired or was
  withdrawn. Ask whoever sent it for a new one.") for every `404`; a link
  without its token ("This page needs the whole link…"); and an error with
  Try again. Every string is in `lib/components/share/share.ts`, the chart
  in `share/chart.ts`, the loading rules in `share/load.ts`, all
  unit-tested.

## Viewers

Viewers see a "View only" note in the section header's notice line, on every
section, and their role badge in the sidebar. Inputs render as plain values
instead of greyed-out fields. There are no move handles, drag targets, Add
data button or Run button.

## Accessibility

- `e2e/tests/a11y.spec.ts` runs axe (`@axe-core/playwright`, tags WCAG 2.0,
  2.1 and 2.2 A/AA) on every page, every workspace tab, the dialogs, the
  save bar, the one-node form, the view-only workspace, run comparison, teams,
  help, the dead-link states of the emailed-link pages and an invitation
  opened while signed in, in light and dark, and every tab again at phone
  width. No rule is disabled: a violation is fixed in the app. Each test
  scans one page state, through the shared `e2e/support/a11y.ts` scan (see
  e2e/README.md for why it runs axe in legacy mode).
- Every workspace tab (desktop and phone) and a GR4J run are also held to two
  of axe's best-practice rules the WCAG tags leave out: `empty-table-header`
  (a corner header above a column of row headers carries a visually hidden
  name, such as "Curve" or "Flow record"; `lib/a11y/tableHeaders.test.ts`
  refuses an empty `<th>` in any component) and `landmark-unique` (a tab's
  top panel is not a second region with the tab's own name).
- **Sideways-scrolling boxes** (every `.table-wrap`, and anything marked
  `data-scroll-region`, such as the schematic) become a focusable, named
  group while their content overflows, so Tab reaches them and the arrow keys
  scroll them (WCAG 2.1.1). One watcher does this app-wide
  (`lib/a11y/scrollRegions.ts`, started by the root layout); a box names
  itself with `data-scroll-label`, or takes its table caption or section name.
- **Charts say what they show** ([ui-playbook](design/ui-playbook.md) § 3,
  "Label every chart"): a title or caption naming the quantity, its units,
  the time axis, a legend or direct labels, and a text equivalent. A line
  chart's image is named with its title, series, unit and span ("Supply vs
  demand: line chart of Abstraction demand, Supplied, in m³/day, 1 Oct 2023
  to 29 Sep 2024", `chartName` in `charts/series.ts`); a sparkline's with its
  item, caption and numbers (`charts/Sparkline.svelte`).
  `lib/chartLabels.test.ts` guards it: every `<svg>` is either hidden from
  assistive tech (it or an element around it `aria-hidden="true"`) or a
  named image; every chart component (…Chart, …Bars, …Sparkline, …Strip,
  anything on uPlot) is listed with the required prop, heading or fixed name
  that says what it shows; and a chart drawn inline in a bigger component
  is listed with its on-screen labels.
- Row move buttons are 24 × 24 px (WCAG 2.2 target size, 2.5.8).
- `html { scroll-padding-top }` keeps focused controls and in-page link targets
  clear of the phone bar (`--header-h`, 0 from 900 px, where nothing is
  fixed across the top; WCAG 2.4.11).

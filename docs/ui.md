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
sidebar counts): Profile, Password and Delete my account on the left; Language and units,
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

**Delete my account** (issue #112; `lib/components/account/DeleteAccount.svelte`,
`DELETE /auth/me`) is a small card (one line and a danger button) so the
page still fits the window; the button opens a dialog, **Delete your
account?**, in the reader's language like the rest of the page. It lists
what is **Deleted** (name, email and password; memberships and farm links;
alert choices and the alert emails sent; settings; an unfinished
uncertainty result and a draft licence application), what is **Kept,
without your name** (what they made for a project, and the project's
history, which reads "Deleted user" or "a former member") and what is
**Kept, with your name** (a sign-off's typed name and registration, and the
names an evidence pack printed, for the life of the licence record), as
Privacy §7 says; then the hand-over rule, the confirmation email and the
backups line, with a link to the privacy notice. The password is typed
again (a wrong one is *Your current password is wrong.*; an empty one is
refused before any request). The only owner of a project or only admin of
a team gets an alert naming each, linked to its page (the `409
account_sole_holder` details), which takes the focus; Cancel closes the
dialog with nothing changed. On success the browser forgets the account as
signing out does (the farm view's saved copies, the note counts) and lands
on `/login?deleted=1`, whose notice says the account was deleted and that
an email says what was deleted and what was kept. The History reads such a
departure as "Deleted user deleted their account and left the project
(owner)" (`timeline.ts`). Tests: `account-delete.spec.ts` (the refusal, the
hand-over, the deletion, axe on the dialog in both themes at desktop and
phone width).

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

A chart's value axis writes its ticks short (`charts/series.ts`
`fmtCompact`): 30M, 250k, 1.5k, 0.25, and a log axis's lower decades as
decimals, 0.001 and 0.0001, never `1e-3` (issue #162); only below 1e-6, float
noise rather than a flow, does it fall back to an exponent.

## Landing page

`/` for a signed-out visitor, and `/welcome` for anyone (issue #57;
`lib/components/landing/`, `e2e/tests/landing.spec.ts`). What the app is, who
it's for and why, before the sign-in: a first-time visitor to `/` no longer
lands on the sign-in form. A signed-in `/` is still the project list, and every
other signed-out route still goes to `/login?next=`.

- **Routing.** `routeAccess` shows a signed-out `/` (`isLandingRoot`); the root
  layout renders `Landing.svelte` there in place of the projects page, loaded
  as its own chunk beside `/auth/me`. `/welcome` (`LANDING_PATH`, public) is
  the same component, **prerendered** at build time, once per language
  (`routes/welcome/[[lang=locale]]`, issue #137): `/welcome` in English and
  `/welcome/<code>` in every other language of the table (`/welcome/af`;
  `landingPath`, the `locale` param matcher), so crawlers, link previews and
  a visitor before any script get the page and its tags in the address's
  language without running the app; it renders at once, before the session is
  known, and even with the API down. The canonical link and `og:url` point at
  the page's own address, `hreflang` alternates name every language's (and
  `x-default` → `/welcome`), and `og:locale` is the language's (`af_ZA`).
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
  `landing.*` sections of the translation sheet. On `/welcome` and
  `/welcome/af` the language is the **address's**: each page's HTML is in
  its language with its own `<html lang>` (`hooks.server.ts`), the route's
  load hands the page its catalogue so the hydration matches, and the switch
  is a pair of **links** between the two addresses (`LanguageSwitch`
  `addressOf`, links however many languages there are: works without
  script, `aria-current` on the current one, never
  preloaded on hover; a click also keeps the choice on the device and the
  account). `/welcome` is also the address for a visitor whose language
  isn't known yet: once the app runs, a visitor whose choice (the
  account's, this device's, else the browser's) is another language goes on
  to that language's address (`replaceState`). `/welcome/af` stays
  Afrikaans whatever the browser says, and reading it becomes the device's
  choice when it has none, so the sign-in pages it leads to carry on in
  Afrikaans. A signed-out `/` switches in place, as the sign-in pages do.
  `e2e/tests/landing-language.spec.ts`.
- **Tags.** Title, description, canonical, Open Graph (`og.jpg`, 1200 × 630,
  rendered) and a large Twitter card, with absolute URLs from the build's
  `SITE_ORIGIN` ([deployment.md](./deployment.md)).
- **Figures** come from the invented Kleinberg example (the engine at build
  time, `data.generated.ts`), named as the example catchment's where shown:
  the hero's reserve tag, the story's charts (the river's on a square-root
  scale, which its unit says), the what-if (each bar labelled **Today** or
  **This plan**; the plan's supply in the app's supply bands), and *Why trust
  it*'s three figures under "From Kleinberg, an invented example
  catchment:", the last the run's calibration NSE in plain words ("fit to
  the measured river flow (1 is perfect)"). The art, the motion rules and the
  pipeline that makes them: [design/landing-art.md](./design/landing-art.md).

## Legal pages

`/privacy` (the privacy notice) and `/terms` (terms of use),
`routes/privacy`, `routes/terms`, framed by `lib/components/legal/LegalPage.svelte`:
a slim header whose logo is the way home (no second button), then the Help
shell's layout at its 1480 px width: from 900 px the contents list is a
sticky column on the left, like the Help menu, with the title and text
beside it (paragraphs keep a ~68ch measure; the extra width goes to the
contents, and only tables use the column's width). Below 900 px the contents
sit above the text, folded behind a **Contents (13 sections)** disclosure
(the privacy notice) on a phone, where the list alone filled the first
screen, and open from 601 px. The footer's links (Home, the three pages, and
**Contact**, which goes to the terms' contact section, `/terms#contact`, so
the address is written once) start in line with the text column. Prerendered like `/welcome` (static HTML, open to
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
and Privacy notice", whose label links both pages (in the link colour and
underlined, so they don't read as the label's text; WCAG 1.4.1). The browser won't submit
the form until it is ticked. The points sit in their own scroll box under the
box's heading, with **Read the full terms** beside it (issue #162;
`TermsSummary` `contained`): on a window 901 px wide or more the sign-up card
(`AuthCard` `fit`) is a column the window's height, and the box gives up
height until the form fits, so the page doesn't scroll at 1440×900 or
1280×800 (in English and Afrikaans, a dead invitation's warning included)
and the box, the tick and the button are on screen together. It shows the
whole list whenever the window has room, and never less than its heading and
one line of points, the fade and the link saying there is more (the floor
follows the heading's height, one line or two where the link wraps under it;
it was two lines of points until CI's wider fonts overflowed Afrikaans with a
dead invitation at 1280×800 by 9 px); below that the page scrolls after all. On a
phone the page scrolls and the box is at most 12rem. While the points overflow
the box is a focusable group named by its heading (the scroll-region watcher,
`lib/a11y/scrollRegions.ts`), so Tab reaches it and the arrow keys scroll it,
and a fade at its foot says there is more below (`auth-pages.spec.ts`). The
sign-in pages' space above the title is 3vh and 1rem (was 6vh and 2rem), and
their form 440 px wide (was 380), to make that room; the title still sits in
the same place on every one of them. On the sign-up card only, the gaps under
the title and between the fields are tighter (0.5rem).

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
`pnpm gen:liability` as usual and the page follows; when the audit adds or
closes a finding a reader would care about, update `departures.ts`. The
**Effective** line shows the engine version instead. English only.

## Verify page

`/verify/<code>` (`routes/verify/[[code]]/+page.svelte`; WP-3.14, issue #71,
[evidence-pack.md § Verification](./evidence-pack.md#verification)): the
public page an issued evidence pack prints on every page. Open to anyone,
signed in or not (`OPEN_PATHS`); `noindex, nofollow` and `no-referrer`.
English only: its readers are licensing assessors, like the methods page's.

- **What it shows** is exactly what `GET /verify/:code` returns, and nothing
  else: a verdict (*Issued and current*; *Superseded*, with a link to verify
  the newer version by its code; *Withdrawn. Don't rely on it*, with the
  reason the editor gave), then the catchment, version, issue date, engine,
  report format, methodology statement with its SHA-256, the manifest
  SHA-256, the PDF's (or *No server PDF recorded for this pack*) and the
  reproduction bundle's, with a line saying anyone holding the bundle
  re-runs the pack with `pnpm reproduce:pack`. **Signed
  off by** lists each signer's name, date and registration as the report
  prints it (*self-declared*), with the professional body's register as a
  link and its address in full; the register URLs are the engine's, never the
  database's. **Errata recorded in the pack** are those the manifest
  recorded when it was drafted; under them, **Errata found since issue**
  lists those added to the errata list later for the engines its runs (or
  their fits) used (`errataFoundSince`, 132), or says none has been found.
- **Check a PDF, reproduction bundle or manifest** (the heading names only
  what the pack has hashes for, `checkableFiles`). Choose or drop a file: it is hashed in the
  browser (WebCrypto SHA-256, `packs/pack.ts` `checkFile`) and compared with
  the recorded hashes; the page says so, and that the file is never
  uploaded. A JSON file that doesn't match byte for byte is compared once
  more in its canonical form (RFC 8785, as the hash is taken), so a manifest
  saved pretty-printed still matches and any change to what it says doesn't.
  While no PDF hash is recorded, the check doesn't offer a PDF and says
  why; a bundle matches as *this pack's reproduction bundle*.
- **A code that answers nothing** (unknown, malformed, a draft, a pack
  withdrawn before issue) is one answer: *No issued evidence pack has this
  code*. The code is read in any case, with or without dashes, or as the full
  64-character hash. Bare `/verify` asks for a code; **Verify another pack**
  is at the foot of every state. Only the latest lookup is shown
  (`packs/pack.ts` `latestOnly`, `lookUpCode`): a slow first lookup that
  answers after following *Verify the newer version* or **Verify another
  pack** is dropped, and so is a file check of the pack no longer shown.
- Everything shown is text (Svelte escapes it). The links are underlined,
  not colour alone.
- Tested by `e2e/tests/evidence-pack.spec.ts` (signed out, a wrong code, a
  manifest as downloaded, pretty-printed and with one byte changed, the
  superseded and withdrawn verdicts, axe in light and dark).

## Sign-in pages

`/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email` and `/alerts/unsubscribe` share one frame,
`lib/components/layout/AuthCard.svelte` (translated, § Language): the navy
brand panel with the catchment drawing on the left (55 %), the form on the
right, 440 px wide. They are forms, not dashboards: each fits a 1280 × 800
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

- **The security check** (the WAF's sign-in CAPTCHA, issue #126;
  [security.md § Sign-in CAPTCHA](./security.md#sign-in-captcha)). Only when
  many sign-ins come from one network does the WAF answer *Sign in* with its
  CAPTCHA (a 405); the page then shows a **Check that you’re a person**
  section above the form (`auth-extras/SignInCaptcha.svelte`): a heading and
  one line of why, then AWS's picture puzzle, loaded only at that moment.
  Focus moves to the section's heading, so a screen reader reads why it is
  there, and the next Tab enters the puzzle, whose audio button plays a
  spoken version. Solving it signs in straight away with the puzzle's token;
  the form stays usable meanwhile. If the puzzle can't load, or the retry is
  refused again, an alert says *Too many sign-in attempts from your network.
  Wait a few minutes, then try again.* (so it never loops), as it does when
  the build has no CAPTCHA configured (locally). The puzzle's own words are
  AWS's, in English (it has no Afrikaans); the heading and line around it are
  translated. It is AWS-sized (about 320 px wide, `dynamicWidth`), the one
  state that may scroll at 1280 × 800. `e2e/tests/captcha.spec.ts` covers it
  with a faked 405 and a stub of AWS's script, axe included.

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
The tabs are grouped into three sections, in this order: **Outcomes**
(Summary, River & reserve, Hydrological units, Runs & results, Dams,
Compare runs, Scenarios, Allocations), **Build the model** (Network, Crops &
demand, Transfers, Data, Settings & calibration) and **Review** (Project,
Applications, History). Outcomes leads because the Summary is the tab a
project opens on (issue #17's option A; moved last on 2026-09-27 and back to
the top by issue #162), and Help's "Getting around a project" names them in
the same order (`tour.test.ts` fails if the two part). The sections are
`NAV_SECTIONS` in `lib/workspace/tabs.ts`, and `navSections(shown)` splits
whatever tabs a role sees into them (empty sections are dropped; a tab no
section lists joins *Build the model*). Each tab's name is `TAB_LABELS` in
the same file, which the help pages share. It is layout only: the URLs stay
`?tab=<id>` and which tabs a role sees is unchanged (below).

- **900 px and wider:** in the app sidebar's slot ([§ App shell](#app-shell-and-account-menu)),
  a "Catchment" label with your role badge (owner, editor, viewer) beside it
  and, at the end of that line, the **Choose sections** button (an icon,
  with a small count beside it once you hid some, so it stays on that line;
  its accessible name says "Hidden (n)"; see Tabs by role below),
  the project's name (a link to its Summary; a long name is clamped to two
  lines, the full name its tooltip and accessible name), the section labels
  shown (each section a group named by its label; "Catchment" and the labels
  are styled as Help's side panel's group headings, the text colour, bold and
  uppercase, which `app-sidebar.spec.ts` compares), with a
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
hides the sections they don't use. Until they choose, three are hidden by
default (`DEFAULT_HIDDEN_TABS` in `lib/workspace/tabs.ts`): **History** (the
model's change log), **Allocations** (registered volumes against modelled
use) and **Applications** (the licensing inbox), the sections most days don't
need; each is one tick away and still opens from a link. The **Choose sections** button (icon only
on the sidebar's "Catchment" line, in words at the foot of the phone's
Sections menu; once some are hidden, a count on the corner of the sidebar's
icon, kept within its 24 px button so the slot never scrolls sideways, and
"Hidden (n)" in the phone's words) opens a dialog with a
checkbox per section the role shows here, opening right beside the button
(centred on a phone), grouped as the sidebar is (the groups side by side,
one column on a phone), with **Reset to default** (back to those three hidden; off while the person
has no choice of their own) and **Done**. Summary is always shown (its box is ticked and disabled). The
choice is the account's (`user.preferences.hiddenTabs`, `null` until they make
one, `[]` when they chose to show every section; `hiddenChoice` resolves it;
`PATCH /auth/me`,
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
(`lib/model/editor.svelte.ts`) and share the fixed save bar at the bottom
(`model/SaveBar.svelte`), which starts at the sidebar's edge (`--sidebar-w`,
from `AppShell`) so the account menu at the sidebar's foot stays usable. The Project page's details (name, description,
time zone, WUA name; issue #162 item 12) go through the same bar: the page
holds them (`project/detailsDraft.svelte.ts`), so they survive a tab change,
and **Save changes** saves whatever is unsaved (the details, then the
model), **Discard** puts both back. The bar says what is unsaved ("Unsaved
changes to the project details", "… to the model and the project
details"; its region is named *Unsaved project details* while only the
details are), and an empty name or time zone blocks it with the reason. The
optional reason field shows only with model edits (it goes into History with
them). Every other card on the Project page acts at once. Settings has its
own save button, which sits above that bar.

**Preview unsaved edits** (issue #284, roadmap WP-1.17). With model edits
unsaved and no problems to fix, the save bar has **Preview** (Network, Crops
& demand, Transfers, the farm drawer's edits; every tab but Settings).
Settings has its own **Preview** beside **Discard** while its form (with
nothing blocking Save) or the model has unsaved edits; it takes both, so the
save bar's is hidden there, and model edits with problems to fix are left
out and named. Both open the same dialog
(`preview/UnsavedPreviewDialog.svelte`, its own chunk), "Preview: your
unsaved settings" (or "model edits", or "settings and model edits"). When
the page couldn't load the runs list, the dialog asks for it itself rather
than say there is no run. It starts from the newest run
of the catchment's own model (`previewBaseRun`: not a scenario's run, not a
legacy one) and its own input from the server (`GET …/runs/:runId/model-input`,
`lib/preview/inputs.ts`, kept for the next preview of that run), lays only the
unsaved edits over it (`lib/preview/overlay.ts`: the settings and each model
list as last saved against as edited, path by path for settings and field by
field for an item, matched by id, a planted area by unit and crop; the
settings a run doesn't read, `autoRun`, `outcomes` and `outlook`, left out),
and runs both in the preview worker on this build's engine, so a difference
is the edits', never an engine change since the stored run. The series are
always the run's, so the preview can't drift from a stored run; a change
saved since the run isn't in it, which the dialog says. The figures, last
run against with your edits with the change (`compare/Delta.svelte`, sign,
arrow and better/worse in words): demand met, demand, shortfall, units below
95 % supplied, mean natural flow, mean outflow at the outlet, days the EWR
is not met, and NSE, KGE and percent bias when the run has a record to score;
then the units whose supply moved (the ten largest changes, "and N more"),
and units the edits added or removed. An edited item the run doesn't have
(added and saved after it) is left out and named under "Not in this
preview". With no run yet it says to run the model first; the engine's
refusal of the edited input is shown in its words. Nothing is stored, no run
slot is used, and the edits stay unsaved. The dialog is modal, so the edits
can't change under an answer; each opening works it out again (two model
runs, about 0.3 s on the client catchment, `run.perf.test.ts`).

**Leaving with unsaved changes** (issue #162 items 11 and 13;
`lib/nav/unsaved.ts`, `lib/nav/leaveGuard.ts`). Unsaved work registers
itself while it is on screen (`guardUnsaved`): the model's edits and the
project details (the workspace page), override mode's unrecorded edits, a
half-filled **Add a change** form or a typed but unsaved scenario rename,
and a name typed into the **New scenario** dialog. A navigation that would
drop any of it (another page for the page-level work; another tab or
scenario for a scenario's) is cancelled and the app's own dialog asks,
naming what is unsaved and where the link goes: "You have unsaved changes
(model edits). Leave and go to All projects? They will be lost."
(`lib/nav/destination.ts` names the sidebar's pages, a section as "the
Network page", another scenario or project). **Stay** (focused first, and
Esc) keeps everything; **Leave without saving** makes the navigation again,
let through once; Back and Forward are retaken the same way. A tab change
within the project keeps the page's own edits and doesn't ask. Only closing
the tab or reloading shows the browser's own "Leave site?" box, which no
page can restyle.

**Confirmation questions.** Every question the app asks (delete a run,
revoke a link, submit an application, remove a farmer, discard a file…)
is the app's own dialog, never the browser's `confirm()` box
(`common/confirm.svelte.ts`: `await confirmDialog({ title, message,
confirmLabel, cancelLabel, danger })` answers true or false). One host,
`common/ConfirmHost.svelte`, sits in the root layout and shows the questions
one at a time: an `alertdialog` with the question as its title, the detail
under it, **Cancel** first (it takes the focus, so Enter keeps what a
destructive question would remove) and a confirm button named for the action
(red when it destroys something). Esc answers Cancel; focus returns to what
asked. The farm view's note delete passes its words translated.
`lib/noBrowserConfirm.test.ts` fails if `confirm(` comes back in app code.

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
(or is uploading), Escape and ✕ ask before discarding it (the confirmation
dialog above; Dialog's `beforeclose` may answer later). Help-tip bubbles
render in the browser's top layer (a manual popover placed against the
button), so a scrolling table or a sticky header can't clip or cover them.
Every `Dialog.svelte` dialog but the confirmation question also has a **✕** in its top-right corner
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
  **Unsaved changes** shows beside it while the model or the project details have edits (editors).
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
  "2 runs" on Compare runs, "4 daily input series · 1 behind",
  "3 transfer rules · 2 active", "No runs yet" on a Summary before the
  first run.
- **The actions on the right**, in this order: the **Rain up to** pill
  (below), the section's own (the Network's **Tables** and **+ Add node**,
  Crops' **Tables** and **+ Add crop**, Transfers' **Show on the map** and
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

## Data age and stale wording

One module, `lib/format/age.ts` (issue #162), says how old data is, the
same way on every screen:

- **The threshold** is `STALE_DAYS`, the engine's `FARM_VIEW_STALE_DAYS`
  (7), which the backend's portfolio and farm view count stale by too.
  `series/freshness.ts` re-exports it; nothing else defines its own.
- **An age** is `dateAge`: "31 Dec 2024 (20 months ago)". `agoText` counts
  "today", "yesterday", days under 60, months under 730 days, then years
  (`ageSpan`, never "1 months"); the farmer pages count with the same
  `ageSpan` in their own words (`farm/format.ts` `agoWords`, through the
  catalogue). A run's "ran … ago" uses `agoText` too.
- **Relative words** ("today", "this week", "last 30 days") are only true
  while the data they describe reaches today. `windowText` keeps them while
  the window's last day is at most `STALE_DAYS` old and swaps in its date
  after: "3 of 3 hydrological units short in the week to 31 Dec 2024",
  "Dams on 31 Dec 2024", "EWR, 30 days to 31 Dec 2024". A label over several
  catchments (a column header, a total) uses `sharedWindowText`: the
  relative words while none is stale, the shared date when every stale one
  ends on the same day, else a neutral "EWR, last 30 days of figures" (each
  row then says its own date). Where this applies: the project list (header
  line, EWR column, units short, Needs attention), the teams list, team page
  and portfolio, the Summary's Dams card, Hydrological units' "Short this
  week" tile, header line and cards, and on the farmer pages and `/share`
  the "Last 30 days" supply line, the dam's 30-day fact and the river's
  reserve count (`farm/cards.ts` `staleUntil`, stale as the dates line is).
  The reporting-window picker's "Last 7 days" keeps its name: its dates
  follow it.
- **Whose "today".** A project's data ages count to **the project's
  calendar date** (its time zone, 058; `projects/freshness.ts`
  `projectToday` in the workspace, the API's `today` on the project list),
  the day the portfolio, the outcome columns and the farm pages count to,
  so a row never shows two ages a day apart for a viewer outside the
  project's zone (issue #137). A run's "ran … ago" is the viewer's.
- **"edited <date>"** on a project row is when the project itself last
  changed (`updated_at`: the model, its settings, allocations), not how
  current its data is; the **Data** column says that.

## Header: data freshness and "Add data"

- **Rain up to 14 Jun 2026 (12 days ago)**: the latest end of the
  **recorded rain** (catchment or CHIRPS, `isRecordedRain`), which is what a
  run is driven by. A forecast runs into the future and observed flow only
  scores a run, so neither counts: either would read "up to date" while the
  rain lags. With no recorded rain it reads "No recorded rain yet". Click it
  for every series' end date. It turns amber when the recorded rain is more
  than 7 days old (`STALE_DAYS`, [Data age and stale wording](#data-age-and-stale-wording)). Ages count
  calendar days up to **the project's** date (its time zone,
  `projects/freshness.ts` `projectToday`; the viewer's own date until the
  project has loaded); the project list's badge counts to the same day (the
  API's `today`), as do the Data tab and the Overview, so none of them differ
  by a day around midnight, whatever the viewer's zone (issue #137). Series
  dates are calendar days, so the UTC date would be wrong for anyone east or
  west of UTC.
- **Add data** (editors) opens the upload form in a dialog on any tab
  (`series/AddDataDialog.svelte`, the shared `common/Dialog.svelte`, wide).
  Dropping a CSV anywhere on the page opens it with that file. The form's
  buttons sit in the dialog's action row, on the right: **Cancel** and the
  upload button (**Upload**, **Upload and merge** or **Upload and replace**;
  `UploadForm`'s `external` mode, the button submitting the form through its
  `form` attribute). With a file read but not uploaded, **Cancel**, the close
  button and Esc ask "Discard the file?" first (the confirmation dialog)
  (Dialog's `beforeclose`, which handles Esc itself so Chrome can't skip the
  question, on the window, so an Esc pressed after the focus fell to the
  page's body asks too). Closing gives focus back to what opened it
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
   is no KPI row, reserve strip or supply list.
2. **The first screen, once there is a run**: the **Latest run** KPI row
   (four cards, the mean outflow in the line under them), the **Days below
   the reserve** strip across the page under it, then **Needs attention**
   with the **Active alerts** ([§ Alerts](#alerts)) under it, beside
   **Supply by farm** with the **published baseline** and the links under it
   (two columns from 900 px; stacked below 900 px, Needs attention and the
   alerts first). On a phone
   the KPIs are 2 × 2. The Summary is a reading page: it flows with one
   scroll, the window's, and no card scrolls inside itself; each card is as
   tall as its content, so the columns may end at different heights. Until
   2026-09-29 this block was sized to exactly the height left in the window
   (`FIT_QUERY`, from 1100 × 620 px) with the two cards scrolling inside
   themselves: on a desktop it looked like the whole page, and the alerts,
   the published baseline, the links and the setup checklist below it went
   unseen. Supply by farm is bounded instead by showing its eight emptiest
   units with a **Show all N hydrological units** button, and Needs
   attention holds at most five cards (one per kind, `attention.ts`). The
   alerts moved up from below the first screen at the same time: an alert
   firing is something to act on, like the Needs attention cards beside
   it, and its heading is inside a 1440 × 960 window even with thirty
   units.
   Until issue #162 the Summary drew the full **Flow vs reserve** chart here,
   filling what the KPIs left; River & reserve draws the same chart, larger
   and with more controls, so the Summary now shows the strip and links
   there instead: the flow chart is drawn once, on River & reserve.
3. **The published baseline and the links**: once there is a run, in the
   right-hand column under Supply by farm, which is usually shorter than
   Needs attention and the alerts, so a typical catchment (the example
   Droëvlei one) fits a 1440 × 960 window with no page scroll; a bigger one
   (Sandspruit, eight units and a two-language notice) still scrolls about
   135 px, since fitting it would mean hiding content (Droëvlei was 1173 px tall
   with the baseline, links and a folded checklist across the page below
   the columns; `overview.spec.ts` checks the seeded catchment fits). Before
   the first run, when there is no first screen, the active alerts sit
   beside the baseline, two columns once the tab is 56rem wide (a container
   query; stacked below that). The link is **Model facts, details, team
   and sharing → Project**. A second, **Dam levels for each dam → Dams**,
   was removed in issue #177: the **Dams today** card and the sidebar
   already open the [Dams](#dams) page. The
   model's headline facts, project details, import record, recent notes,
   team, members, farmers and share links moved to the [Project](#project)
   page (2026-09-27, issue #17). A link to one of their panels' old
   fragments on the Summary (`#details-h`, `#import-record-h`,
   `#recent-notes-h`, `#team-h`, `#members-h`, `#farmers-h`, `#share-h`,
   and `#model-h` for the facts; `project/links.ts` `PROJECT_ANCHORS`) is
   sent there, replacing the history entry so Back skips it.
4. **Setup.** While a step still needs work (or the lists are loading and
   nothing known is missing: a one-line "Checking data and runs…" bar) the
   checklist is on the page: first before a run, under the columns after
   one. Once every step is done (`checklistMode`, `overview/checklist.ts`)
   it leaves the page for a **Setup complete ✓** pill in the section header,
   before the rain pill (the Summary fills `headerSlot.status`). The pill is
   a button (`aria-expanded`) that opens the five steps as a compact list in
   a popover over the page (`overview/SetupPill.svelte`, the rain pill's
   pattern: Escape closes it and returns focus to the pill, a click outside
   closes it), so opening it never makes the page taller; it opens leftwards
   beside the title and rightwards when the header wraps, nudged to stay
   inside the window at any width. Until 2026-09-29 the complete checklist
   was a one-line `<details>` at the foot of the page that grew it by 125 px
   when opened.

- **Ready.** The Summary's body (`data-testid="summary-body"`, in `overview/OverviewTab.svelte`)
  sets `data-ready="true"` once every section that loads its own data has settled, loaded or
  failed: the latest run's record and the previous run's, the dams' levels, the Supply by farm
  chunk, the alerts (`AlertsPanel`'s `ready`) and the published baseline (`PublishedBaseline`'s
  `ready`). The Latest run card is on the page while its record loads and the rest fill in after
  it, so the page grows until then: an e2e spec that measures layout (page height, box positions)
  waits on it first (`summaryReady` in `e2e/tests/overview.spec.ts`), never on a sleep.

- **Days below the reserve** (`overview/ReserveStrip.svelte`, rules in
  `overview/reserveStrip.ts`), once the latest run's record is in: the days
  below the pragmatic EWR at the outlet in each of the run's last twelve
  months (`recentMonths`, from the run summary's monthly grid,
  `RunSummary.ewrCompliance`, so it draws with the cards: no series to fetch,
  no chart library), oldest first. Each month is a small bar (its height the
  share of the month's days below, in the warning colour of the flow chart's
  shading), the count above it and the month under it, the year under the
  first month and each January; each is a list item whose words ("Jan 2024:
  below the EWR on 12 of 31 days") are what a screen reader and the tooltip
  get. A line under the heading says what it counts and the span ("… (EWR
  not met), the run's last 12 months: Jan 2024 – Dec 2024"). On a forecast
  run it stops before the month the forecast starts in, as the cards are the
  history's. Six a row on a phone. A run made before the monthly grid says
  so. Beside its heading, **More on River & reserve** opens [River &
  reserve](#river--reserve) for that run (`riverHref`, `river/links.ts`),
  where the **Flow vs reserve** chart is.
  **With a Reserve rule table** (issue #177) the headline card is
  *Reserve rules met*, judged by the table (whole months at a site,
  `headlineSite`), while the strip still counts days below the pragmatic
  EWR at the outlet, so "the reserve" would name two different tests on one
  screen. There the strip is headed **Days below the pragmatic EWR** (its
  region and month list named the same, a month "below the pragmatic EWR on
  12 of 31 days"), and the line under the heading adds "The Reserve rules
  card above judges whole months by the rule table instead."
  (`stripWords`/`stripWhat`, `reserveStrip.ts`, its name from
  `ewr/notMet.ts` `daysBelowTest`, which River & reserve's panels share;
  OverviewTab passes `ruleTable` from `headlineSite`). It keeps counting the pragmatic EWR
  rather than switching to the table's test: the table gives one verdict
  per complete month, not a count of days, so there is no "days below"
  to draw from it, and its months are already the card's figure (and
  River & reserve's Reserve compliance by month).
- **Supply by farm** (`overview/SupplyByFarm.svelte`, rules in
  `overview/supplyBars.ts`): every farm in the latest run with a bar and the
  % of its demand supplied, emptiest first (fullest first until 2026-09-29;
  the card shows the first eight, so the short units lead, as on the Dams
  page and Hydrological units), with **Show all N hydrological units**
  (`aria-expanded`) opening the rest in place and **Show the 8 emptiest**
  closing them, in the Network's
  supply bands (`network/supplyColour.ts`: amber below `SUPPLY_TARGET`, red
  below `LOW_SUPPLY`, with a key; a farm with no demand says "no demand"
  and goes last). A farm's name opens its [farm drawer](#farm-drawer)
  (`farmDrawerHref`), unless it has left the model since the run. Beside its
  heading, **More on Hydrological units** opens [Hydrological units](#hydrological-units)
  for that run (`supplyHref`, `supply/links.ts`). Under the heading, one line
  says what the bars measure ("Share of each unit's irrigation demand
  supplied, latest run"). Its own chunk (it waits for the run's record
  anyway).
- **Dam levels** moved to the [Dams](#dams) page (2026-09-26, issue #17),
  and its columns into the Dams cards (2026-09-29, issue #175):
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
  ago" (`agoText`, by the viewer's calendar), with badges for a legacy run
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
  order Reserve · Irrigation supplied · **Dams today** · NSE (**Dams on
  31 Dec 2024** once the run's last day is more than a week old). *Dams today*
  (`latestRun.ts` `damsHeadline`, `damLevels.ts` `damsToday`) is all dams'
  storage at the end of the run as a share of their total capacity (weighted
  by capacity), with its change over the run's last 30 days ("▼ −9 pp in 30
  days"; none when the run is shorter), flagged below 30 %; it reads the
  run summary's dam figures (engine ≥ 1.2.0, issue #55), or for an older run
  each dam's `dam_storage` series through the Runs cache, when it says
  "loading dam levels" until they are in; "no dams in the run" without any. The card links to the [Dams](#dams) page: its term is a link
  (`Headline.href`, `DAMS_HREF`) stretched over the whole card, as the model
  facts' tiles are. *Mean simulated outflow* isn't on the Summary: it is a
  tile on [River & reserve](#river--reserve), with its change. Under the
  cards, the run the changes are against. Each
  card shows its change from the previous run (the one before it by
  `createdAt`) with the compare page's `Delta` (sign, ▲/▼ and a spoken
  better/worse, so colour is never the only cue), only when both runs have the
  figure: the Reserve only at the same site, the pragmatic EWR only when
  neither run headlines a rule table. The full records come through the Runs
  tab's `detailCache`, so only this section shows a loading or error state
  (`LoadState`, with a retry) and the Runs tab then opens the run at once. Four
  cards in a row, 2 × 2 below 760 px.
- **Published baseline** (WP-2.3, `overview/PublishedBaseline.svelte`),
  below the first screen (after the active alerts before the first run; shown with or without runs): what stakeholders and farmers see. It fetches
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
  Each card has a short title ("The latest run has 2 warnings"), a one- or
  two-line detail and its link; the link covers the whole card. The card is
  coloured by its `tone`: amber for run warnings and stale data, grey for new
  rainfall and unplanted farms (the title always says what's wrong, so colour
  is never the only cue). Items: the latest run's warnings (the first one as the detail), rainfall the latest run hasn't used
  (`newDataSinceRun`, links to Runs to re-run), input data older than
  `STALE_DAYS` (`freshness`, links to Data), and farms with no planted area
  once anything is planted (one farm: **Set its planted areas**, the farm
  drawer; several: Crops; before anything is planted the checklist's crops
  step covers it). Run items wait for the run's summary. Units below
  `SUPPLY_TARGET` were an item too ("1 of 2 hydrological units below 95%",
  red or amber, with a second link to the worst unit's planted areas) until
  issue #177: the same fact is the Irrigation supplied card's sub-line and
  Supply by hydrological unit's first rows, on the same screen.

## Dams

`?tab=dams` (`dams/DamsTab.svelte`, rules in `dams/dams.ts` and
`overview/damLevels.ts`), under **Outcomes** after Runs & results (issue #17,
option A · Outcomes; no board of its own, so it takes A1's cards). It is a
reading page: it flows in the window's one scroll, and nothing on it scrolls
vertically inside itself (until 2026-09-29 it copied the Summary's
window-fitting layout, the cards scrolling in their column, and what sat
below the fold went unseen). Every member who sees the Summary sees it
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
- **Levels are shares of the day's capacity** (issue #67): a dam losing
  capacity to sediment or in service from a date (engine ≥ 1.30.0,
  [model.md §2.7g](./model.md)) holds a different volume each day, so every
  % full, minimum level, days-at-minimum count, sparkline point and
  capacity-weighted total here, on the Summary's Dams today, the Network's
  colour by dam level and node card, and
  Compare's dam storage divides by the capacity on that day
  (`damLevels.ts` `capacityOnDay`, the engine's `damCapacityOn`; 0 %, or no
  point on a chart, before the dam is in service). The chart's capacity and
  minimum lines follow it in m³. The capacity shown beside a dam's name, and
  every total of dam sizes, stays the entered capacity. A dam whose fields
  change nothing reads exactly as before.
- **Cards** (`damCards`), emptiest first (the levels' order), then any dam
  without a level in node order: the name, capacity, % full at the end of the
  run, "below 30%" / "at its minimum level" in words, the change over the
  run's last 30 days in words with ▲/▼ ("down 11 pp in 30 days",
  `changeWords`), a sparkline of the last 365 days as % of capacity
  (`storageSpark`: at most 60 steps, each drawn at its lowest real day, plus
  the first and last day; the compact chart pattern, `charts/Sparkline.svelte`):
  captioned "% full over the run's last year", the window's first and last
  day under its ends, and between them the low with its day ("low 15% ·
  19 Dec 2023", the chart's facts line's *lowest in its last year* to the day),
  marked by a dot; pointing at the line reads out that day instead, and so
  do the keys on its focused slider (from the low; End is the last day). In a
  narrow card (a phone's two columns) the low takes its own line under the
  dates. The line sits above the card's stretched link, and a click on it
  picks the dam as the rest of the card does. A dam with a minimum operating
  level says how many days of its last year it sat at or below it ("12 days at
  its minimum (10%) in its last year", `DamLevel.daysAtMin`; none for a dam
  without one). While the levels load, each card says "Loading dam levels
  (N of M)…". Then links
  **On the Network** (`?tab=network&node=<id>`, the node picked on the map),
  **Show on map** (`?tab=map&node=<id>`, only for a dam's unit with a linked
  map feature) and **Planted areas** (the [farm drawer](#farm-drawer), `farm=<id>`, over
  this page). A coloured edge repeats the band (accent, amber below 30 %, red
  at the minimum; grey without a level).
- **Removed 2026-09-29 (issue #175):** the **Dam levels** table under the
  cards (`dams/DamLevels.svelte`: every column was already on the cards, their
  sparklines or the picked dam's facts line, in the same order; the cards took
  its *Days at minimum*), and the **All dams together: X% full** line above
  the cards (capacity-weighted, so the biggest dam hid the empty ones, and it
  repeated the Summary's Dams today card, which keeps it).
- **Picking a dam**: the name is a link (`dam=<nodeId>`, `withParam`) stretched
  over the card, so a click anywhere on it picks the dam, the URL can be
  shared, and Back returns to the one before. Without `dam=` (or with one
  that has no card) the first, emptiest, card is charted. When the layout is
  stacked the chart scrolls into view after a pick.
- **Every dam's card shows**, always, emptiest first, so a `dam=` link always
  has its card. Until 2026-09-29 the list folded (`common/fold.ts` `foldList`:
  three beside the chart, four stacked, eight before a run) behind a **Show
  all N dams** button; at 1440×960 with eight dams that left three cards and
  the lower third of the window empty, so the fold was dropped. The page
  flows in the window's one scroll with the chart sticky beside the cards.
  Stacked on a phone, many dams put the chart well below the first screen;
  picking a dam scrolls the chart into view, which is the way to it there.
- **Storage chart** of the picked dam: its storage, a dashed capacity line
  and (a farm with one) its dashed minimum operating level
  (`storageChartSeries`), as **% full** (default) or **m³**, with the
  Summary's **30 days / 1 year / All** switch (`FLOW_WINDOWS`, opens on a
  year). A line above it: % full and the volume on the last day, the lowest
  in the last year and the days at the minimum level.
- **Layout**: the cards column sits beside the chart once the page is 56rem
  wide (a container query on the page, not the viewport), the plot a fixed
  420 px and the chart panel sticky (`top: --header-h + 0.75rem`), so it
  stays in view while the cards are read down in the window's scroll. Narrower, the cards are two to a row on
  a phone, then the chart (260 px).
- **Minimum level**: the model keeps the minimum as a fraction of capacity
  (`damMinPct` 0.1 = 10 %) and only a farm's dam has one, so `damsInRun`
  turns it into a % (until 2026-09-26 it passed the fraction through, so a
  10 % minimum was drawn and counted as 0.1 %). The page fetches every dam's
  series even though the run summary carries the level figures (engine ≥
  1.2.0, issue #55), because each card's sparkline and the storage chart draw
  them.
- **Empty states**: no dams in the model says how to add one, with **Open the
  Network** and **Node table** (the grid modal over this page, where a node's
  dam capacity is set or a node added; a new dam shows as a card at once).
  No run yet: the cards show each dam's capacity only, under a note linking
  to Runs & results to run the model (a viewer is told an editor has to run
  it), with no chart.

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
- **The model**: eight headline facts (units, gauges and other water users,
  catchment area, dam capacity and farm dams, irrigated area and crops,
  active transfers, time series, model runs, the outflow gauge), counted from
  the page's lists and the model as edited, so an upload or a run shows at
  once. They count as the tab they link to does (`project/modelFacts.ts`,
  issue #177): gauges and other water users apart, as the Network's header
  line splits them, and the Dams page's dams (`modelDams`: a farm with at
  least 1 m³).
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
  (it fetches `GET /projects/:id/import-report`; `{ report: null }` shows
  nothing, and no request fails for a project that wasn't imported). "Imported from the b023 workbook *file* on *date time* by
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
  from the browser's list of zones, saved with the page's **Save changes** bar (editors;
  read-only for viewers). Every download of the project (CSV, JSON, the
  .xlsx workbook, the server report PDF) is dated by the calendar day there,
  so an export made just after local midnight carries today's date, not
  UTC's yesterday. The same day dates what the server counts for a person:
  the portfolio's ages, the feeds' health, the farm page's "not recent"
  notice and forecast date, and the alerts (their "today" and the 06:00
  digest). A zone the server doesn't know is refused with its error.
- **WUA name** (Project details, under Time zone; issue #74): the name of
  the Water User Association the farm pages tell a farmer to contact
  ("Questions? Contact Vaalbank WUA."), saved with the page's **Save
  changes** bar (editors); empty keeps "your WUA". Not the team's name, which may be a
  consultancy's.
- **Layout**: Project details, the import record, recent notes and the
  model's facts (a panel, 2 × 4 tiles) on the left; on the right, "who has access": Team above
  Members (or "Shared directly with" for a team project), so the two panels
  that refer to each other sit together, then **Farmers** and share links. The columns answer to
  the page's width (container queries on `project-page`: two columns from
  about 760 px of page), then one column in the order details, import
  record, notes, facts (4 × 2 tiles, 2 × 4 on a phone), team, members,
  farmers, share links. The facts were the page's first row, eight across,
  until 2026-09 (issue #176): each repeats the header line of the tab it
  links to, so the first row now answers what the project is and who has
  it.
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
  the table shows the results. Opened again after a send, the CSV box is
  empty. Everyone is invited, account or not (issue
  #136: a farmer already here gains the rows' farms at once), and listed under **Pending farmer invitations** (owners
  only) with their farms, who sent it and when it expires, with Resend and
  Revoke. Empty state: "No farmers yet: invite them to see their own farm."
  Farmer invites stay out of the Members panel's pending list.
  Farmers aren't in the Members list (it hides the `farmer` role), and a
  farmer never sees this page: their own view is WP-2.6. A link to a farm
  deleted but not yet saved reads "a removed farm".
- **Share links** (WP-2.3 phase 2, `project/ShareLinksPanel.svelte`, rules
  in `project/shareLinks.ts`), owners only, under Farmers: read-only links
  to the published baseline for people outside the project, and the owner's
  inventory of **every** public link in the project (`?scope=all`): the
  baseline links made here, each application's links, made by its
  assessors or applicant from the application's Share dialog, and each
  evidence pack's, made by an editor from the pack's page (128). Under each
  label the row says what the link opens ("The published baseline",
  "Application “name”", "Evidence pack “name”, version n", or "An
  application you can't open" for one reopened as a draft or deleted) and,
  for a live link whose application is withdrawn or unreadable, that it
  opens nothing just now; for a pack withdrawn or replaced, that the link
  shows only that, not its figures. The owner can
  withdraw any live link from here; the confirm names the target. *Make link*
  takes who it's for (up to 100 characters) and how long it works (1 week,
  30 days, 90 days or 1 year); the new URL shows **once**, in a read-only
  field with **Copy** (it falls back to selecting the field when the
  clipboard is refused), because the token isn't kept. The list shows each
  link's label and state (Live, Expired, Withdrawn), who made it and when,
  when it ends or who withdrew it, and when it was last opened (to the
  hour), live links first (`e2e/tests/share-link-inventory.spec.ts`). **Withdraw** asks first, then the link shows the
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

**No projects yet** (`projects/GetStarted.svelte`): in place of the list, a
card says what a project is and the three steps from nothing to a run, with
**New project** (and, without a team, a link to create one). Under them,
**Or try an example first** offers **Start from an example** (issue #286):
the invented Kleinberg example catchment (four hydrological units, fruit
farms with dams, two transfers, a stored GR4J fit, 15 years of made-up rainfall), imported as
your own personal project through `POST /projects/import?run=1` and opened
on its first run (*Initial run (import)*) on Runs & results. If that run
fails the project is still created, and the card says so instead of opening
it ("The example was created, but the model didn’t run: …", with **Open the
example**), as the import dialog does. A user who leaves the list while it
works isn't pulled into the project when it lands. The document is
`projects/exampleCatchment.generated.json`, the same data `pnpm
seed:examples` seeds for Kleinberg, written by `pnpm gen:example`
(`backend/scripts/example-file.ts`; synthetic only, the repo is public). It
is ~25 KB gzip (84 KB raw) that nobody with projects needs, so it is a lazy chunk of its
own (`projects/example.ts`): hovering or focusing the button starts the
download, the press imports it. While it works the button reads *Setting up
the example…* (`aria-busy`, still focusable); a failed download offers
**Reload page** (`ChunkFailed`), a refused import says "Couldn’t create the
example:" and the server's error.

**Figures.** Each row carries the team portfolio's
figures for its project, from `GET /projects/outcomes` ([api.md §
Projects](./api.md#projects)), which covers personal and shared projects as
well as team ones and loads beside the list (the rows show first, with
"Loading…" in the figure cells; a failed request says "Figures unavailable"
and the list still works). The wording comes from the portfolio's helpers
(`portfolio/portfolio.ts`, `StatusPill`), so a catchment reads the same here,
on the teams list and on the team page. Columns: **Catchment** (the name, then owner/team for *Shared
with me*, your role and "edited <date>", when the project itself last
changed, and the description on one line), **EWR, last 30 days** (the pill
in words and colour, and *Published* or *Latest run* with the figures' age,
"to 31 Dec 2024 (20 months ago)"; the header names the date instead once the
figures are stale), **Hydrological units short** ("2 of 8 units
short this week", or "… in the week to 31 Dec 2024" on stale figures, a link to that run's curtailment on Hydrological units;
*Not published* until a run is published; under it the count over 30 days,
"1 in the last 30 days"), **Lowest dam** (with the published restriction
under it, "Restriction: Advisory · 15 %" or "Restriction: None"; nothing
without a publication, where the dam already says *Not published*), **Data**
(the rain badge, "Rain to 31 Dec 2024 (20 months ago)", *Newer rain not in
the figures*, the feeds' health), **Last run** (its age, then the date or
when it was published) and **Alerts** (the alerts firing now, "None" or a
"2 firing" badge, from `alertsFiring`, [§ Alerts](#alerts)). A
project where your role is farmer or applicant has no figures ("Not shown
to your role").

The header's line adds what the portfolio's tiles counted, when there is
any: "… · 1 alert firing · 2 with stale figures" (figures over 7 days old;
`portfolioTotals`). The portfolio's stacked bar went: the line already says
the counts in words.

**A team's portfolio** (issue #176) is the team's chip (`?owner=team:<id>`):
a note under the chips states the rule the statuses were judged by ("EWR
status is the outlet over the 30 days to the figures' last day (the
published run, or the latest when none is): green when it was not met on
under 5 % of them, amber under 20 %, red otherwise") and whose it is (the
team's `portfolioThresholds` from `GET /teams`: *These are the team's own
thresholds* or *the default thresholds, still to be confirmed by the
hydrologist*), then *Change them on the team page* (admins, the settings
sheet) or "A team owner can change them on the team page". The rows'
statuses are judged by each project's own team's thresholds
(`GET /projects/outcomes`), so the note and the rows agree. *New project*
preselects the team, the empty state offers *New project in <team>* to
members, the tab title names the team, and a team that isn't yours (a
stale link) says "This team doesn't exist or you're not a member" with links
to your teams and all projects. The Teams list, the team page and the
settings sheet link here as **Project list** (`?owner=team:<id>&sort=status`).

**Needs attention** (`projects/NeedsAttention.svelte`, rules in
`projects/outcomes.ts` `attention`): the catchments in view to look at
first, most urgent first: a red EWR, hydrological units short this week, alerts firing,
an amber EWR, failing or stale feeds, newer rain than the figures, figures
over 7 days old (the portfolio's *stale*: "Figures to 31 Dec 2024 (20 months ago)"). Up to four cards (two a row on a
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
first), *Hydrological units short*, *Lowest dam*, *Figures age* (oldest
first; the Data heading), *Last run* (newest first), *Name*, from the Sort
select or a column heading (`aria-sort`). A second click on the sorted
heading turns it round (`?dir=desc`: best or oldest first, Z–A), as the
portfolio's did; the Sort select starts a key its own way round. An outcome
sort puts unknown values and rows without figures last either way. Old links
(`?owner=`, `?sort=name`, `?new=1`, `/teams/:id/portfolio`) still work. With
*All projects* the list is grouped (Personal, each team with its **Only this
team** and **Team members & settings** links, Shared with me), one table per
group with the same fixed columns; the headings wrap inside their columns.

**Fits the window** from 900 × 620 up: the list's card
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
dam (with the restriction), Last run and Alerts (a "2 alerts firing" badge,
only when some are) into lines under the name at 1100 px or narrower (a
1280 px window beside the app sidebar), and at 730 px every figure: the
pill, units short, the freshness badge, the last run, the lowest dam and the
alerts stack under the name, with Add data and ⋯ stacked on the right.
`portfolio.spec.ts` pins the team filter with thirty catchments at 1440×960
(every column, the name column at least 200 px, no heading past its
column) and 1280×800 (the folded lines). The rain
badge wraps inside its cell at any width (until 2026-09-29 it stayed on one
line and ran under Last run; `projects.spec.ts` checks it at 1440, 1024 and
320 px).

**A click anywhere on a project's row opens it.** The name link stretches
over the row (`ProjectTable.svelte`, `.name::after`), so it's a real link:
Ctrl/Cmd-click or a middle click opens a new tab, and the keyboard and screen
readers still meet one named link per row. The row's team link, units-short
link, Add data, the ⋯ button, and the freshness and run figures (whose
tooltips explain them) sit above the stretch and keep doing their own thing.

**Row actions.** **Add data** (editors and owners) opens the workspace with
the upload dialog (`?add=data`: the page opens it once the role is known,
for an editor only, and drops the parameter so Back or a reload doesn't
reopen it; until 2026-09-29 nothing read the parameter). The **⋯** button ("More actions for
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
3. **Importing:** a status line; the controls are disabled. The dialog's
   Cancel reads *Close* here: closing doesn't stop the request, and the
   list still takes the project.
4. **Done:** "Imported *name*", plus "Its first run is ready on the Runs tab"
   after a run, or a warning with the reason when the run failed (the project
   is still imported). *Open project* goes to it; the list behind has already
   reloaded.
5. **Failed:** the server's message (zod or model problems are listed) and
   "Nothing was created." When the server couldn't be reached, it says the
   import may or may not have gone through and to check the list first. *Back
   to the preview* keeps the file and choices; *Close* (nothing is left to
   cancel) leaves.

Each step that replaces the focused control moves focus on: the name when
the preview appears, *Open project* when done, *Back to the preview* after a
failure, the file picker after *Choose another file*.

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
   - **River pumping units** (only when the importer flags a unit as
     probable run-of-river; issue #54, 2c/2d): *Import these N as run of
     river, pumping from the river*, off by default, its hint naming the
     flagged units. On, it converts them as the Python importer's
     `--run-of-river` does: the run-of-river supply rule, the dummy dam
     dropped and the river pump uncapped (`pumpCapacityM3Day` null) until
     the capacities are entered under Network → Supply, with a warning per
     unit; a unit an enabled transfer draws on keeps its dam, and says so.
     Like the gauge option it re-extracts from the workbook the worker holds.
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

**Role names** (issue #162): the UI uses one set of names for team and
project roles, **Viewer / Editor / Owner**. A team role is shown by the
project role it gives on every team project, so the API's team `member`
reads "editor" and its `admin` "owner" (a project `contributor` reads
"applicant"). Only the words differ; the API and database keep their values.
Every role label goes through `roleLabel` / `roleTitle`
(`lib/api/roleLabels.ts`): the team pages' badges, role pickers, roles key
and add messages, the Members panel, pending invites, the project list's
role and the History tab's member lines. The invite email names the role the
same way (`roleName`, `backend/src/mail/templates.ts`). With one set of names
the Project page no longer spells out "team admins are owners…": its Team
panel says team members keep their team role on the project. Below,
"admin" and "member" are the API's team roles.

**`/teams`** shows each team as a card: its name (opens the team) and your
role, then **Projects** and **Members**, a stacked **EWR, last 30 days**
bar with the counts in words ("1 red, 4 green"), and the projects worst first with their status
pills (five, ten when it's your only team; the rest are "N more projects in
the project list"). *Open team* and *Project list* (the list filtered to the
team, worst first) sit at the card's foot. The
numbers come from each team's portfolio (`GET /teams/:id/portfolio`, one
request per team after the list loads; no new endpoint), so a card shows
its project and member counts at once and fills in the rest; if a
portfolio fails the card says so and keeps its counts. The card grid
auto-fills; a single team gets the full width with its projects beside the
numbers. A **How teams work** panel beside the cards explains the three
roles. *New team* stays in the header, and the empty state explains teams.

**`/teams/:id`** leads with outcomes. The header has the team's name and
your role, a summary line ("5 projects (1 red, 4 green) · 4 members ·
created 26 Sep 2026") and the actions: **Project list**, **Team settings**,
**Add member** (admins; focuses the add form) and **New project** (members
and admins; opens the New project dialog with the team preselected). The
main column is **Projects**: two tiles (EWR bar, alerts firing), then each project worst first with its source
("Published run"…), EWR pill, figures age and *Stale* flag, farms short
(linking to the run's curtailment, as on the project list), lowest dam and
alerts; a footnote states the traffic-light rule with a link to the
settings. **Members** is the side column (below on a narrow page): name
with the email under it, role, Remove; the add-by-email form, pending
invites and the roles list. Admins pick each member's role from
**viewer / editor / owner** (the API's `viewer` / `member` / `admin`; the
sole admin's viewer and editor options are disabled), and the page explains
each role in a short list under the table: viewers read every team project,
editors edit them, owners own them and manage the team. A team viewer doesn't get "New project"; the
New project dialog and the Summary's *Move to* list offer only teams where
you're a member or admin, and copying a team project you only view makes a
personal copy (the Copy dialog says so).

**Team settings** (`?settings=1`, a side sheet,
`lib/components/teams/TeamSettings.svelte`) holds what used to sit in the
reading path: **Team name** (admins; *Rename*), **EWR traffic lights**
(below), and **Leave or delete** (*Leave team* for everyone, the only admin
told "You are the only owner…" and to hand over first; *Delete team* for admins, which closes the sheet
and asks in a confirmation dialog). The URL opens it (the project list's
team note, "Change them on the team page", links there), and closing it drops the
parameter in place, so Back closes it.

**EWR traffic lights** (in the settings sheet, decision D11; "Portfolio
traffic lights" until issue #176): every member reads the rule the team's
statuses are judged by (linking to the project list), "green when it was not
met on under 5 % of them, amber under 20 %, red otherwise", and whose it is:
*These are the team's own thresholds* or *These are the default thresholds,
still to be confirmed by the hydrologist*. Admins get two number inputs,
*Green below (%)* and *Amber below (%)*, checked as the API checks them (both
0–100, green below amber; the message sits under the inputs, which carry
`aria-invalid`), *Save thresholds* (disabled while invalid or unchanged) and,
once the team has its own, *Use the defaults*. Anyone else sees "Only owners
can change them." A change shows in each team project's History tab
(`team_thresholds.changed`).

### Portfolio (`/teams/:id/portfolio`)

The team portfolio (roadmap WP-2.14) is the [project list](#project-list)
filtered to the team since issue #176: the list's rows already carried the
same figures from the same helpers, so the page only added its Restriction and
Alerts columns and its tiles, which the list now has (§ Project list, *A
team's portfolio*). The old address still works: `/teams/:id/portfolio`
(`routes/teams/[id]/portfolio/+page.svelte`) replaces itself with
`/?owner=team:<id>&sort=status`, keeping `?sort=` and `?dir=desc` (the
portfolio's keys, `status`, `name`, `age`, `farms` and `dam`, are all list
sorts; `projects/grouping.ts` `portfolioListHref`). `GET /teams/:id/portfolio`
stays: the teams list and the team page read their tiles and traffic lights
from it.

## Network

One page, the **map** (issue #17, option A's simplicity with nothing lost).
It used to have three layouts (Map, Table, One node); with the Tables menu
they only made the page jump, so the other two became things the map opens:
the **node table** is a grid (**Tables → Node table**, `grid=nodes`, the
[grid modal](#grid-modal) showing `NetworkTab` with `only="table"`), and a
node's **full form** opens in a sheet over the map from its card's **Edit**
(`edit=<id>`). Old links still land: `view=table` becomes `grid=nodes`,
`view=node` becomes `edit=<node or the first>`. `node=<id>` picks a node (a
note's link on the Summary, `notes.ts` `noteHref`).

- **Map** (the A2 board), a page of its own:
  - **Header** (with no nodes yet too): "Network" and one line on what it is
    ("2 hydrological units · 2 dams · 1 gauge · into Outflow gauge · 32.0 km²";
    "No nodes yet"); on the right a **Tables** menu (a disclosure named "Open
    as a table": *Node table*, *Crop factors*, *Planted areas*, *Transfers*,
    each in the [grid modal](#grid-modal); Escape or a click outside closes
    it) and, for editors, **+ Add node**, which opens the new node's form in
    the sheet. With no nodes the map card is an empty panel with **Add
    outflow gauge**.
  - **Catchment map** card: *Colour farms by* in its header, the schematic
    filling the card, and the map key under it. Colouring by supply is
    **on by default** once the project has a run.
  - **Map key** (`mapKey` in `NetworkSchematic.svelte`, also under the
    report's drawing): headed groups, **Nodes** (the shapes), **Lines** (the
    river, drawn thickening, "thicker with more area upstream", and
    transfers) and **Colour: supply** / **Colour: dam level** (the bands),
    then the run caption and the drag hint. Each swatch uses the map's own
    shapes and classes (the dam square with its wave), and a colour band shows
    a unit and a unit with a dam side by side, since the colour fills either
    shape. It lists only what the drawing has (no Gauge entry without a
    gauge, no Transfer without one). The drawing's colour tokens sit on the
    box around map and key, so the key follows light and dark as the map does.
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
    the layout's top, and the map card isn't `aria-busy` (set while the latest
    run's results load: their status line sits in the card's head, which wraps
    at 1280 px, so the map moves up when it goes); e2e waits on that
    (`waitForMapFit`, e2e/support/diagrams.ts) before measuring the map (issue #138).
  - **Legend line:** the shapes, the supply bands present, the run they come
    from ("Hydrological units coloured by … in run “test”, ran today", read out) and the
    drag hint, which becomes the live drop status while dragging.
  - The **Tables** menu closes through its element (`details.open`), not its
    bound state: the `toggle` event that updates the state is async, so an
    Escape right after opening would otherwise leave it open.
  - Beside it (one column below 900 px, the map first), two cards:
    - the **picked node** (`network/NodeCard.svelte`): kind ("Selected ·
      farm", "outflow gauge", "other water user") and name, its notes
      (`NotesDrawer`, a saved node), **Show on map** (`?tab=map&node=<id>`,
      only when a map feature is linked to the node, issue #326 A2; which
      nodes have one comes from the map's feature list, fetched once the page
      has drawn, `workspace/mapLinks.ts`, as on Hydrological units and Dams) and
      **Edit** (**Details** for a viewer), which opens its form in the node sheet. A farm has two tiles:
      *Supplied* in the latest run (the newest run's summary, fetched through
      the Runs tab's `detailCache` whenever this layout shows; the tile
      tints for the short and low bands, and "no demand" / "not in this run"
      are written) and **Dam at end of run** (it was "Dam now", but it is the
      latest run's last day, the record's last day on a forecast run, not
      today), its storage then as a % of the capacity the run modelled (from
      the run's own model, `damInRun`, as the map's colour by dam level reads
      it, so a capacity edited since doesn't make the two disagree, issue
      #173; from the run summary, or its `dam_storage` series through
      `cachedSeries`, reduced by `overview/damLevels.ts`). It reads a farm as
      the map does (`damEndTile`): "No dam" without a dam in the model now, a
      dash and "not in this run" for a dam the run didn't model, and after a
      capacity edit a line under the % naming the run's capacity ("of 150 000
      m³ in the run"). Then drains into,
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

  - **Node sheet** (`edit=<id>`, the `Dialog` `side extraWide` variant, 920 px,
    three fields to a row, the whole width on a phone): "Edit *name*" ("*name*: details" for a
    viewer), the node picker (‹ select ›, labelled "Node to edit") fixed in
    the dialog's sub-header above the scrolling form (so no control scrolls
    under it), then the one-node form (`NodeDetail`: every field with its help
    text, land cover, boreholes, the farmers note, Show on map (as the card's),
    Preview as farmer, make outflow gauge, remove) and a farm's Yield panel. It has no Move up /
    Move down (removed, issue #174): row order is for display only and the
    list isn't visible from the sheet; the node table reorders (drag, ↑/↓,
    Sort by flow path). The save row
    (`ModelSaveRow`: status, reason, Discard, Done, Save changes) is pinned
    under the form. ‹ ›, the picker and a tap on the map move it to another
    node (replacing `edit=` in place); Done, Esc, the ✕ or Back close it.

  Every field of the old Table and One node layouts is a click away (Edit,
  Tables → Node table), so nothing was removed.
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
  a farm and a run; component state, not kept in the URL, so no old link can
  name a removed mode). Rules in
  `network/farmColour.ts`; each mode gives every farm a band, the words for its
  second label line, the legend entries and a caption sentence, so nothing is
  colour-only (the words are also in the node's tooltip and the drainage-tree
  text):
  - **Supply, latest run** (the default once there is a run): the newest
    run's summary (`api.runs.get`, sharing the Runs tab's `detailCache`; a
    quiet status chip over the map's top-left corner covers loading, and a
    failure offers Retry there; it lies over the drawing rather than in the
    card's header, where at 1280 px it wrapped the header and moved the map
    when the load ended, `network-map.spec.ts`) banded by
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
  - *Irrigated area* was a third mode until issue #174: its three bands were
    thirds of the largest farm's area, arbitrary cut-offs, and Crops & demand
    and the node card already show each unit's hectares. With it gone the
    control needs a run, since both modes read one.

  The caption names the run ("… in run “test”, ran today"; with unsaved
  edits it adds that the colours show the run, not the edits). The **All
  nodes** list's dots take the same bands (hollow for no dam / no demand). Gauges and other water users are never coloured.
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
- **Paste from a spreadsheet:** the node table takes a block copied from Excel, previewed
  before it's applied, and gives the table as a CSV to fill in ([§ Grid modal](#grid-modal)).
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
  reach above the scrolling form in the sheet's fixed sub-header. Each
  section (Catchment area, Dam, Routing, …, Supply, Individual boreholes,
  Land cover) is a bordered card with its title in a tinted header band, so
  one section's fields don't run into the next's; the card itself stays
  `--surface`, since read-only inputs are `--surface-2`.
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
  (`UserFields.svelte`, `users.ts`). **Pump capacity** (m³/day, engine ≥
  1.58.0, [model.md §2.7c](./model.md)): blank is no limit, 0 no river pump;
  *Number of pumps* × *m³/h per pump* × 24 fills it, as on a unit's Supply
  fields (only the m³/day is stored), and the note under it says what the
  value means (for a senior user, that the units upstream pass no more than
  it for the user). The one-line summary adds "pump N m³/day" when set. A
  user's Supply group (a stale supply rule left from a farm) no longer shows
  the river pump field: the user's own is under "Other water user". The one-node form shows the same fields
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
- **Development over the run** (engine ≥ 1.30.0, issue #67, [model.md §2.7g](./model.md)),
  one-node form only (`DevelopmentFields.svelte`): under the dam survey and
  releases, **Capacity over time** with **Survey date**, **Sediment** (% of
  the capacity a year, 0–20 %, empty = none) and **In service from**; and
  **Abstraction starts** in a farm's Irrigation group and under "Other water
  user". Each is a date input (empty = null: the whole run, or not recorded)
  with its help tip and field-history line. The client check
  (`developmentIssue` in `model/validate.ts`, the engine's
  `developmentProblem`) mirrors the API and shows its message beside the
  fields: a rate needs a survey date, the dam fields only on a farm, no
  abstraction start on a gauge. A node without a dam, or turned into a user or
  gauge, that still carries them shows them so they can be cleared
  (`hasDamDevelopment` in `fields.ts`). Not in the table.
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
  pump capacity. A farm on river first or dam, river when low that also has
  **River to dam** (the diversion into the dam, under Routing) gets a note that
  the run counts the two as separate pumps, so one pump doing both jobs needs
  its capacity split between them (`sharedPumpHint`; with River to dam by
  month, any month above 0 counts, `diverts`). Under them, **Hands-off flow**
  (engine ≥ 1.32.0, issue #204, [model.md §2.7h](./model.md)): **Leave a set
  flow in the river, by month** opens twelve m³/day fields (Oct–Sep, with
  **Use October’s flow for every month**; unticked = none), and **Also leave
  the EWR in the river** keeps the EWR required at the farm too. A line under
  them says in plain words what the farm leaves and before which of its takes
  (`handsOffPreview`, `handsOffTakers`): no hands-off flow (senior users only,
  not the EWR), else the amount ("150 m³/day", or "between 150 and 12 345.5
  m³/day by month", every figure as entered) with the months without one, the
  EWR, or the larger of the two, before only the takes that apply: the river
  pump (any rule but dam only, unless its capacity is 0), River to dam (on a
  farm with a dam), or, on a farm with no dam, what it irrigates straight from
  the river (what is routed to its dam). Where none applies (dam only with no
  River to dam) it says the flow changes nothing. The save rules (farms only,
  12 values none negative, `operatingIssues` in `lib/model/validate.ts`, a
  test holds its kind rule to the engine's) show as alerts under the section.
  A farm turned into a gauge or other user keeps the section while it still
  has supply or hands-off settings (or River to dam by month, with a **Clear
  River to dam by month** button beside the alert, since Routing is gone), so
  they can be reset. The two boxes' help tips sit beside their labels, not in
  them, so each box's name is its words alone. Read-only for viewers (no
  calculator).
- **Month fields** (`network/MonthFields.svelte`, `network/monthFields.ts`):
  every twelve-month row of the one-node form (the dam release, a demand
  object's demand or profile, an other water user's demand, the hands-off flow
  and River to dam by month) is the one component: a caption naming the group
  (its help tip beside it, outside the name), an optional **Use October’s …
  for every month** button on the caption line, and twelve fields, each with
  its month shown above it and an accessible name of its own ("Demand of Town
  in Oct, m³/day"). The fields wrap by the room the group has (a container
  query, not the viewport): six to a row in the node sheet, four on a phone,
  three on the narrowest, all twelve in one row only from 70rem, where each
  still holds 12 345.5 whole. It never scrolls sideways, and the fields have
  no spin buttons (the arrow keys still step them), so 12 345.5 and 0.0129
  show whole for owners and viewers alike (`supply.spec.ts` checks
  `scrollWidth ≤ clientWidth`, ui-playbook § 2). What an edit and the fill
  button write (`withMonth`, `fillFromFirst`, a cleared field as 0, or 1 for
  a profile) is in the `.ts` neighbour, unit-tested.
- **River to dam by month** (engine ≥ 1.32.0, `RiverToDamFields.svelte`),
  one-node form, farms, under **River to dam** in Routing: **Set River to dam
  by month** opens twelve m³/day fields (started from the one value, with
  **Use October’s capacity for every month**); while it is on, the one River
  to dam field is read-only with the hint "Not used: River to dam is set by
  month below", and a line gives the capacity ("up to 800 m³/day", or
  "between 800 and 12 345.5 m³/day by month") and names the months it takes
  nothing in (`divertMonthsPreview`). Unticking it goes back to the one value. River to
  dam's own hint says what it leaves in the river: senior users' demand, and
  the hands-off flow under Supply when there is one. The months are edited
  only here: on a farm set by month the node table's River to dam cell
  (`NetworkTab.svelte`, desktop and phone card) has no input for the one
  value the run ignores, but the months' range, read-only ("by month:
  0–800", `divertMonthsCell`), which in the catchment's Node table grid links
  to the farm's form (`?tab=network&edit=<id>`); in a scenario's override
  tables it is plain text. A farm with the one value edits it in the table as
  before.
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
  with the crops). Each has a **Name**, **Category**, **Source of the
  number** (engine ≥ 1.56.0, issue #54 Q11, `demandObjectSource.ts`: Not
  recorded, the default; Meter records; Reconciliation strategy's AADD;
  Population × litres a day (a norm); Other), **Demand given as**
  (m³/day by month, or a count × litres a day; picking meter records or an
  AADD sets it to m³/day by month and a norm to a count × litres, and locks
  it with "Set by the source." under it; Other and Not recorded leave it to
  the modeller), **Priority** (first / with the
  crops / last), **Destination** (used in the catchment, or piped out, which
  sets and locks the share returned at 0 %), **Share returned** (%),
  **Modelled** (off keeps it on record only), a 12-month row (the demand in
  m³/day, or the per-unit profile, blank = 1), and **Source details** (the
  note: which meter and years, which strategy, which norm). Per unit: **Number of** people / head / units, **Litres per** person
  / head / unit **a day** and **Distribution losses** (%). A domestic or
  municipal object has **People served** (engine ≥ 1.44.0, issue #123, blank =
  the number of people when it is sized per person, "none" when it is m³/day
  by month) for its basic-needs floor, with a hint under it saying which
  number a blank field counts. The line below gives
  its mean m³/day as the engine sizes it, and for a domestic or municipal
  object a second line (`demandObjectFloor.ts`) gives its **Basic-needs
  floor** (m³/day, 25 litres a person a day, and whose people it counts),
  says "at least its whole demand" when the floor is as large as the most it
  asks for in any month (the engine's day floor is MIN(floor, demand)), or
  says it has none until its people are entered; **Use October's demand for every
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
  one without) and returned (or "piped out"). When an object has a
  basic-needs floor (engine ≥ 1.44.0), three more columns: **Per person**
  (l/day supplied at the tap, beside Supplied %: the municipal restriction
  level, for display), **Basic-needs floor** (m³/day) and **Below the
  floor** (the days, with the mean m³/day below it on a second line, stacked
  so the table keeps its width); "–" on an object without one, which the
  intro says means no floor (`HumanImpactTables.test.ts`,
  `e2e/tests/demand-objects.spec.ts`). When an object records its source
  (engine ≥ 1.56.0), a **Source** column after the name ("not recorded" on
  the rest) and a line above the table giving each source's share of the
  objects' demand, best source first ("Of their demand, 60% is from meter
  records, 30% from a per-capita norm and 10% not recorded.",
  `runs/demandSources.ts` over the engine's `demandBySource`, which the
  evidence report's § 6 shares, `e2e/tests/demand-source.spec.ts`); the summary
  CSV's demand-objects block gains a Source column the same way.
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
  saying why, for a farm with no dam). Viewers see the results, and the
  pattern and assurance for the preview below, with no run buttons.
- **Preview** (a dashed box, "Not stored"; issue #73, WP-3.6 through
  WP-1.17's preview worker): the firm yield for the pattern and assurance
  picked, worked out at once in the browser, off the main thread
  (`lib/preview/engine.worker.ts`, [architecture.md § Code
  splitting](./architecture.md#code-splitting-frontend)). It starts on open and again
  on each change of run, dam, pattern or assurance; a change mid-search
  stops the old one (latest wins). It shows the yield per day and year and
  the failure days and years at it, or the engine's reason it can't
  (`data-state` = `computing`, `done` or `error`, the e2e's signal). It is
  never saved: the stored results below it come only from the job, which
  **Work out the yield** queues. Viewers preview too. It runs on the input
  the job uses: the run's own stored input (`GET …/runs/:runId/model-input`,
  the last one fetched kept for the next dam), or under a scenario its saved
  ops applied to its base run's input, with the job's search (`prepareYield`,
  `firmYield`, the job's default tolerance 0.001), so on the same engine the
  number is the job's (e2e `yield.spec.ts` checks both). Where it can
  differ: the browser runs the web build's engine and the job the backend's,
  released separately (`web@` / `backend@`), so after a release of one and
  not the other the two may disagree by that engine change. So the preview
  names its engine ("on engine 1.34.0", `ENGINE_VERSION` from the engine's
  `version` module, the same build as the worker) beside the stored result's
  "(engine …)", and when the newest stored firm yield came from another
  engine it adds a note naming both (`engineDiffersNote` in `yield.ts`,
  `data-testid="yield-engine-differs"`). And a run from before migration 021 has
  no stored series, so the job refuses it (409) while the preview reads the
  project's current series when they are unchanged. Deliberately not offered
  for an application (an applicant's scenario, on the Applicant view or the
  owner's): the job applies it under the applicant mask, which only the
  server builds, and the input would include the farms the mask hides from
  the applicant (a contributor can't read the base run's input either);
  a preview there would need a server-side endpoint returning only the yield
  number, pending the client's D2 answer (issue #90, followups.md § Firm yield).
  Only the firm yield, not the curve (eleven searches).
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

## Map (`?tab=map`)

Issue #288, roadmap WP-3.12 phases 1–2, laid out as a Network-style
workspace in #326 (E3–E6, D3) (`lib/components/map/`, a lazy tab;
[maps.md](./maps.md) has the tiles, uploads, areas and the quaternary
lookup). It has its own sidebar row under **Build the model**, after the
Network (`lib/workspace/tabs.ts`; it was `LINKED_ONLY` until #326 D3, and the
sidebar's rows went to 32 px to keep a row to spare at 1440×960), and the
Network header's **Map** link and Settings → WR2012 check still open it. A
core tab: owners, editors and viewers see it (it becomes a results view with
A1); viewers get no edit tools. The Network's own picture (its "Catchment
map" card) stays the schematic; this is the geography.

- **Section header** (`fillHeader`; the header's "Map" is the page's only
  title): the context line "23 features · boundary 210.22 km² · 0 of 8 unit
  areas from the map" (`mapList.ts` `headerLine`; "Nothing on the map yet"
  when empty, "no boundary" without one), and the actions **Show everything**
  (frames every feature; with features), and for editors **Upload GeoJSON**
  and **Place a point**, each a link that opens its sheet. Slim notices
  under it: what an upload or a placed point did (Dismiss), the no-basemap
  note (owners and editors only), and "No catchment boundary yet" when there
  are features but no boundary.
- **Layout.** The map on the left and a side column on the right
  (`clamp(18rem, 30%, 24rem)`) once the page's container
  (`container: map-page`) is 56rem wide (784 px at the 14 px root);
  narrower, everything stacks: the map, the card, the list. With the side
  column and a window at least 620 px high the layout is a dashboard: exactly
  the height left below its measured top, less the 1rem gutter and the save
  bar (`--dock-h`); the map fills its card, the list scrolls inside its own,
  and the page doesn't scroll. Without WebGL the map says it can't be drawn
  and the list does everything; when the tiles can't be read the map drops
  them and says so.
- **Map** (`CatchmentMap.svelte`, its own chunk, then `maplibre.ts`): the
  boundary (long dashes), parcels, dams, rivers, other features (dotted),
  points as 28 px buttons told apart by shape; clicking a feature picks it.
  Under it one key line grouped **Areas** (catchment boundary, parcel, dam,
  other), **Lines** (river) and **Points** (gauge, dam, other), each swatch
  drawn in the colour `mapStyle.ts` `overlayColours(dark)` gives the map
  (`mapList.ts` `keyGroups`; no colour is written in the tab), following the
  app's theme (`appTheme.ts`: `data-theme` and the OS preference, live). A1's
  measure picker goes in the key's row.
- **The picked feature's card** (top of the side column): its name, Kind,
  Area (or Position, or Shape for a line), **Stands for** (a select of the
  nodes of fitting kinds for editors, else the node's name), **Unit’s
  area** for a parcel or "other" polygon that stands for a hydrological unit
  (its area *typed*, **From the map** this feature, or from another feature
  by name), **Area into the model** (editors; parcels and `other` polygons
  only, never a dam or the boundary): a unit (the linked one by default; the
  select stops at ~16rem) and **Use 9.257 km²**, which asks first ("Set
  Upper farm’s area from the map?", the old and new area) and then saves the
  area to the model, recorded in History with the feature named; disabled
  while the model has unsaved edits (a line says why) and reading **In use**
  when that feature's area is the unit's. **From**: the file it came in.
  **Delete** (editors) asks first. With nothing picked: "Select a feature on
  the map or in the list to see it here."; with nothing on the map, the one
  empty-state line ("Nothing on the map yet. Upload a catchment boundary …
  or place a point."; D4 makes it lead with drawing).
- **Features** (under the card): every feature grouped by kind, parcels
  first, then dams, gauges, rivers, other and the boundary, each group
  largest first, then by name (`mapList.ts` `groupFeatures`). A row is a
  button (`aria-pressed`) with the name and, under it, the size or
  position, what it stands for ("linked" when that's its own name) and, for
  a parcel, its unit's area source ("area typed", "area from the map"). A
  pick far down is kept in view inside the list, never by scrolling the page;
  stacked on a phone, a pick from the list brings the card into view. The
  head's **Every feature** opens the grid.
- **Checks** (A4, under the list, viewers too): one line, never growing, with
  the count ("1 warning from the map’s checks") and **Show the checks**, or
  "The map’s checks found no problems."; the warnings themselves open in a
  side sheet, **Map checks** (`checks=1`), each with buttons that pick its
  features and close the sheet ([maps.md § Checks](./maps.md#checks)). The
  line keeps a thirty-unit catchment's list its room.
- **Every feature** (`grid=map-features`, a full modal drawn by the tab:
  `TAB_GRIDS` in `lib/workspace/overlays.ts`, since map features save one by
  one rather than through the model's save row): a table in the list's order
  with Feature (picks it and closes the modal), Kind, Area or position,
  Stands for, Unit’s area, and for editors Area into the model and Delete
  (the same controls as the card); "Areas are computed on the server from
  each polygon (geodesic, WGS84)."; **Where each hydrological unit’s area
  came from** (every unit, including those with no parcel, with the count
  "n of N from the map", and the link to Settings → WR2012 check); and
  **Imported files**. In a narrow modal each row becomes a labelled card.
  `?tab=network&grid=map-features` (any other tab) lands on the Map with
  it open.
- **Upload a GeoJSON file** (`upload=1`, a side sheet, editors): what the
  file holds (each kind with what it takes), the file (WGS84, at most 5 MB;
  a `.zip`/`.shp` is turned away with how to export GeoJSON from QGIS),
  **Upload**. A refused file lists every problem by feature and imports
  nothing, and the sheet stays open; a taken one closes the sheet and picks
  its first feature. Under the form, **Imported files**: each file with its
  feature count, date, who imported it and its SHA-256 cut to 12
  characters (the full hash in the tooltip) with **Copy**. D2's review table
  goes here.
- **Place a point** (`place=1`, a side sheet, editors): kind (gauge, dam,
  other), name, latitude and longitude in decimal degrees ("-33.61" or
  "33.61 S", a decimal comma taken), and what it stands for. Errors show
  under each field on submit; a saved point closes the sheet and is picked.
  (D1 replaces this form with click-to-place.)
- **URL.** `feature=<id>` picks a feature; `node=<nodeId>` picks that
  node's farm parcel (the largest), else its first linked feature
  (`mapList.ts` `pickedFeature`), so the Network and results can link "Show
  on map". A pick is a history entry (Back undoes it) and replaces `node`;
  saves in a sheet and picks from the grid replace in place. Closing a
  sheet or the grid drops its parameter in place; a viewer's `upload=1` or
  `place=1` is dropped. Old aliases `?tab=gis` and `?tab=catchment-map`
  still open the tab.
- Tested in `e2e/tests/catchment-map.spec.ts`: the golden path, the URL
  picks and Back, a viewer, thirty units (fits 1440×960, the list scrolls in
  its card, a linked pick in view, the phone stacks with no sideways
  scroll), axe light and dark, wide and phone, with the grid open too.

## Crops & demand

The answers first, the crop grids one click away (issue #17, option A · A3;
`components/crops/CropsTab.svelte`). Built to hold a real catchment's crops
and units, and 30 crops on 20 units, without pushing the results off the screen:

- **Header:** "Crops & demand", one line ("4 crops · 312.5 ha irrigated on 6
  farms · water year October to September", `cropsSummary`), and on the right
  a **Tables** menu (Crop factors, Planted areas → the
  [grid modal](#grid-modal), `grid=crop-factors|planted-areas`; Escape
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
  bottom, "Other" on top (`MonthlyBars`, drawn at the card's
  measured size so its text isn't scaled; its legend's height is measured
  after each render and taken off the plot). Hovering a segment names the
  month, crop and value. The annual volume, mean m³/s and peak month sit
  under it. **Show table** opens the demand table (`crops/DemandTable.svelte`:
  the formula, m³/day per month, the mean and Mm³/a per unit and for the
  catchment) in place; `#crop-demand-table` opens it from a link. The
  Irrigation demand grid (`grid=demand`), a modal with the same chart and
  table, was removed (issue #174): an old link goes to `?tab=crops#crop-demand-table`
  (`movedGridHref`). An alert says when A-pan isn't set (demand is then
  zero). The preview multiplies the monthly A-pan means; when the project
  has a daily A-pan series, which runs use instead on the days it has a
  value ([model.md §2.3a](./model.md#23a-daily-a-pan-evaporation-engine--0380-issue-45)),
  a line under the heading (and the chart's accessible name) says the chart
  shows the monthly means and a run's demand differs, and with no monthly
  means set the alert says runs still take the daily series
  (`demand.ts` `demandApanNote`, issue #173; the page passes `apanDaily`,
  as does scenario override mode's demand preview). The preview doesn't average
  the daily series itself: which days a run covers depends on its rain
  window and zero-rain handling (`prepareRun`, model.md §2.3a), which this
  page doesn't load, so any average here would still differ from a run's;
  a run's own demand is on its results.
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
crop factor, Jan", as in the grid), the high-factor warning for
this crop, the × A-pan, not FAO Kc note, and which farms plant it and how
much. **Remove crop** asks first when the crop is planted anywhere, removes
it with its areas, and closes the sheet. The Edit button that opened it went
with its row, so the focus moves to the Edit button now in that place in the
list (the next crop's, or the last one's), or to **Add crop** once the list is
empty (`CropSheet` `onremove`, `CropsTab`'s `removed`). It edits the shared `ModelEditor`
and, being modal, carries the save row (`ModelSaveRow`); a viewer gets the
values read-only and Close. `Dialog` `side`, full width on a phone.

### Crop grids

The old tab body is `crops/CropGrids.svelte`: crop factors (no mean column
since issue #174: an unweighted 12-month average the b023 workbook doesn't
have, which read as a figure it isn't; reorderable, the × A-pan intro, the warning naming every crop and month
above 1.0: `highCropFactors`, a hint, never a block on saving), planted areas
in **ha** (stored as m²; farm rows in network order, reorderable; the
no-planted-area note) and the demand preview (chart and `DemandTable`).
`CropsTab` with a `sections` prop renders it: the grid modal passes one
section (crop factors or planted areas), scenario override mode (`scenarios/OverrideEditor.svelte`) all three,
inline, on the scenario's model, so neither the crop sheet nor the page's
overlays ever edit the catchment from there.

### Load crop factors

**Load crop factors…**, under the crop-factor table of the [crop
grids](#crop-grids) (editors only: Crops & demand's **Tables › Crop
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
  browser.
  **A node-based workbook** is the third source: its [Crop_Factors] and
  [Crop_Areas] sheets, read by the same worker
  (`spreadsheet/import/nodeCrops.ts`, `readNodeCrops`, which parses only
  those two sheets). Its factors are FAO-56 Kc values (against ET₀); its
  efficiency column isn't loaded (a crop's efficiency changes only through
  the system select below), nor are its farm areas. For
  either workbook, the dialog lists what the reader flagged as text under
  the file: for a node-based workbook, a missing sheet (a b023 file picked
  under this option), names that differ between the two sheets and cells
  read as 0; for a b023 workbook, the import report's
  `crop-factors-copied` and `crop-factors-suspect` warnings.
- **Pan coefficient Kp** multiplies the source factors. It starts at the
  source's default by the shape of its factors (`SOURCE_KINDS`, `defaultKp`
  in `loadFactors.ts`, issue #289): **1** for A-pan factors (the library,
  b023), **0.75** for an FAO-56 Kc set (the node-based workbook), which is
  set against reference ET₀ while the engine multiplies crop factors by
  A-pan (FAO-56 Table 5 gives a Class A pan's Kp as 0.35–0.85; 0.75 is a
  mid value). A line under the input says which and why, linking [FAO-56
  Table 5](https://www.fao.org/4/x0490e/x0490e08.htm). Changing the source
  re-applies the new source's default only while Kp is still the previous
  default (or blank); a Kp the modeller typed is kept (`kpForShape`), and
  **Use the default, N** puts the default back.
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

- **From:** the Summary's Needs attention (a single farm with nothing
  planted) and Supply by hydrological unit (a unit's name), the Network (on the Map, a farm's card
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
outflow gauge**), `crop-factors` and `planted-areas` (the
[crop grids](#crop-grids), through `CropsTab`'s `sections` prop) and
`transfers` (the Transfers tab). Done, Esc, the ✕ or Back close it; closing drops `grid` from
the URL in place (`withoutParam`). It isn't opened over the grid's own tab
(`GRID_TAB`), where the grid is already on the page: the parameter is dropped.
The node table and the crop grids have no such tab (`GRID_TAB` null: the
Network is a map and Crops & demand cards and bars), so they open anywhere
but the Scenarios tab, where no grid opens even when the URL names one: the
modal edits and saves the catchment's model, and override mode there edits
the scenario's ([§ Scenarios](#scenarios-tabscenarios)).
A tab's own grid (`TAB_GRIDS`: the Map's `grid=map-features`, which isn't
the model's) uses the same parameter but is drawn by its tab, not this
modal: the page leaves the parameter to the tab, and over any other tab
the link goes to that tab with it open (`movedGridHref`;
[§ Map](#map-tabmap)).

- **From:** the Network's and Crops & demand's **Tables** menus, and Crops &
  demand's **Edit areas**. More screens will link to it as they simplify
  (the #17 checklist).
- **Editing:** the grid edits the shared `ModelEditor`, so its edits show on
  the tab it comes from and the other way round, and the tab's problems list
  shows above it (`IssueList`). The modal hides the save bar, so it carries
  the same save row as the farm drawer (`ModelSaveRow`): status, reason,
  **Discard** (the save bar's), **Save changes** (the page's save), **Done**. A viewer gets a read-only grid
  and **Close**.
- **Paste from a spreadsheet** (issue #285): the node table and the
  planted-areas grid take a block copied from Excel. Pasting more than one
  cell into any of their inputs (a tab or a line break in it; one value stays
  the input's own paste) opens **Paste into the node table** / **Paste
  planted areas** (`model/GridPasteDialog.svelte`) with the block in its box;
  **Paste from a spreadsheet…** under the grid opens it empty, to paste,
  type or **Load a CSV file**. **Download the table as CSV** is the grid as
  it is now (names, then each column with its unit in brackets; a % as
  0–100, areas in ha; formula-like names defused, `docs/security.md`), the
  template to fill in. The block is read by `lib/spreadsheet/paste/read.ts`,
  the same reader as the Reserve rule tables' paste (`ewrRules.ts`
  `parseGrid`): tabs, semicolons or a CSV, grouping spaces dropped. A comma
  in a number is decided once for the whole block (`read.ts` `blockCommas`),
  since a spreadsheet copies numbers as it shows them: a cell that can only be
  a decimal comma (12,5, 0,75) makes it decimal, one that can only be
  thousands (1,500,000, 1,234.5) makes it thousands, both stop the paste, and
  a block whose only commas are single three-digit groups (300,000) stops
  with that cell ("300 000 or 300?") rather than guess. (The Reserve rule
  tables keep reading a comma as decimal.) Then
  `paste/grid.ts` `mapPaste` places it: a heading row puts each column where
  its heading says (case and a last bracket, the unit, ignored: "Dam
  capacity (m³)", "Maize (white) (ha)"; a heading the grid hasn't got, such
  as Total, is left out with a note); names in the first column put each row
  on the row of that name, in any order, ignoring case but not brackets, so
  "Farm A (east)" and "Farm A (west)" stay apart (a name the grid hasn't got,
  or two rows share, is left out with a note; a name that is only a number
  reads as a value, so such a block is placed by position); without names or
  headings the block fills the grid from the cell it was pasted into, in the
  grid's order, and says which cell that was (from the toolbar, or a cell
  of no value column such as Kind, the first row's or that row's first
  column, and it says so). A blank or a dash leaves a
  value as it is; a value that isn't a number, a negative, or a % above 100
  stops it with the row and column. The node table leaves out values for a
  field the node doesn't use (a gauge's dam, any field of an other water
  user, River to dam set by month) with a note (`network/nodePaste.ts`); the
  planted-areas grid reads hectares, and 0 clears an area
  (`crops/areaPaste.ts`). The **Preview** lists every value that would
  change (row, column, now, pasted) and counts those already equal;
  **Apply N changes** writes them into the editor, unsaved, as if typed, and
  the grid's save row saves or discards them. The result is one status line
  whose text changes (read out each time), and the list of changes scrolls
  in its own focusable box. Escape or Cancel closes it and hands the focus
  back; it isn't in the URL, so Back closes the grid modal under it, as
  **Load crop factors…** does. Viewers get neither.
- **Layout:** the `Dialog` `full` variant with `keepInputs` (the grid's inputs
  keep their own widths; other dialogs stretch text fields to the dialog's
  width). The grid scrolls inside the modal; the title and the save row stay
  put. On a phone (≤ 640 px) a `full` dialog takes the whole screen, and the
  grid shows its phone layout (cards).

On a phone (≤ 640 px) the crop-factor and planted-area grids (in the grid
modal and override mode) turn each row
into a card with visible labels: the crop name (with reorder and remove) on
top, the twelve factors four to a row; each farm's crops two
to a row with its total, and a totals card last. Every field is on screen
without scrolling the table sideways. The read-only demand preview stays a
table that scrolls. With no farm or crop yet, the Planted areas note links to
the Network tab. The node table does the same, one card per node (§ The
node table above).

## Transfers

The rules under the section header, which counts them ("3
transfer rules · 2 active", `workspace/context.ts`) and carries **Show on the
map** (the Network, where transfers are dashed arrows) and **+ Add transfer**
(editors, with at least two units). A new rule starts after the existing ones
(the highest priority + 1), and the cursor lands in its **From**, scrolled into
view.

**Transfer rules** is one card per rule (`transfers/TransfersTab.svelte`),
in a list that grows with its rules. Each card's **head line** holds its
number ("Transfer N", a heading, with an **off** pill when the rule is
switched off), **From → To** (two selects), an **On / Off** switch (a
checkbox with `role="switch"`, named "transfer N enabled", its state in words
beside it and part of the tap target) and **Remove** (named "Remove transfer
N (From → To)"). Remove asks first (the app's confirm dialog) once the rule
has a rate in any month, since its rates and limits go with it, and says
Discard on the save bar still brings it back until the model is saved; a blank
rule goes at once. Focus moves to the next rule's heading (the previous one's
for the last). An off rule's card is tinted, with a neutral edge instead of
the accent one, and says **off** in words (not faded text). Where the card is
widest (1280 and 1440 windows) the head line is a column on the card's left
instead, level with the rates: the number, From over To, then the switch and
Remove.

The card's body holds three top-aligned groups:

- **Max rate by month** (engine ≥ 1.14.0, `transfers/MonthRates.svelte`):
  twelve m³/s fields in water-year order, six to a row (four in a phone's
  card, all twelve in one row where the group is 58rem wide), each wide
  enough to show 0.0129 or 12.345 whole, with tabular figures; a blank month
  is off (the title says m³/s; "blank = off" is in the fields' group name and
  each blank field says *off*). On the title's line, at its right, the months
  in words with the largest rate, and **… in every month**, which puts the
  largest rate in all twelve (both to four decimals, so the button names the
  rate it copies); they wrap under the title only where the group is too
  narrow for both. A workbook rule with one
  rate in its ticked months shows that rate in each of them and runs as
  before; the first edit gives it its own rate per month (`monthlyRateM3s`,
  with `months` and `maxRateM3s` kept in step).
- **Limits**: an optional daily cap (m³, blank = none) and the **Priority**, a
  whole number, lower moves first; equal priorities share a source dam pro
  rata to their limits ([engine-audit Q18](./engine-audit.md)). The help
  explains the destination's room cap (N4).
- **Source**: **Takes from** (engine ≥ 1.14.0): *The source’s dam*, with the
  minimum source-dam storage (%) below which it stops, or *The river (an
  off-take)* ([model.md §2.6a](./model.md)), whose fields replace the minimum:
  how much it takes (*What the destination needs* or *Up to capacity*, like a
  canal that runs full), a hands-off flow (m³/day, blank = none), the losses on
  the way (%), the share of those losses seeping back to the river (%, engine
  ≥ 1.42.0; 0 = none, the default) and, once that share is above 0, where it
  rejoins the river (*The source* or a hydrological unit downstream of the
  source along the river; a saved unit that no longer qualifies shows as *not
  below the source*, and the model check refuses it), and switches for leaving
  the EWR in the river and topping up the destination’s dam. The fields sit
  two to a row, not one tall column.

Every field keeps its visible label and its ⓘ tip. The groups sit side by
side where the card is 70rem wide (1280 and 1440 windows), beside the head
column; there the Limits and Source titles are dropped (dividers mark the
groups and every field names itself), a dam source's two fields stack in a
narrow column and a river off-take's sit two to a row. A rule on a dam is
147 px tall at 1440 (the table's row was 120 px; the first cards were 225 px,
so thirty rules scrolled twice as far), 173 px at 1280 when its summary
wraps. From 46rem the
rates sit beside the limits with the source across under them (the grid
modal, narrow windows); below that (a phone) everything stacks, From and To
each take a full row with their word, the source's selects take the card's
width, and the fields, switches and buttons are 44 px tall. Thirty rules fit
at 1280 × 800 with nothing scrolling sideways.

The page is a reading page, not a window-sized dashboard: the list grows with
its rules and the page scrolls as one, with no scroll box inside it. Two
rules make a short page; thirty make a long one. There is no month chart: the
old **When water moves** card summed each month's rate × 86 400 across the
enabled rules, which restated the rate fields in the row above it, added up
routes that have nothing to do with each other, and was only an upper bound
before the dams' own limits, so it looked like a result without being one
(removed 2026-09-29). The empty state says what a
transfer is (most catchments have none) and has its own **Add transfer**; with
fewer than two units it links to the Network tab.

The rules were a wide table until 2026-09-29: its **Takes from** cell stacked
a river off-take's six fields in one column, so that row stood ~330 px tall
with every other cell floating in its middle, and the month fields clipped
0.0129 to "0.012". Cards with grouped fields replaced it
(`transfers-page.spec.ts` pins the groups' shared top line, whole rates, the
off state and Remove).

The Network's **Transfers** grid (`grid=transfers`) and scenario override mode
show the same cards, with **+ Add transfer** under them.

## On this page menu

The long workspace pages share one in-page menu, `common/SectionNav.svelte`
(its rules in `common/sectionNav.ts`): **Settings & calibration**, **Runs &
results**, **River & reserve**, **Hydrological units** and **Data**. Each page
gives it its sections in groups (a `nav` labelled "Settings sections",
"Result sections", "River sections", "Hydrological units sections", "Data
sections"); each group is a list named for screen readers. With
`groupNames` the bar shows the names too: a small muted label before each
group's first link, in the same item, so the two wrap together and the fit
counts both, and a wider gap before it. Without it the links are evenly
spaced: a wider gap with no name on it read as a spacing bug (issue #162).
Hydrological units and Data show their names. Settings & calibration, Runs
& results and River & reserve don't, and space their links evenly: with the
names, Settings' links no longer fit two rows at 1280 px, Runs'
last links went into More and River's bar took a second row at 1440 px (in
CI's fonts, which set text a little wider than a dev laptop's). The dashboards that fit the window (Network, Crops,
Scenarios), the Summary (short once its lists fold, 2026-09-29), Dams (one card list beside a sticky chart) and the pages with at most two panels past their
first screen at 1440×960 (Transfers, one card; Allocations, Project, Compare
runs, Applications) have none (surveyed 2026-09-27 with the example catchments); History is left
to its own redesign.

- **Two rows at most** from 641 px. The links flow like words, so a group
  may break across rows; laid out as whole blocks, a long group pushed the
  next onto a row of its own, and Runs & results took three rows at 1280 px
  with Summary alone on the first. What still doesn't fit goes, in page
  order, into **More** at the end of the bar (`navFitCount`, from a hidden
  copy of every link measured both plain and marked, the wider of the two,
  with More's own trailing gap counted like every link's, refitted when the
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
  or the last at the bottom of the page, unless the section the URL's
  fragment names still starts on the screen there: a followed link to a
  panel whose followers are shorter than the window stays marked, issue
  #175), and raises the page's
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
  the series and those behind ("5 daily input series · 2 behind",
  `workspace/context.ts`), then the Rain up to pill, **Preview all data**
  (filled through `fillHeader`; absent with no series) and **Add data**, the
  main (primary) action for editors. The tab's own notices (new data since
  the latest run with its *Re-run the model* link, a feed rebuilding a
  series, a failed delete or relabel) are slim lines under the header, like
  the page's. The series table's panel has no summary line of its own: one
  that read "Daily values · 5 series · 2 behind (more than 7 days old) ·
  recorded rain up to …" repeated the context line and the pill, and was
  folded into the context (issue #174); the table's key says what *behind*
  means.
- **Freshness first**: the table lists the series **behind** first, most
  days behind first, then the series a run reads, then the rest (another
  series of that kind is read, reference only), keeping the list's order
  within each group (`series/freshness.ts` `freshnessOrder`). *Behind* is
  exactly the sidebar badge's rule (`freshness().behind`): a series a run is
  driven by (recorded rain, daily A-pan) ending more than 7 days
  (`STALE_DAYS`) before the project's date; a forecast runs ahead and observed
  flow only scores a run, so neither is. Each such row carries a **Behind**
  pill beside its age and an amber edge and the key line says what it means,
  so the table, the header's "2 behind" and the badge always give the same
  count. **Data up to** is the column straight after the series; **From**
  after it gives only the first date (it was a *Period* start → end, whose
  end repeated Data up to, issue #174). (Until 2026-09-26 any row
  older than 31 days, flow included, was amber, which disagreed with the
  badge.) Ages read "2 months ago" from 60 days and "2 years ago" from 730
  (`agoText` in `lib/format/age.ts`; those two days used to read "1 months" / "1 years").
- **Picking a series**: clicking a row (or its **View** button) charts it
  through the URL (`series=<id>`, `withParam`), so the link can be shared
  and Back returns to the series before. Without `series=` (or with one that
  no longer exists) the observed flow a run reads is charted, else the main
  rainfall, else the first. Deleting the charted series drops the parameter
  (`replaceState`); an upload through **Add data** on this tab charts the
  uploaded series (`series=<id>`, `replaceState`, the page's `onUploaded`).
  The chart sits under the table, so after a pick it scrolls just into view
  (smoothly, unless the viewer prefers reduced motion; not at all when it is
  already in view, and not for the upload's `replaceState` pick).
- **Layout**: the page flows in the window's one scroll, and nothing on it
  scrolls inside itself (the table grows with its rows rather than the
  global 70vh table box; it would still scroll sideways if it had to). With
  more than seven series the table shows the first six in its order (four
  below 640 px, where each row is a card), then **Show all N series**
  (`aria-expanded`, `aria-controls="series-rows"`; open, **Show only the
  first 6 series**), which opens the rest in place (`common/fold.ts`
  `foldList`). The charted series' row always shows, after the first six
  when it sits further down, so a `series=` link or a pick never hides its
  row. The chart follows the table at a fixed 320 px plot; at 1440 × 960
  with 30 series the six rows, the button and the chart's head are on the
  first screen. Until 2026-09-29 a page 720 px wide and tall was fitted to
  the window: the table took up to 55 % with its rows scrolling inside its
  box and the chart filled the rest, so the panels below went unseen
  (`data-page.spec.ts` pins the flow, the fold and no inner scroller on
  desktop and phone). The gauge-vs-logger table, the double mass panel, Data checks and
  *What the model uses* follow below. *What the model uses* spans the page;
  its kinds (at least 22rem each, one column on a phone) are behind **Show
  what each kind of series is for** (a `<details>`, closed by default, issue
  #174), and its closing note, at a reading measure, shows either way.
- **On this page.** Once there is a series, a **Data sections** menu
  ([§ On this page menu](#on-this-page-menu)) sits under the header, above the
  table, and sticks down the whole page as it scrolls: **Series** (`#data-series`), **Chart**
  (`#data-chart`, with a series picked), **Gauge vs logger**
  (`#data-agreement`), **Double mass** (`#data-double-mass`), **Data checks**
  (`#data-checks`) and **What the model uses** (`#data-uses`), each only when
  the page draws it (`series/sections.ts`, `dataNavGroups`), in three groups
  named for screen readers (Series, Checks, Adding data). A loaded
  `?tab=series#data-…` link lands on its panel once it is drawn, held there
  (`holdAnchor`) with focus on its heading. The retired `#upload-csv` (the
  Upload CSV panel's id, `retiredDataAnchor`) opens Add data for an editor,
  dropping the fragment, and lands anyone else on the series.
- **Add data from the header** is the page's one upload form (the
  **Add data** dialog, `series/AddDataDialog.svelte`); the Upload CSV panel
  that repeated it below the series was removed on 2026-09-29. It refreshes
  the table at once: the tab takes the page's new series list when it
  changes (before 2026-09-26 the table kept its own copy until the page was
  reloaded). With no series, the empty state says to upload with Add data,
  and for editors its **Upload a CSV** button opens the same dialog; the
  upload takes the button away with the empty state, so focus goes to the
  *Input time series* heading when the dialog closes.

Each series shows its role in the model, its last date and age, its period,
% missing, a typical value (mean annual rainfall in mm/a, or mean flow), and
a strip showing coverage per year. Series a run won't read (not the first of
their kind by name) are marked. Editors can **Delete** a series (after a
confirm; runs already stored are not affected). A CHIRPS series shows which
product and version it holds (issue #40 part c): editors get a select
(*Version not recorded*, CHIRPS v2.0, CHIRPS sat v3.0, CHIRPS rnl v3.0) that
relabels it without touching its values (`PATCH …/series/:id`), viewers the
words. The **Add data** form asks the same for a CHIRPS file (*Not known*
by default, or the existing series' own label when appending to it); a
merge of another version into a filled series is refused by the server with
its reason. An observed or logger **flow** record also shows **where it was
measured** when the model has a gauge above the outlet (issue #64, engine ≥
1.4.0, [data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)):
editors get a select (*At the outlet*, or *At gauge &lt;name&gt;* for each such
gauge, `PATCH …/series/:id { siteNodeId }`), viewers the words. A record at a
gauge is badged *Gauge record (checks only)*: the run checks it against the
simulated flow there (Runs & results → Plausibility checks), and it is never
the outlet's record, whatever its name (the outlet's EWR test, the *What the
model uses* badges and the setup checklist read only the outlet's; a gauge EWR
site's own EWR test reads its record, engine ≥ 1.41.0). When Settings → Calibration record → *Scored at* picks its
gauge (engine ≥ 1.41.0), it is badged *Gauge record (calibration site)*
instead: Fit automatically and a run's calibration statistics score it ([model.md
§2.10k](./model.md#210k-calibrating-at-a-gauge-inside-the-network-engine--1410)). A record whose gauge has left the model says
so, until it is moved. **Source and unit** (issue #66, 107,
[data-model.md](./data-model.md#series-source-and-unit-107_series_sourcesql)):
a row whose series records a source, or was converted at upload (uploaded in
l/s, ML/day …), says so under its name ("DWS X1H001 · given in l/s (× 0.001
to m³/s)"); a series uploaded in the stored unit with no source adds nothing,
so the table stays one line a row. **Fed series**: a row a data feed wrote
days of (`SeriesMeta.feed`, `time_series.feed_id`, 031) says so under its
name, *Written by the CHIRPS daily rainfall feed* (the source's label), or
how many days when the feed wrote only some of the days with a value (*312
days written by the CHIRPS daily rainfall feed*: the rest were uploaded or
imported, and the feed keeps them). Unlike the source, which records where a
new series first came from, the mark is live: it goes once a user's upload
has written over every day the feed wrote, or the feed is removed or
re-targeted (`frontend/src/lib/series/provenance.ts` `feedMark`). Under the chart, the charted series shows
its source and the unit it was uploaded in; editors edit the source there
(*Source*, saved on change, `PATCH …/series/:id { source }`), viewers read
it. The **Add data** form has an optional **Source** field (up to 200
characters; the existing series' own source when appending or replacing,
until typed over); the unit chosen is recorded with it. **Flow gaps**: when
Settings → Calibration record → *Flow gaps* fills the charted gauge or logger
record (engine ≥ 1.23.0, [model.md §2.10i](./model.md)), the days a run would
fill are shaded like the rain a run treats as missing, the filled values are
drawn as points (*Filled in a run*), and the caption says how many days were
interpolated and how many came from the donor record × its ratio, why a donor
was refused, and how many gaps stay open (`series/flowFill.ts`). **Quality
flags**: on a flow record a run reads (the outlet's gauge or logger record,
or the calibration site's record when calibration scores a gauge inside the
network), the days Fit automatically would flag (above
or below the record's gauged range, suspect, infilled; model.md §2.10h) are
strips along the foot of the chart with a key in words, as on the Runs
hydrograph, computed from the stored record under the current settings
(`recordFlowFlags`, so a gauge's record has no gauged range and no fill) and
naming what Fit automatically does with each class now. The alternative catchment gauge and the reanalysis (engine ≥
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
(series and role on top, then labelled Data up to / From / Missing (% of
days) / Typical (mean), the coverage strip, and the buttons wrapping underneath), so a phone
never has to scroll the table sideways; explicit table roles keep it a table
to screen readers, and the card labels are silent to them. Uploads (the
**Add data** form) read year-last dates (DD/MM/YYYY or
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
un-hidden, scrolled into view and highlighted. It shows Loading… while the
values arrive; a series whose values fail to load is named with the error and a
**Try again** (all of them failed: in place of the table; some: above it, the
column blank), never an endless Loading…. Number columns have right-aligned headers, so each value sits under its own header; the date and the Excluded column stay left-aligned. Alongside each series' own
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
(`series-preview.spec.ts`, with a11y scans at desktop and phone). This is a read-only view of what's already loaded. Each series' own
**CSV** download on its row carries the same checks and, from the latest run
that read the series, the columns that run used (docs/api.md § Export,
`backend/src/export/series-columns.ts`, issue #66).

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

**Audit workbook — *unit* (.xlsx)** follows each farm's daily CSV in the menu
(issue #68). It is the independent check: the farm's daily water balance,
F through AA, as live Excel formulas over its inputs, so Excel, LibreOffice or
Google Sheets recomputes the model itself, beside the model's own numbers and
a column with each day's largest difference ([api.md § Export](./api.md#export)).
It runs in the same worker, with the same progress line and Cancel. A unit
whose rules the formulas don't carry yet (boreholes, a release rule, a river
pump, off-takes, demand objects, senior users below, an allocation cap, a
storage reset, a survey curve, a daily A-pan series on a dam, a dam capacity
that changes over the run) gets "Workbook
failed: The audit workbook can't recompute *unit* yet: …" naming each, never a
file whose numbers disagree.

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
  `#set-fit`, `#set-wr2012`, `#set-share`, `#set-ewr`, `#set-reserve`,
  `#set-restrict`, `#set-period`, `#set-quality`, `#set-outcomes`,
  `#set-outlook`, `#set-evidence`, then one **Automation & access** link to
  `#set-auto`; listed by `settings/sections.ts`, `settingsNavGroups`), in
  three groups named for screen readers only, its links evenly spaced (the
  names on the bar would push links into More at 1280 px, issue #162):
  **Model inputs** (Demand … Data quality: its zero-rain and low-vs-CHIRPS
  limits change results, issue #173), **How results are read** (Outcome
  matrix, Seasonal outlook, Evidence: they change no result) and
  **Automation & access**. That last link stands for the four panels that
  run or connect by themselves: Automatic runs (`#set-auto`, last in the
  form), then after the form Data feeds (`#set-feeds`), API keys
  (`#set-api-keys`, owners only) and Scheduled reports
  (`#set-report-schedules`). They keep their own headings and ids, so a link
  to any of them still lands, and the group's link is marked while any of
  them is read; a Save blocker on any of them puts its dot on that link. One
  link for four keeps the bar's sixteen links in two rows at 1280 px in CI's
  fonts, which the drought restrictions link's nineteenth did not (2026-09-30,
  `section-nav.spec.ts`). It is the shared in-page menu
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
  shows), with "Unsaved settings", **Preview** (what the unsaved settings, and
  the model's unsaved edits, do to the last run; § Preview unsaved edits under
  Project workspace), **Discard** and **Save settings** (editors only). When something blocks Save it says how many groups have a problem
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
  below it the **Dam evaporation preset** picker (engine ≥ 1.49.0, "Fill
  from a preset…": flat 0.75, or the WR90 monthly lake factors converted to
  A-pan at this project's monthly A-pan by WR90's or Taljaard's 2023 pan
  equation; model.md §2.7a item 4). Picking one ticks **Vary it by month**,
  fills the monthly row and the **Dam evaporation factor source** note
  (`settings.lakeEvapFactorSource`, up to 600 characters, with a
  field-history line), then goes back to "Fill from a preset…"; all stay
  editable and nothing is saved until Save. A WR90 preset with any month's
  A-pan at 0 fills nothing and says "enter the monthly A-pan first"; one
  with a month below the conversion's floor (55.4 mm WR90, 38.5 mm
  Taljaard) fills nothing and names the months. When
  the note names a preset whose values at the current A-pan no longer
  match the row (the A-pan or a factor changed since), an amber note says
  so ("fill it again, or update the note"). The Pan-coefficient preset
  picker goes back to "Choose a preset…" after a pick the same way (it used
  to keep showing the preset),
  and, behind an **Advanced** disclosure (issue #174: 28.25 is kept for
  workbook parity and rarely changed), days in February. The closed
  disclosure's summary names the value ("Advanced: days in February,
  28.25") and adds "(not the default 28.25)" in amber when it differs, so a
  changed value is never hidden.
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
  years each was fitted on, that the fit ran under. Between the picker and
  the fit period, **CHIRPS quantile map** (`settings.chirpsQuantileMap`,
  engine ≥ 1.53.0, CR-23, off by default): a checkbox, "Quantile-map the
  CHIRPS that fills gaps onto the catchment rain (each month’s total
  kept)", and when on the **Wet day from (mm)** threshold (0.1–10, 1 by
  default; the one it was turned off with comes back until Save;
  `withChirpsQuantileMap` in `settings/rain.ts`). Disabled under raw CHIRPS,
  where the hint says the map needs bias correction and a run would ignore
  a saved one. A run with the map lists what it did in the CHIRPS warning,
  warns for the gap days in months it can't map, and outputs
  `rain_chirps_mapped`; Fit provenance shows whether the fit ran with it
  ([model.md §2.4b *Quantile map*](./model.md#quantile-map-engine--1530-cr-23)).
  Below it, **Zero-rain runs in the catchment rain**
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
  series** (engine ≥ 1.21.0, issue #66, off by default) adds the water
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
  series (`calibration/CalibrationWindowFields.svelte`), with, when the
  model has a gauge above the outlet with a flow record attached (or a site
  is already set), **Scored at** (engine ≥ 1.41.0, `settings.calibrationSiteNodeId`,
  model.md §2.10k): *The outlet* or each such gauge by name (engine
  `calibrationSites`; a gauge without a record is not offered, and a stored
  site that has lost its gauge or record shows as *A gauge no longer in the
  model, or with no record*). Its hint says the fit then scores the simulated
  flow at that gauge against its record, that the gauged ranges and gap
  filling are the outlet records', and that a run's statistics are scored
  there too while the outlet's EWR test stays the outlet's. A stored site
  whose gauge has left the model or has no record attached any more gets a
  warning under the select (runs score the outlet's record and warn, and Fit
  automatically refuses the site). The site's records decide *Compare with*'s choices, Fit
  automatically's validation record and whether a fit can start (a project
  whose only record is at the site can fit); the fit record's *Fitted to*
  names the gauge ("Gauge record at the gauge “Middle weir”") and says when
  the site has changed since the fit. And the
  **calibration exclusions** (`calibration/CalibrationExclusions.svelte`):
  "Exclude a water year" and "Exclude a date range" add a row, each with a
  required **Reason**. A water year shows the dates it covers ("WY 2015/16:
  2015-10-01 – 2016-09-30"). A blank reason, a reversed range or a period
  listed twice shows an alert and blocks Save (the save bar links here).
  Excluded days are left out of Fit automatically and the run's calibration
  statistics (model.md §2.10). Under them, **Quality flags for Fit
  automatically** (`settings/QualityFlagsFields.svelte`, helpers in
  `settings/qualityFlags.ts`; engine ≥ 1.22.0, CR-18/19, model.md §2.10h): for
  each calibration record the project has (both when not known), its
  **highest gauging** and **lowest gauging** (m³/s, empty = not known) and a
  **Source**, required once either is set; and four selects for what the fit
  does with **days above the highest gauging** ("Censor: only ask the model
  to reach the highest gauging (default)", "Leave out", "Score as
  recorded") and with **days below the lowest gauging**, **suspect days**
  and **infilled days** ("Leave out (default)", "Score as recorded"). A
  range without its source, or a lowest gauging not below the highest, shows
  an alert and blocks Save. An emptied range stores nothing.
    Then **Flow gaps** (engine ≥ 1.23.0, issue
  #66, `settings/FlowGapFillFields.svelte`, [model.md §2.10i](./model.md)):
  per observed record the project has (the gauge, the logger), a **Fill gaps
  in a run** switch, off by default; on, **Interpolate gaps up to (days)**
  (5), **Fill longer gaps from** (*No other record*, the other observed
  record or the reference gauge, marked *none uploaded* when missing), and
  with a donor **Longest gap filled from it (days)** (60) and **Fewest shared
  days for the ratio** (365). Whether a filled day is scored is the
  quality flags' **infilled days** select above (one control for the fit and
  the run's statistics). Each number is held inside its
  bounds by its field, so the section never blocks Save. The fit record
  below lists the fitted record's source and its gap filling.
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
    over the same columns, with how to read it in its foot (judge by the
    validation columns; the model should clearly beat the mean flow, and in a
    seasonal catchment the climatology; `fit-benchmarks-note`, a note at the
    panel's end until issue #174), and a warning sentence
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
    From engine 1.22.0 (CR-19), when the quality flags left days out or
    censored any, a **Fitted, all days (flags ignored)** column follows
    **Fitted**: the fitted parameters on every observed day, as recorded.
    Above the representativeness block, **Data quality of the scored
    record** (`calibration/DataQualityPanel.svelte`, rows in
    `calibration/dayQuality.ts`; engine ≥ 1.22.0, CR-22, model.md §2.10h,
    `data-testid="fit-data-quality"`): the heading's gist ("1 204 of 1 461
    observed days scored · 31 left out · 12 censored"), the record's gauged
    range and source (or that none is recorded), a table of the window's
    observed flow by flag (days, share, and in the fit: scored, censored at
    the highest gauging, left out, scored as recorded, no reading; "Not
    flagged (no gauged range recorded)" in place of "In the gauged range"
    when none is), a table of the scored days' rain by source (catchment
    gauge reading, infilled, missing, and zero-rain runs set aside among
    them), and a list of what the record can't support. How wet the scored
    years were is left to the block under it, whose heading carries the same
    gist (a line here repeating it was removed, issue #174). A report from
    before 1.22.0 has none of it.
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
    From engine 1.22.0 the record has a **Quality flags** row (the data
    quality gist and the gauged range), its score table adds **All days
    (flags ignored)** beside the in-sample column when the flags changed the
    days, and a change of a gauged range or of how flagged days are scored
    since the fit shows a **Quality flags changed since fit** badge with a
    caveat (model.md §2.10h).
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
  - **Calibration rules** and **Automated calibration** (engine ≥ 1.25.0,
    issue #153, [model.md §2.10j](./model.md)), under the fit record, each its
    own chunk. The rules (`settings/CalibrationRulesFields.svelte`, helpers in
    `settings/calibrationRules.ts`) show their **revision** and a **Draft** or
    **Signed off** badge, then: **Leave out a water year by its flagged days**
    (on, 20 %), **Keep the fit with the best** (a score) **on the held-out
    test** (dry → wet, split-sample or the other record), the **pan
    coefficients to fit under** (the project's own, the presets), **Bounds**,
    **Objectives**, the two **filters** a kept fit must pass, the search
    (**Model runs per fit**, **Starts per fit**, **Seed**: part of the rules,
    so another seed is a rule change), **When new observed or rain data
    arrives** (nothing, run the rules and keep the report, or also apply the
    kept fit while signed off), **After a kept fit is applied, run the model
    and the uncertainty ensemble around it**, and "*n* fits, each with the
    split-sample and dry → wet tests (at most 8)". An empty list or more than
    8 fits shows an alert and blocks Save (the save bar links to *Fit
    automatically*). **Your name, as a signature** with **Sign off these
    rules**, or **Withdraw the sign-off**, records the hydrologist's
    agreement: saving dates it and records their account in the History tab
    ("Signed off the calibration rules (revision *n*) as …"), and saving a rule
    change raises the revision and withdraws it (the server's rules). Viewers
    see the rules, disabled, with no sign-off controls.
    The panel (`calibration/AutoFitPanel.svelte`, helpers in
    `lib/calibration/autoFit.ts`) lists the **saved** rules, warns while they
    are drafts and says how many model runs their search makes. **Run the
    calibration rules** asks the server (disabled while the rules have unsaved
    edits, and for viewers); the latest run, whoever or whatever started it
    ("Started by …" / "Queued by new data"), shows "Fitting *i* of *n* on the
    server…" while its jobs run (followed every 1.5 s), then the notes, the
    water years left out by rule, a **Fits the rules tried** table (fit,
    *Kept* / *Passed* / *Not kept*, the held-out score, natural MAR, the
    filters, why not kept) and the kept fit's parameters. A run whose job
    stopped, or that failed, says why. **Apply and save the kept fit** asks
    the server to save it (disabled, with the reason, while the rules or any
    other setting have unsaved edits); the form then reloads the settings and
    the panel says who applied it and whether a run and an ensemble followed.
    The fit record then shows an **Automated** badge, **Picked by** (the
    rules' revision and sign-off, the kept fit of *n*) and **Left out by
    rule**, a caveat while the rules were drafts, and **Rules changed since
    fit** once they change.
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
  **Propose from the map** (editors; issue #288, [maps.md § Quaternary
  lookup](./maps.md#quaternary-lookup); `QuaternaryProposal.svelte`, its own
  chunk) looks up the quaternary at a point (the catchment boundary's centre,
  a gauge on the map, or typed coordinates) in the loaded quaternary dataset
  and lists its values (code, area, MAP, MAR, period, monthly means, source)
  beside what the form holds, each with **Use** (or *Same* / *Used*, or *Not
  in the data*). A used value goes into the form only; Save keeps it. A
  proposal from the committed synthetic dataset carries a warning that its
  values are invented; with no dataset loaded, or no quaternary at the point,
  it says so.
- **Flow share between hydrological units**: the method, and the **High/low
  MAP split** (High, Low, their Sum, amber unless 100 %) only while the method
  is *High/low MAP split*, the one method that reads it (issue #174); under
  *by area* or *manual* it is hidden and its saved value kept.
- **EWR**: m³/day per month, with l/s, then (under the row, so the twelve
  months get the full width) the annual volume and mean flow (no chart: a bar
  chart of the same twelve values was removed as a restatement of the row,
  issue #174), the
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
  line), the optional **Recommended ecological category (REC)** (ER9: A to
  F or a band like B/C, upper-cased as typed, blank = not given; a label for
  the evidence report, no result depends on it), what **the table covers** (total flow, or low flows
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
  EWR charge, curtailment and the EWR required vs met under the EWR by month grid) and
  **Low flows judged on** (`settings.lowFlowMeasure`: *The month's total
  flow*, the default, or *The month's base flow*, from the Lyne–Hollick
  filter, so a flood month can't pass its low flows). Each has a help tip;
  scenarios can change both with `settings.set`.
- **Drought restrictions** (`#set-restrict`, engine ≥ 1.54.0, WP-3.8): the
  model's restriction rule, off by default; see
  [§ Drought restrictions](#drought-restrictions).
- **Simulation period**: start and end, blank by default, which runs from the first to the last day with rain (engine ≥ 0.45.0; a run that leaves flow out warns, [model.md § 2.1](./model.md#21-pipeline)).
- **Data quality** (`DataQualitySection.svelte`): three groups.
  *Gauge vs logger*: the lowest and highest ratio in %, shown to one
  decimal, and the minimum shared days (defaults 66.7 % (two thirds),
  150 %, 90 days). *Outliers and flat stretches* (engine ≥ 1.20.0): the rain
  and flow outlier factors (× the 99th percentile, defaults 5 and 10), the
  rain and A-pan flat stretches (5 and 7 days) and the shortest and longest
  flow flat stretch (14 and 90 days). These only change what is flagged,
  never the results. *Catchment rain recorded as zero* (engine ≥ 1.20.0,
  issue #66): **Judge a zero-rain run by** *Days in the wet season* (the
  default, with its days, 60) or *Share of the usual annual rain* (its share,
  25 %, and shortest run, 60 days, replace the days field); **Check each
  zero-rain run against CHIRPS** (off); and low vs CHIRPS: **flag below** a
  share of the usual ratio (50 %), the **Usual ratio** (whole-record median
  or a moving median over ±5 years) and the **CHIRPS rain a year needs**
  (50 mm, or scaled to the catchment). The group's note says these change
  results and that the alternatives are still to be tested on a semi-arid
  record. Every field has its field-history line. Out-of-range values, or a
  longest flow flat stretch shorter than the shortest, block Save with a
  message. The Data tab's checks, zero-rain shading and daily preview flags
  follow the saved limits, as runs do
  ([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
  A fit's provenance lists the rain limits it ran under (*Rain data-quality
  limits*).
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
  analogue years in (0, 100]. **Review date** (issue #53 R6), with **Use
  the default review date (1 Jan)** (the engine's `defaultReviewDate` for
  the season set, O3); unticked, a month and a day inside the season,
  after its decision date (outside it, or 29 February, blocks Save): the
  day each outlook's review triggers are for. The defaults are the engine's
  (`DEFAULT_OUTLOOK_SEASON`, `DEFAULT_PLANNING_SHARE`, `defaultReviewDate`),
  confirmed by the client (issue #90), so no badge marks them pending. Viewers see it read-only; saving only this
  group doesn't mark the runs as out of date.
- **Evidence** (`#set-evidence`, issue #71, `settings.evidenceUncertaintyRule`;
  `settings/EvidenceRuleFields.svelte`, its own chunk, part of the form;
  [design/evidence-report.md](./design/evidence-report.md) ER3 and G4): the
  uncertainty rule the project declares for its licensing evidence. Off by
  default: **Declare an uncertainty rule for evidence** fills the form with
  the ensemble's defaults (`ENSEMBLE_DEFAULTS`: 300 members, typical bounds,
  pan ±0.1, KGE′ at least 0.5, WR2012 flags up to “query”, low-flow bias
  within ±50 %); unticking it saves `null` (the hint then says an evidence
  report cites no ensemble). Fields: **Members** (30–1000), **Bounds**
  (typical or wide), **Pan-coefficient shift** (± 0–0.3), and under *A
  parameter set is kept when it passes*: **Skill score**, **Lowest skill
  kept**, **Worst WR2012 flag kept** (*No check* switches it off) and
  **Largest low-flow bias kept** (± %, blank = no check). The hint says why
  it is declared first: an evidence report's bands come only from an
  ensemble run to this rule (the first complete one whose options match it
  exactly), and a later change is recorded in the History tab and needs a
  new ensemble run to it. The rule shows in one line under the form
  (`declaredRuleText`), with its field-history line. An invalid rule blocks
  Save (the engine's `declaredRuleError`, as the API checks it). Viewers see
  it read-only.

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
  Pressed too often (6 fetches, then one every 10 minutes per feed), the
  section's error line shows the server's words, with the wait in whole
  minutes and a reminder that the feed also runs daily.
  **Switch off / on** and **Remove** (with a confirm; the series keeps its
  days) are for owners.
- **Attach a feed** (owners): source, **Into series** (the kinds that source
  may write; CHIRPS into the catchment rain series gets a hint under the
  select, tied to it by `aria-describedby`, that CHIRPS then is the catchment
  rain, used raw, `feeds.ts` `targetHint`, issue #51), an optional series name (no schedule to pick: every feed runs daily), and either an
  **Area** (CHIRPS and the forecast) or a **DWS station** code (checked as `A2H012`; only river gauges, H codes). The area is
  **Grid cells** (one "latitude, longitude[, weight]" per line, up to 25; the
  rainfall is their weighted mean) or a **Bounding box** ("south, west, north,
  east" in degrees, `feeds.ts` `parseBbox`, a typeset minus accepted; the
  area-weighted mean of every 0.05° cell it overlaps, at most 100 cells in 25
  rows, the server's limits mirrored so a box too big is explained before
  anything is sent), with **Leave out sea cells** under it (`skipNoData`, for
  a box on the coast; its hint says a land cell losing its data, or a box with
  no land, still fails; the card then adds "· 3 of 4 cells with data",
  `cellsUsedNote`). The card says where a feed reads: "cell -20.12, 25.17",
  "3 cells" or "box -20.20, 25.10 to -20.10, 25.20" (", sea cells left out"
  with the option; `describePlace`). The panel is its own lazy chunk inside
  the Settings tab (`Lazy`, with the standard loading state); its
  `#set-feeds` anchor sits on the wrapper, so the section menu and a link
  find it while the chunk loads.
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
  the message and focuses it (the bounding box too); busy buttons are `aria-disabled` so they keep
  focus; after **Remove**, focus goes to the section heading. Messages land
  in a live region that is always in the page. A failed action re-reads the
  list (it was usually changed elsewhere), and a failed refresh keeps the
  list shown.
- When the server reads the synthetic fixtures (`FEED_SOURCE=fixtures`, the
  default in dev and CI), a **Sample data** badge says so, and the cells and box hints
  name the sample grid's extent (the box hint with a sample box inside it).
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
its panels unchanged, laid out as a reading page that flows in the window's
one scroll (`river/RiverTab.svelte`, its
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
  *EWR not met* (share of days the outflow was below the pragmatic EWR at
  the outflow gauge, "N of M days", how many in an average year ("37 days
  in an average year", one decimal under 10), and with a rule table
  "Reserve rules: x% of months", which is the rule table's test and named
  as such; flagged above 5 % of days; a fall is the better change). It
  is the Summary's *EWR not met* card word for word: both take their term,
  value and count from `ewr/notMet.ts` `ewrNotMet`, since until issue #162
  this tile framed the same figure the other way round ("Reserve met 21.2%"
  against the Summary's "EWR not met 78.8%"). "Not met" is the framing the
  flow chart's shading, the EWR by month grid and the projects list use;
  *Mean simulated outflow* (m³/s and % of natural, the Summary's line until
  it was dropped there, same figure as `overview/latestRun.ts`). A third
  tile, *Days below the reserve*, was folded into *EWR not met* as its
  average-year line (issue #177): its value was that tile's count, and its
  per-year change was the share's change × 365.25, which the share (run
  length free) already shows. A fourth, *Worst month*, was removed on
  2026-09-29 (issue #175): it restated the largest figure of the EWR by
  month grid's "All years" row. The two tiles sit side by side at every
  width.
- **First screen.** The **Flow vs reserve** chart, the app's only copy of it
  (`overview/FlowVsReserve.svelte`, `#res-ewr`: EWR vs simulated outflow, log
  axis, the **30 days / 1 year / All** switch, the days below the reserve
  shaded and counted in its caption, a forecast run's band). The Summary
  drew it too until issue #162 and now shows the days below by month and
  links here. Its shading comes from the run's own `ewr_shortfall` series
  (`overview/summaryChart.ts` `belowReserve`: negative on a day the engine
  counted as EWR not met), so the caption's count is the *EWR not met*
  tile's; with a Reserve rule table at the outlet it also draws the
  requirement (`EWR_RULE_KEY`) as a second step line (issue #51). Its
  heading is **Flow vs reserve** when the reserve it names is on it: the
  pragmatic EWR without a rule table, the rule requirement line with the
  outlet's table. With rule tables only at other sites the Reserve is judged
  there and the chart draws only the pragmatic EWR, so it is headed **Flow
  vs pragmatic EWR** (issue #177; `summaryChart.ts` `flowHeading`, the
  rule line known from the run's `ewr_rule` series, `hasRuleLine`, before
  it loads; the menu entry below matches). The shading is always the
  pragmatic EWR's, which its caption says. It keeps
  the two controls the Runs tab's EWR chart had
  (`FlowVsReserve` `units` and `pannable`): the **m³/s ↔ m³/day** switch
  (the shading is days, so it is the same in both units) and **◀ Earlier /
  Later ▶**, which step by the window picked (a year, or 30 days) with that
  window's button still pressed, stop at either end of the run (disabled
  there), and step aside under *All*; Shift+drag moves the view too. It sits beside **Days
  below the reserve, each water year** (`#res-reserve-years`, Compare runs'
  `ReserveYearsChart` with this one run: the engine's
  `reserveDaysByWaterYear` over the run's `ewr_shortfall`, part years faded,
  a table behind *Show as a table*; about six years labelled, always the
  last, and a label near an edge moved in so it is never cut off,
  `compare/yearAxis.ts`, issue #162: the narrow column clipped "2024/25" to
  "2024/2…"). With a Reserve rule table (`headlineSite`) the bars are
  headed **Days below the pragmatic EWR, each water year**, their drawing
  and table named the same (`river.ts` `reserveYearsWords`, the chart's
  `below` prop), since the Reserve is then the table's monthly test and the
  bars count the daily pragmatic one (issue #177). From 1100 px wide the two sit side by side, the bars as tall
  as the chart (the row stretches them); narrower, they stack. The chart's
  plot is a fixed 420 px tall on a page 640 px or wider and 280 px on a
  phone (`FlowVsReserve` `height`), never sized to the window: until
  2026-09-29 this row was fitted to the window's foot (measured with a
  ResizeObserver), which read as the whole page and hid the panels below.
  Now the next panel's top edge shows inside 1440 × 960. Opening the bars'
  table makes the row taller (its 30-odd rows grow with the page instead of
  scrolling in an 18rem box); the chart keeps its height at the row's top.
- **Nothing scrolls inside itself.** The window is the page's one scroll:
  the panels' tables drop the app's 70vh `.table-wrap` cap (and the EWR
  grid's) on this page and scroll only sideways when wide. Reserve
  compliance's **Month by month** (one row a month, 360 for 30 years) shows
  the first 24 months, then **Show all N months** (`aria-expanded`, opens
  the rest in place; **Show the first 24 months** folds them again); the
  printable report shows every month.
- **Below it**, full width, the moved panels, with their ids:
  **Reserve compliance by month** (`#res-reserve`, with a rule table),
  **EWR compliance by month** (`#res-ewr-grid`, `EwrHeatmap`, with the
  **EWR required vs met, each water year** table under the grid, engine ≥
  0.32.0, `ewr/EwrRequiredMet.svelte`), the
  **Uncertainty bands** (`#res-uncertainty`, with the **Sensitivity runs**
  under them in the same panel, [§ Sensitivity runs](#sensitivity-runs)), the **Outcome matrix**
  (`#res-outcomes`, [§ Outcome matrix](#outcome-matrix)), the **Seasonal
  outlook** (`#res-outlook`, [§ Seasonal outlook](#seasonal-outlook)) and the
  **Water account** (`#res-water-account`). Each is described under
  [§ Runs & results](#runs--results), where it used to be.
- **On this page.** A **River sections** menu ([§ On this page
  menu](#on-this-page-menu)) sits under the header, above the tiles (one row
  from 1280 px), and sticks down the
  panels: **Flow vs reserve** (**Flow vs pragmatic EWR** when its heading
  is), **Days below, by year**, **Reserve
  compliance** (with a rule table), **EWR by month**, **Uncertainty**,
  **Outcome matrix**, **Seasonal outlook** and **Water account**, by the ids
  above (`river/river.ts`, `riverNavGroups`), in three groups: The reserve;
  How sure, and what if; Water balance, named for screen readers, its links
  evenly spaced (issue #162: the wider gaps between unnamed groups read as
  spacing bugs, and the names on the bar take it to a second row at 1440 px).
- **Links in.** A `#res-…` fragment scrolls to its panel once the run is in
  and holds it there (`holdAnchor`), with focus on the panel's heading, waiting
  for a lazy panel's heading to arrive. An old link to one of these panels on
  Runs & results (`?tab=runs&run=<id>#res-reserve` …, `RIVER_ANCHORS`) is
  replaced by the same link here. The Summary's reserve strip and outflow line
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
  unit count alone before a run. Once that week's last day is more than a
  week old, "this week" becomes "in the week to 31 Dec 2024" here, on the
  tile and on the cards ("Short on 2 of the 7 days to 31 Dec 2024";
  `weekText`, [Data age and stale wording](#data-age-and-stale-wording)).
- **Tiles.** *Irrigation supplied* (% of demand over the whole record, the
  Summary card's figure, its sub-line "2 of 8 hydrological units below 95%"
  (every unit under `SUPPLY_TARGET`; "all hydrological units ≥ 95%") and its
  change from the previous run, all from `overview/latestRun.ts`
  `headlines`; the units below were a tile of their own until 2026-09-29,
  issue #175); *Short this week* (units with a
  deficit above float noise on any of the 7 days to the run's last day of
  recorded rain (on a forecast run, the 7 days before the forecast, issue
  #51), the reporting window's *Last 7 days* and the publication's own rule,
  so the portfolio's count and this page agree,
  `backend/src/publish/recent.ts`; the tile links to the curtailment over
  those days, and carries no curtailment count of its own, since the table's
  default window is the project's, not the week); *Total
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
  asks for; links to its node on the Network (`?tab=network&node=`), **Show on
  map** (`?tab=map&node=`, only for a unit a map feature is linked to; issue
  #326 A2) and its planted areas (the farm drawer, `farm=`). The whole card picks the unit:
  `unit=<nodeId>`, a history entry, so Back returns and the link can be
  shared; a `unit=` the run doesn't have picks the worst unit.
- **Hydrological unit detail** (`supply/UnitDetail.svelte`, `#res-farm`): the unit detail
  panel of Runs & results, moved. Its demand, supply, share and dam size (the
  capacity the run had, `runDamCapacity`) in a line, then **Supply vs demand**
  (the days the unit was short shaded, from its `deficit` series), with the
  **30 days / 1 year / All** switch (opening on a year), Earlier / Later, and
  a forecast run's band. A unit with a dam has **Dam storage on the Dams
  page** in the panel's head (`?tab=dams&dam=<nodeId>`), the [Dams](#dams)
  storage chart with its capacity and minimum lines. Until 2026-09-29
  (issue #175) the panel drew its own *Dam storage* chart behind a switch, a
  weaker copy of that one with neither line.
- **Layout.** The page flows in the window's one scroll; nothing on it
  scrolls inside itself. From 56rem of page width the cards are a column
  beside the chart (a fixed 420 px plot; 260 px stacked). The three least
  supplied cards show, then **Show all N hydrological units**
  (`aria-expanded`, `aria-controls="unit-cards"`) opens the rest in place and
  becomes **Show the 3 least supplied**; four units show whole. A picked unit
  further down keeps its card after the three when the list is folded, so a
  shared `unit=` link shows its card (`foldList`). On a
  wide window at least 700 px tall the chart is `position: sticky` just under
  the *On this page* menu (its height measured into `--nav-h`), so it stays
  beside an opened list as it is read down. Narrower, one column: three
  cards, the fold, then the chart; picking a card scrolls the chart into view.
  The page was fitted to the window until 2026-09-29, the cards scrolling
  inside their column, so with 40 units it looked like the whole page.
  The tables below grow with their rows (their `.table-wrap` uncapped, no
  70vh box); from 64rem the unit results table's box stops scrolling so its
  header row sticks under the menu down forty or sixty units, and narrower
  it keeps its sideways scroll (`supply-page.spec.ts` checks the fold, the
  sticky chart and header, and that nothing scrolls inside itself, wide and
  on a phone, with 32 units).
- **Below it**, under *Tables for this run*, the moved panels with their
  ids: **Hydrological unit results** (`#res-farms`, `supply/UnitResultsTable.svelte`, the
  table that was in the run summary; the printable report still shows it
  there), **Curtailment** (`#res-curtailment`, with the
  [reporting window](#report-window), `window=`), **Assurance of supply**
  (`#res-assurance`), for a run with the drought restriction rule **Drought
  restrictions** (`#res-restrictions`, engine ≥ 1.54.0,
  [§ Drought restrictions](#drought-restrictions)) and, for a run that has any, **Other uses**
  (`#res-other-uses`, issue #137): the land-cover, groundwater,
  demand-object and other-user tables, once under the run summary with no
  menu entry, other users left out when the curtailment table lists them.
  Each is described under [§ Runs & results](#runs--results).
- **On this page.** A **Hydrological units sections** menu ([§ On this page
  menu](#on-this-page-menu)) sits under the header, above the tiles (one
  row), and sticks down the page: **Hydrological unit detail** (`#res-farm`), **Hydrological unit results**, **Curtailment**,
  **Assurance of supply** and **Other uses** when there are any (`supply/supply.ts`, `supplyNav`). Until it,
  the three tables ran four screens under the cards with no way to them but
  scrolling. Not shown with no run or no units.
- **Links in.** A `#res-farm`, `#res-farms`, `#res-curtailment`,
  `#res-assurance` or `#res-other-uses` fragment scrolls to its panel once the run is in and holds
  it there (`holdAnchor`), focus on its heading. An old link to one of them on
  Runs & results (`SUPPLY_ANCHORS`) is replaced by the same link here, with
  its `run=` and `window=`. The portfolio's and team page's "units short this
  week", the Summary's *Supply by hydrological unit* and its short-units card, and the
  run header's *Hydrological units* link on Runs & results lead here, and
  the Summary's line about the run's other uses.
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
  Plausibility only on a run made by engine 0.25.0 or later. Plausibility
  and Outputs are one word in the menu (the panels' headings say
  *Plausibility checks* and *Explore outputs*) so it still fits two rows at
  1280 px beside the runs rail with the Water balance entry (issue #137). The
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
     self-checks, the plausibility findings and the WR2012 flag, each in words
     with a coloured edge and a link to its panel (not the calibration fit:
     it has no verdict and the NSE card below says it, issue #177).
  2. **Model quality**: the hydrograph with the flow-duration curve under it
     (compared together on every calibration iteration; a run scored at a
     gauge inside the network, engine ≥ 1.41.0, adds under the outlet's
     hydrograph "Flow at &lt;gauge&gt;, the calibration site": that gauge's
     record against the simulated flow there, `runs/RunCharts.svelte` from
     the node's `observed_flow` and `outflow` series), calibration (its
     *Compared with* and the NSE card name the gauge when scored there; with
     where the parameters came from), the **water balance** by water year
     (`#res-water-balance`, `runs/WaterBalanceTable.svelte`: the table a
     hydrologist hands a client first, its own section since issue #137;
     described under [Self-checks](#self-checks); a line under its equation
     links to River & reserve's **Water account** for the same run, the
     catchment's own), runoff model, WR2012
     check, EWR vs observed, plausibility checks.
  3. **Record**: notes & evidence (with the run's inputs), the validation
     statement, publication: sign-off, after the results. The **validation
     statement** (`#res-validation`, menu entry **Validation**;
     `liability/ValidationPanel.svelte`) is the report's own
     `ValidationStatement.svelte` (§ Report), folded shut in a `<details>`:
     closed it shows its heading and "Engine x.y.z: its checks, …"; opened, the
     statement loads as its own chunk, its headings (Calibration, Data
     quality, Known limitations) one level under the panel's. Nothing is
     computed twice: both call the engine's `validationStatement`.
  4. **Dig deeper**: self-checks (with Trace a day, and a line linking to
     the water balance), Explore outputs.

  The run summary no longer draws the land-cover, groundwater,
  demand-object and other-user tables, which had no menu entry: they are
  **Other uses** on Units & supply (issue #137), and a line at the foot of
  the Summary names what the run has and links there (`other-uses-link`,
  `runs/humanImpacts.ts` `otherUsesLink`; to the curtailment targets when
  the run's only ones are other users, listed there). The printable report
  keeps them in the summary.

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
  no re-publishing): "Notice saved." The edit form and the publish dialog
  keep separate notices and errors, so opening one never overwrites the
  other's typing. A publish that succeeds but whose history refresh
  fails still closes as published, with "The publication history couldn't
  be refreshed: reload the page to see it." rather than an error. A legacy-model run (a stored run from
  before engine 1.0.0) says why it can't be published: that model was
  removed and the run is a workbook comparison only. In the runs list the current published run carries a
  **Published** tag, and no run a publication holds has a delete button (the
  server refuses with `409`); the run header repeats the badge as a link to
  the section. Viewers see the status and the notice, no actions. The farm
  page farmers read it on is WP-2.6's (`routes/farm/`).
- **Summary** (the "Run summary" region): it opens with one or two plain
  sentences (`runs/runSentence.ts`, built only from the stored summary so they
  always agree with the cards): the river measure the cards lead with (Reserve
  rules met in X % of months at the headline site when there is a rule table,
  else the % of days below the pragmatic EWR at the outflow gauge), then the
  farms (how many got less than 95 % of their demand and the lowest one, or
  "Every hydrological unit got at least 95 %"; left out when the run has no farms). The
  calibration fit is left to the NSE and PBIAS cards (a sentence repeating
  them was dropped, issue #177; the printable report draws the same cards). Then the headline cards give mean natural
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
  unit (column V). Second, the **water balance by water year**
  (`runs/WaterBalanceTable.svelte`): on Runs & results its own Model quality
  section (`#res-water-balance`, issue #137), and the self-checks keep only
  its closure check: one line, ✓ or ✗ in text, saying the balance closes in
  every water year and over the whole run, or naming the years whose
  residual isn't float noise with their residuals (the first five, then "and
  N more"; `balanceClosure`), and a link to the table
  (`checks-balance-link`). In the printable report the table is here, under
  the checks. The table says, under its equation, where the catchment's own
  account is (River & reserve's **Water account**, from natural flow, in m³;
  `balance-account-link`), and the account links back: the two cover the
  same water years (Water account, below). Rain,
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
  residual in mm. On a run's first day each store starts from its value after
  the warm-up (engine ≥ 1.20.0); a run from before kept only their total there,
  so each store shows – and the balance uses the total. A legacy run lists its [Flow data] columns (`LEGACY_RUNOFF_COLUMNS`)
  and says it keeps no stores, so there is no store balance to close.
  A run saved before 0.12.0 says
  it has no checks, balance or working columns, and to run it again.
  Not yet: an Excel audit workbook. (The Data tab's series downloads carry
  the model's columns since engine 1.27.0: docs/api.md § Export.)
- **Other uses** (`runs/HumanImpactTables.svelte`, its own chunk): the
  tables below are on Units & supply (`#res-other-uses`, issue #137), in the
  printable report under the summary.
- **Land cover** (engine ≥ 0.24.0, only with land cover): the mean natural
  flow invasive plants and forestry took, its share of natural flow, the
  low-flow threshold, and per class the condensed area, reduction and mm/yr
  over that area.
- **Groundwater** (engine ≥ 0.23.0, only when a farm or user has boreholes;
  `HumanImpactTables.svelte`, `runs/groundwater.ts`). From engine 0.36.0
  (WP-3.9) one table, **Groundwater by water year**: the GN 538 context note
  (area × Table 2 rate, at most 40 000 m³/a, in any 12 months; the ceiling
  only where a property's area or rate isn't entered; the GA's exclusions;
  modelled use only, the app never decides legality), the low-confidence
  note, then per farm or user the mean pumped per year (partial years
  weighted by their days), its **share of supplied** (pumped ÷ supplied over
  the run), the **stream depletion** it causes per year (weighted the same
  way, `depletionM3Year`), the most in one
  year, the annual caps, the **GN 538 volume** ("(ceiling only)" when
  unknown), the **most in any 12 months**, how many years were above the GN
  538 volume over the water year or any 12 months ending in it (flagged; engine
  ≥ 1.12.0, `aboveGa`) and how many reached a cap; and per node a collapsed
  table of every water year: days, pumped, into the dam, stream depletion, the
  most in the 12 months to then, and each borehole's volume (of its cap,
  marked when reached). Until 2026-09-29 a daily-mean table (pumped, share of
  supplied, stream depletion, m³/day) came first; issue #175 merged its two
  columns the annual table lacked into it. A run before engine 0.36.0, which
  has no annual figures, still shows that daily-mean table alone.
- **Other water users** (engine ≥ 0.22.0, only when the run has any): a table
  with each user's priority, demand, taken, deficit, % of demand supplied
  (flagged below 95 %), returned and EWR charge, whole-run means. Units &
  supply draws it only for a run whose curtailment table doesn't list the
  users (`usersTableOnSupply`), so the page has one copy; the printable
  report keeps it.
- **Other water users’ pumps** (engine ≥ 1.58.0, only when a user has a pump
  capacity): each such user's demand, what it pumped from the river, the
  demand its pump left unmet although the river had it (`pump_limited`) and
  the days it did, whole-run means. Drawn on Units & supply too, beside the
  curtailment table (which has no pump columns); the run Summary's Other uses
  line names it.
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
  out (`CurtailmentTable`'s `board` prop). Two stages, side by side, each
  as a share of the group's own demand: **1. Today** (supplied ÷ demand)
  and **2. EWR met** (volume left ÷ demand: the equitable share less the
  farm's EWR supply cut). The equitable share is not a stage: it is the same
  % for every farm and its total always equals *Today*'s, so the intro says
  it once ("At the equitable share every hydrological unit would get the
  same K % of its demand*: the same water in total as today, shared
  equally", or "nothing to share" with no farm demand, and "too little for the equitable
  share's % to mean anything" when farm demand is under
  `DEMAND_PCT_FLOOR_M3_DAY` in total; issue #177), marked *
  for the fixed `EQUITABLE_SHARE_FOOTNOTE`, with a line that SA restrictions
  are set per user category. A row of two cards gives the farm totals per
  stage; the table has one row per farm (a bar, the whole %, the m³/day), an
  **All hydrological units** total row, then **Other water users (outside
  the equitable share)**: each user its own row with a *senior, not
  curtailed* or *junior, curtailed* badge, and at stage 2 what it takes
  after its supply cut (junior) or all it takes (senior), with an **All
  other users** total. Each farm's equitable share volume stays in the
  per-farm table below.
  Every figure is the engine's `CurtailmentSummary`; nothing is recomputed.
  The % uses *Demand left %*'s rules (`fmtDemandLeft`): bounded to 0–100 %,
  "no demand" for a group with no demand (never a negative demand, which the
  client's sketch showed), "—" under 1 m³/day. A note under stage 2 names
  what the % leaves out: a farm's *store less / pass inflow* charge, an EWR
  cut beyond its equitable share, a senior user's charge that stands, a
  junior user's charge beyond what it takes, or what a unit's basic-needs
  floor keeps of the cut (engine ≥ 1.44.0, issue #123: stage 2 never goes
  below it, and the paragraph under the board says so; the per-farm table
  badges the row in the same words, `basicNeedsNote`;
  `e2e/tests/basic-needs-floor.spec.ts` seeds a unit whose EWR cut goes
  beyond its share and checks the badge, the board's note and the volume
  left at the floor). The share is the engine's
  equal one: every category is cut by the same %, which the client
  confirmed (O4, issue #90,
  [plan.md](./plan.md#decision-support-outputs-2026-09-26)). Still open to
  the client: whether the town's uses count as domestic or irrigation.
  Tests: `shareThePain.test.ts` (bounding, zero demand, senior / junior, the
  equal share's %, and seeded engine runs whose totals match the engine's
  and whose equal share is today's total %),
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
  the % of demand supplied (flagged below 95 %, as the units are; issue
  #137), returned, EWR charge, the supply cut, and the charge left standing, with
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
  and one wholly outside isn't listed (`runs/exclusionShading.ts`). **The
  observed flow's quality flags** (engine ≥ 1.48.0, model.md §2.10h: the
  run's `observed_flow_quality` column, stored only when a day is flagged)
  are thin strips along the foot of the plot, behind the lines, one strip
  per flagged class (above the highest gauging, below the lowest, suspect,
  infilled; top to bottom in that order, each in its own `--series-*`
  colour), so a class reads by its place as well as its colour. A key under
  the chart (`LineChart`'s `lanes`, `lane-key`) lists each strip in words
  with its days and what Fit automatically does with them under the run's
  own settings snapshot: "Above the highest gauging: 14 days; Fit
  automatically: censored at the highest gauging" (`calibration/flowFlags.ts`). They
  follow the scored record: on a run scored at a gauge inside the network
  they are on the calibration site's hydrograph, not the outlet's. The figure
  carries `data-lanes`. A plain
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
  not met (rows not met shaded); the first 24 months, then **Show all N
  months** in place, so the table never scrolls in a box. From engine 0.33.0 ([model.md §2.9d](./model.md)),
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
  there is no table. Under it, the same table for each gauge EWR site with a
  record of its own (engine ≥ 1.41.0, `summary.catchment.ewrAgreementSites`,
  "EWR test at &lt;gauge&gt;: model against its observed flow"; model.md
  §2.10k). The **Plausibility checks** (`#res-plausibility`,
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
  those runs; an older run shows neither. From engine 1.55.0, after it,
  **Validation signatures** (`runs/ValidationSignatures.svelte`, helpers in
  `runs/signatures.ts`; [model.md §2.10d](./model.md), *Validation
  signatures*, CR-16): which record is scored (the outlet's gauge or logger
  record, or the calibration site's, named) and on how many days; a verdict
  line; a table with a row each for the base-flow index by the Hughes et al.
  (2003) and the Eckhardt (2005) filters, the low-flow FDC's Q70–Q95 slope,
  the low-flow volume bias (%BiasFLV) and the skill on held-out recessions
  (observed = the river's own recession curve fitted on the other segments,
  simulated = the model), each with its observed and simulated value, the
  difference or bias, the **Provisional limit** and *within* / *outside* /
  *not judged* (a row outside its limit shaded); and a line on how the
  recessions were held out. The intro says the limits are provisional, for
  the hydrologist to confirm: they are the engine's warning limits (±0.15
  BFI by either filter, ±50 % on the slope bias and %BiasFLV, a held-out
  skill of at least 0 with 8 or more segments), which the display reads
  through one named constant, `PROVISIONAL_SIGNATURE_LIMITS` in
  `runs/signatures.ts` ([followups.md § Hydrologist](./followups.md#hydrologist)).
  The check list gains a *Validation signatures* line (so does the run's
  credibility strip, which counts the check list's findings) and the
  panel's intro counts six checks on those runs; a run with no observed
  record shows the heading and "Not computed: needs an observed flow
  record."; a run made before 1.55.0 shows neither. The help article
  *Validation signatures* (`plausibility-signatures`) explains BFI, the two
  filters, the low-flow slope and %BiasFLV and the held-out recession skill
  in plain words. The Compare page sets all six checks and the
  gauges side by side (`compare/PlausibilityCompare.svelte`, rows from
  `compare/plausibility.ts`; the recessions' rate ratio and b difference,
  and the BFI by both filters, the low-flow slope bias, %BiasFLV and the
  held-out skill), each run's stored numbers with a change only between two
  runs that scored the same record, and a note above the table on a run
  that has none (made before the engine that added the check, or no
  observed record) or on two runs that scored different records
  ([run-comparison.md](./run-comparison.md#plausibility-checks)). Hydrological unit detail (on Hydrological units since issue #17: supply
  against demand, and a link to the unit's dam on the Dams page), and an explorer for any
  stored series, grouped by node. The catchment's series include the final
  catchment rainfall, CHIRPS as uploaded and bias-corrected CHIRPS
  (`rain_final`, `rain_chirps`, `rain_chirps_corrected`, engine ≥ 0.10.1)
  and the day's CHIRPS factor (`chirps_factor`), and with the CHIRPS
  quantile map on (engine ≥ 1.53.0) CHIRPS after the map
  (`rain_chirps_mapped`), which the catchment daily CSV puts in adjacent
  columns after rain used. The summary CSV lists the 12 monthly factors,
  and the map's month table when it was on.
- **Assurance of supply** (`#res-assurance`, on Hydrological units after the
  curtailment table, under *Units & users* on the Runs tab until issue #17;
  `reliability/AssurancePanel.svelte`, helpers in
  `reliability/reliability.ts`, in the Hydrological units chunk; engine ≥ 0.32.0, WP-3.4,
  [model.md §2.11a](./model.md)): per farm and other water user over the
  reporting window, the % of demand days fully met, complete water years met against the annual threshold (Settings;
  from engine 1.11.0 a part year at either end of the window is left out, and
  the note under the table says how many), the
  failures and their mean and longest length, and the mean and largest
  deficit per failure. The volumetric reliability (Σ supplied ÷ Σ demand) isn't
  a column: it is the curtailment table's *Supplied %* over the project
  window, and a column here claiming to equal it was wrong whenever the
  table was re-windowed; it stays in the engine and the CSV export. Below it
  the **stress classes by month**: a heat map
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
  residual (to two significant figures, float noise). Runs before engine
  0.32.0 show *Not computed by engine x.y* in both panels. A line under the
  introduction links to Runs & results' **Water balance** for the same run
  (`?tab=runs&run=<id>#res-water-balance`, `account-balance-link`): the same
  water years summed over the hydrological units, with rain, the runoff
  coefficient and start and end storage, in Mm³. The two tables share about
  ten terms; which one is the client's, with the other becoming a link, is
  the operator's call (followups.md § UI), so for now each links to the
  other instead of repeating the other's words. The **EWR required
  vs met** table (each site's share of the required volume that passed it,
  the volume and the days short, per water year and the whole run) closed
  this panel until 2026-09-29; it is not part of the balance, so issue #175
  moved it, unchanged, under the EWR by month grid (`#res-ewr-grid`,
  `ewr/EwrRequiredMet.svelte`), where the compliance findings are.
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
The level the WUA sets reaches farmers through **Publish to farmers**
(below) and the farm page's *This season* card (§ Farmer view; the client
confirmed farmers see the outlook, O5, issue #90).

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
- **Review triggers** (issue #53 R6, view model `outlook/triggers.ts`,
  model.md §2.15a), after the planning figure, when the outlook has a
  review date (the project's, Settings → Seasonal outlook; 1 January by
  default): *Review on 1 Jan 2019*, the day the table was drawn on (the
  latest review date in the run's record, as a rule for that day of the
  year) and where the bands come from. The table: one row per band of
  total dam storage on the review date, fullest first (*At or above
  53 333 m³*, with its share of capacity), the **demand level** picked or
  *No level*, **years met in full** (*10 of 12 years*), and every level's
  count (*below the share* where it falls short). Under it each row in the
  engine's words (`describeTriggerRow`), the monotonicity notes, the
  warnings and refused members, and that the WUA decides on the review
  date. A table that couldn't be drawn (no farm dam, no such day in the
  record) says why.
- **Farmers** (issue #53 R5, E3): *Published to farmers: 85 % for 1 Oct
  2018 – 30 Apr 2019, on … by …, 12 hydrological units* (or *from another
  outlook*), or *No outlook is published to farmers*. Editors pick **Level
  the WUA has set** (the levels that ran) and **Publish to farmers**,
  which replaces the one published before, or **Withdraw**. Each linked
  farmer then sees what that level gave their own hydrological unit, until
  the season ends. The app never picks the level.
- **No recommendation.** The panel reports how past years went at each
  level and never picks one (a unit test holds the view model to that, and
  the e2e spec checks the rendered panel).

Tests: `outlook/view.test.ts` (the request and monthly plan, the state,
the view against the engine's `summariseOutlook` on invented members, the
pending badges, too few years, the wording guard, the settings check,
the review date's), `outlook/triggers.test.ts` (the table in words, fullest
band first, the engine's sentence, why none) and
`e2e/tests/seasonal-outlook.spec.ts` (settings, outlook with a monthly
plan, worker, the rendered table against the stored per-year values
re-summarised by hand, a viewer; then on a record up to the current
season, the trigger table against the stored one, publishing 85 %, a
linked farmer's *This season* card against the stored per-farm figures,
axe on both, and withdrawing it).

### Drought restrictions

WP-3.8, engine ≥ 1.54.0 ([model.md §2.7i](./model.md)): the model's
drought restriction rule, `settings.droughtRestriction`. English, like the
workspace; nothing of it reaches the farm view or the share page (a shared
scenario's change reads *A catchment setting changed: droughtRestriction*,
as every setting does). A model rule, not the restriction notice farmers
see (WP-2.3); every place it shows says so.

- **Settings → Drought restrictions** (`#set-restrict`, in the model inputs,
  after Reserve rules; `settings/DroughtRestrictionFields.svelte`, its own
  chunk, helpers `settings/droughtRestriction.ts`). **Apply drought
  restrictions in runs** switches it on from a template (reviews on 1 October
  and 1 January, lifted 1 May, three levels below 60 / 40 / 25 % of
  capacity cutting crops and irrigation 20 / 40 / 60 % and domestic and
  municipal 10 / 20 / 30 %; a starting point, pending the hydrologist, and
  a line under the rule says so until the first edit). The hint is one line:
  what it does, that it is a model rule, and that off, runs are as before.
  **The rule** in words heads it. **Review dates** and **Lift dates**: a
  month and a day each, **Add a … date** / **Remove**. One card per level
  (mildest first; side by side where there is room, one under the other on
  a phone, no sideways scroll): **Name**, **Starts below (% of capacity)**
  and one **… cut (%)** per part of demand (crops, then each demand-object
  category; blank = *Not cut*; domestic and municipal marked *floor kept*),
  each input labelled "Level 2: cut on …, %". **Add a deeper level** (the
  last level's cuts, half its threshold) / **Remove the deepest level**;
  **Where the levels come from**. A rule the engine refuses (a date twice, a
  shallower deeper level, a deeper level cutting less) shows its first
  problem under the cards (a status, not an alert) and blocks Save (the
  save bar links here); switching off saves null, and the rule switched off
  comes back until saved. Field history under it. A viewer reads it,
  disabled, and *Drought restrictions: off.* when there is none.
  From engine 1.54.0: **Start from the published notice** (editors) reads
  the project's current publication and, after asking when a rule is set,
  fills the rule from its notice (one level below 100 % at the notice's %,
  from the day it was published, in the project's time zone, to the next
  expected one), or says why it
  can't (nothing published, no % cut); **Storage the level reads** (*Every
  farm dam (their total)*, the default; *Some dams (their total)* with a
  checkbox per farm dam; *Each unit's own dam*, with a note that a unit
  without one isn't restricted by storage); **Units it cuts** (*Every
  hydrological unit*, or a checkbox per unit); and the **EWR trigger**
  (*Also restrict when the EWR wasn't met the day before a review*, the
  site: the outlet or a gauge that is an EWR site, and the level: at least
  which). An id the
  model hasn't got blocks Save with its name.
- **Units & supply → Drought restrictions** (`#res-restrictions`, its own
  panel and menu entry, before Other uses, for a run with the rule;
  `runs/RestrictionTables.svelte`, its own chunk, view model
  `runs/restrictions.ts`; also in the printable report beside the other
  tables): the rule in words and how often it was decided, then the days
  at each level per water year (with *Days restricted*, and a bold *Whole
  run* row), then per hydrological unit, the most cut first, its demand,
  demand after the restriction, cut (m³/day and % of demand) and supplied
  as run means, the mean cut on the restricted days alone and its days
  restricted (its own under *Each unit's own dam*); the rule line counts
  the reviews after a day the EWR trigger's site failed. Both lists
  fold after ten (*Show all N water years* / *hydrological units*). The
  note says the cut shows as a shortfall.
- **River & reserve → Seasonal outlook → Review triggers**: under the
  trigger table, the table *As a drought restriction rule* in words
  (`outlook/triggers.ts` `triggerRuleView`, the engine's
  `restrictionRuleFromTriggers`; *Settings → Drought restrictions* a link
  there) and what it couldn't carry; an editor's **Use as the drought
  restriction rule** saves it to the settings with the reason "Drought
  restrictions from the seasonal outlook's review triggers" and says runs
  from now on follow it. When a different rule is set the button reads
  **Replace the drought restriction rule with this** and asks first (both
  rules in words); when the table's rule is the project's, the panel says
  *This is the project's drought restriction rule* instead.
- **Scenarios → Add a change → Change a setting → Drought restriction
  rule**: the same editor (with its on/off switch), starting from the rule
  the scenario meets; the op replaces the rule whole, or turns it off. The
  op's line reads *Drought restriction rule: off → reviewed 5 Oct; Level 1
  (below 70 %): crops 50 %*.

Tests: `settings/droughtRestriction.test.ts`, `settings/DroughtRestrictionFields.test.ts`
(the storage, units and trigger choices rendered), `runs/restrictions.test.ts`,
`runs/RestrictionTables.test.ts` (the tables rendered, sorted and folded),
`supply/supply.test.ts` (the menu), `outlook/triggers.test.ts`
(`triggerRuleView`), `scenarios/ops.test.ts` and `fields.test.ts` (the
op); `e2e/tests/settings-drought-restriction.spec.ts` (the template, a
blocked save, edits saved whole, a viewer, off saves null, axe and the
cards stacked at phone width) and `e2e/tests/drought-restrictions-run.spec.ts`
(the scenario's "Change a setting", a rule from the published notice on
each unit's own dam with an EWR trigger, the outlook's triggers replacing
it after the question, a run's tables on Units & supply with axe and no
sideways scroll).

## Compare runs (`?tab=compare`)

Board A4 of issue #17: a baseline and up to two what-ifs on one page
(`compare/CompareView.svelte`; also the standalone `/compare` page, which
gives it an `h1` and **Back to runs**). The full reference is
[run-comparison.md](./run-comparison.md); the layout, top to bottom:

- **Header:** in the workspace, the section header (the page's only title)
  carries the view's context line ("Baseline “…” against 2 what-ifs · same
  period, 2021–2024 · engine 0.45.0") and its action, filled with
  `fillHeader`; the view draws no title of its own there. The standalone
  page has no section header, so the view draws its `h1`, the context line
  and the same action beside **Back to runs**. The action:
  - **Export impact report:** the what-if's printable report with an
    *Impact against the baseline* section first
    (`/projects/<what-if's project>/report?run=<what-if>&against=<baseline ref>`,
    § Report). A plain link with one what-if; with two, a menu naming each
    ("What-if 1: <label>", its colour key beside it), which Escape or a
    click outside closes.
  - No create button: a what-if is any run (run the model again, or run a
    scenario on the Scenarios tab). With no pair chosen, the empty state
    says that and links the project's Scenarios tab.
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
- **What changes** (left, ~55 %): the outcomes table (*EWR not met*, the
  share of days, worded as the Summary's card and River & reserve's tile
  from `ewr/notMet.ts`, a rise worse; it read "Reserve met" until issue
  #162; irrigation supplied, farms below 95 %,
  the irrigation deficit, up to two most-changed farms, dam storage at the
  end of the run (when a run has a dam), mean outflow, mean natural flow and
  the runoff coefficient; the deficit and the last two came from the Full
  comparison's Headline results water balance table, merged in here and
  dropped there, issue #175), each what-if cell its value over its `Delta`, the unit on its own
  line under the outcome; then the takeaways box (the first worse, else
  better, takeaway in bold, the rest listed; red, green or grey by that
  lead's tone, whose words also say the direction).
- **Days below the reserve, each year** (right): grouped bars per water year
  (`ReserveYearsChart.svelte`, a chunk shared with River & reserve; part years faded), a legend,
  a note and **Show as a table**. Its value axis is labelled "days below";
  when every year is 0 the plot says "No day below the reserve in any
  year" rather than showing empty bars. It fills the height of its row.
  The bars always count the pragmatic EWR, so once any compared run has a
  rule table the heading and the chart's labels say "the pragmatic EWR"
  instead of "the reserve" (`daysBelowTestOf`, issue #177); that is true of
  every run in a mixed set.
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
  the bare list), but only once no navigation is in flight and the URL
  doesn't ask for the create dialog, so it can't cancel a `+ New scenario`
  click made while the list was loading.
- **The list**, newest first: each scenario's name (two lines at most),
  status as a pill in words, number of changes, base run and last run.
  Empty: "No scenarios yet. A scenario changes the published baseline
  without copying it.", with **Start a scenario** for editors, or, with no
  runs, that the model must be run first. The chosen scenario is
  `&scenario=<id>` in the URL.
- **New scenario** (`&new=1`, a dialog; Back, Esc, Cancel and the ✕ close
  it, dropping `new` in place, and each opening starts with an empty name): a name and a base run, the published run by
  default, else the latest; scenario runs aren't offered (a scenario run
  can't be a base). **Create scenario** picks the new one and
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
  months; none ticked is all; `demand.scale`, issue #53 R1; for units, from
  engine 1.45.0, **Part of their demand**: all of it, the crops, or the
  demand objects of one category, DWS's % per category, never below a
  domestic or municipal object's basic-needs floor), set an EWR
  site's Reserve rule table (`ewrRule.set`, engine ≥ 1.6.0: the outlet or a
  gauge marked as an EWR site, then the Settings tab's own table editor,
  starting from the site's table; always a baseline assumption,
  [scenarios.md § Reserve rule tables](./scenarios.md)), and from engine
  1.35.0 (issue #73) move a node (what it drains into), insert a node on a
  reach (ticking the nodes draining there that will drain into it), change
  or remove a crop, change a land-cover patch (its reductions typed as
  "MAR %; low-flow %"), remove an EWR site's rule table, and set (new, or an
  existing one filled in) or remove a registered volume; from engine 1.45.0
  add a demand object (unit, name, category, and m³/day by month or a count
  × litres a day, the rest at the category's defaults), change one field of
  one (every field, labelled as on the Network tab's form; its on/off
  schedule with the Network tab's own schedule editor, recorded whole) or
  remove one
  ([scenarios.md § UI](./scenarios.md#ui) has each one's wording). A setting's value is typed as
  the Settings tab takes it; GR4J's PE input (`pe`, issue #39) has its own
  control, the source (pan coefficient × A-pan, or a monthly row in mm with
  a required source note), checked with the Settings tab's own rules
  (`settings/peInput.ts`), and a new monthly row starts from the PE GR4J
  runs on now. A farm's dam survey curve (`damCurve`, engine ≥ 1.20.0) is
  a paste box that reads rows as the Network tab's survey box does (level,
  area, volume, one per line; `network/damCurve.ts` `parseDamCurve`) and
  refuses a curve the engine couldn't use; empty is none (the power law),
  and the change reads "none (power law) → 3 survey rows, 180 000 m³ at the
  top". Its hint says to add it after a capacity change, so a raised dam
  uses its own survey ([scenarios.md § Dam capacity](./scenarios.md)); in
  override mode a curve pasted in the table is recorded that way too.
  Targets come from the model as
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
  `OverrideEditor.svelte`, loaded when opened): the Network and Crops
  tables and the Transfers rule cards, switched with a **Network / Crops / Transfers** control,
  on the scenario's model (its base run with its changes applied), under a
  banner in the warning colour, scrolled to the top of the window as it
  opens (below a long scenario the sticky record bar would otherwise cover
  it and its Close button): "Editing the scenario *X*, not the
  catchment", saying the catchment's own model isn't touched, with **Close
  override mode**. Notes, farmer links, the yield panel and colouring farms
  by a run's results are left out (they belong to the live model). The
  Network is its node table inline (`NetworkTab only="table"`), not the map:
  the map's Tables menu and farm links open the page's grid modal and farm
  drawer, which edit and save the catchment's model, and neither opens over
  the Scenarios tab. A navigation that stays on the scenario doesn't ask
  about unrecorded edits; leaving it does (the leave guard, above), and
  **Close override mode** with edits asks "Close override mode?" first. **Edits to record**
  (sticky at the foot on wide screens) lists each edit as the change it will
  be, in the same words as the Changes list; **Record N changes** appends
  them (one Undo takes them back), **Discard edits** reverts. An edit no
  change can express (a node's kind, the outlet moved…) is
  listed there and disables Record until it is undone (a crop's factors, a
  crop removed and what a node drains into record from engine 1.35.0, and a
  demand object added, changed or removed, its schedule and people served
  included, from engine 1.45.0); the
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
- **Applicant's statement** (`ScenarioStatement.svelte`, every scenario, an
  application's too): the evidence report's fixed Appendix C prompts
  (engine `APPLICANT_PROMPTS`, `129_scenario_statement`), **Purpose and
  need**, **Mitigation** and **Monitoring**, with "n of 3 answered" beside the
  heading. Read, each prompt's answer as written or *Not given*. Whoever may
  change the scenario (an editor on a team scenario, only its applicant on
  an application) gets **Answer the prompts** (**Edit statement** once one
  is answered): a box per prompt, labelled with its heading and described by
  its question, 4 000 characters each; **Save statement** sends only the
  answers that changed, trimmed. Not frozen by a submission, as the
  description isn't; a half-typed statement asks before the scenario is
  left (the leave guard). Tests: `scenarios/statement.test.ts`,
  `e2e/tests/evidence-statement.spec.ts`.
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
  `GET /compare/runs`: headline results (the water balance only, without
  the Compare page's calibration and WR2012 tables: the scenario run is
  scored against the real gauge, so its fit is no outcome of the what-if,
  and an unbuilt dam would score "worse"; issue #177), the farms table and the per-node
  daily overlay (the compare page's `CompareOverlay` and `overlay.ts`, issue
  #8). A feature the scenario adds or removes shows against 0 in the run
  without it: a river-first farm's *Pumped from the river* series (the base
  drawn as zeros, "run B only") and farm column ("A: none (0)"), under
  [run-comparison.md § Series and metrics only one run has](./run-comparison.md#series-and-metrics-only-one-run-has); with **Open the full comparison** (the Compare runs tab). Only the
  assessors see this section; an applicant gets a note instead
  ([§ Applications](#applications-wp-33)). A note says when the changes were
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
The volume sheet's **Water use** picks a take (s21a) or a dam's storage
(s21b, issue #72); a storage row has no volume field, its water source is
surface and its storage is required.

**Under the header**, a sentence naming the run and saying modelled use is
*modelled, not metered* and a difference is something to look into, not a
finding; slim notes for volumes not matched to a unit (editors: "Change a
volume to match it"), or matched to a unit the run doesn't have. A run made
with an allocation mode (engine ≥ 1.18.0, Settings › Registered volumes)
says what it did first (`MODE_NOTE`, `allocation-mode-note`): a cap ("This
run capped each unit’s use at its registered volume per water year …") or a
full allocation ("… what the river would look like if every registered or
licensed volume were taken in full (a registration is not an entitlement), not
what the units take").
In a cap run the picked unit's card says, per capped source under its water
years (`capYearsText`, `allocation-cap-years`, engine ≥ 1.40.0), on how many
days the cap held use back and by which limit (the volume used up, the
maximum rate, outside the months of use), then the years the volume was
used up; a run before 1.40.0 says only the years, and to run again for the
days.

**The page flows** in the window's one scroll, and nothing scrolls inside a
card: each long list shows its first few, the ones that matter most, with a
**Show all** button (`aria-expanded`, `aria-controls`) that opens the rest in
place and a button to fold it again. Each button has its own name. At
1440×960 the Registered volumes card's heading shows under the first block,
so it's plain there is more below. Until 2026-09-29 the list and the picked
unit filled the window from 1100 × 620 and each scrolled inside its card,
and the volumes and the year tables scrolled inside a 70vh box, so the page
looked like it ended at the window's foot.

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
words say the same. Beside the picked unit it shows five rows (six on a
phone), then **Show all N hydrological units and sources** / **Show the 5
to look into first** (`foldList` from `common/fold.ts`, so six rows show
whole). A `unit=` link to a unit further down keeps its rows (both sources)
after the five, so a shared link shows its row on the first screen.

**The picked hydrological unit** (`unit=`, else the first row) sits beside the list: its
name with links to it **On the Network** and in **Hydrological units**; a bar per
water year and source under the caption "Modelled use per water year
(October–September), m³" (modelled use, amber above registered, green within
the band, with the registered volume as a line across it, and its modelled
m³ written beside it; hidden from screen readers, the table under it
carries the numbers); the same years as a table (registered
m³, modelled use m³ "modelled, not metered", modelled ÷ registered, the
status badge with its full sentence in the title, "part (N d)" for a part
year); its registered storage beside the dam capacity in the run, with the
difference and the band in words ("the dam is 50 000 m³ larger than the
storage registered for it (outside the ±10 % band)", `storageSentence`,
issue #72; arithmetic only, whether filling counts as a take is #90); and its
registered volumes (volume, source, authorisation, registration number, the
holder for editors only, validity), each with **Change** and **Delete** for
editors. The bars and the table show the latest six water years (both
sources of each) until **Show all N water years** / **Show the latest 6
water years** (`foldYears`; a run of seven years shows whole), then the
band note ("“Within band” is within ±10 % of the registered volume…", with
how a part year compares; under every unit's table until issue #175). The table
turns into cards below 48rem of its own width (the picked unit's column at
1280 px), so it never scrolls sideways there. Picking a unit far down an
opened list scrolls the page back to its detail.

**Registered volumes** (below the first screen): the list, stacked so it
fits at 1280 without sideways scroll: unit (or **Not matched**, highlighted)
with the registration number under it, the registered user for editors only,
authorisation with purpose, volume with source (**Storage only (s21b)** for a
dam's registered storage, which is never a take, issue #72), storage, validity with where
it came from (the file name and the first 12 hex digits of its SHA-256, or
"Entered by hand") and, when it states any, its licence conditions in one
line ("Oct–Mar only · at most 0.05 m³/s · 2 conditions", `conditionsSummary`,
the conditions themselves in its title), and **Change** / **Delete** for editors (the form's unit
picker is how a row is matched by hand). It shows the first eight, in the
API's order (unmatched first), until **Show all N registered volumes** /
**Show the first 8 registered volumes**, growing with the page rather than
scrolling in its box. Viewers see "Names of registered
users are shown to editors only." Under it, **Imported files**: each with its
full hash, reference, row count, who and when, and **Remove this import**.

**Every hydrological unit and water year**: first the **over/under-use
chart** (`allocations/UsePlot.svelte`, the evidence report's § 5 chart, shared
since 2026-09-29, issue #71 follow-up): one row per unit and water source with a
registered volume, in the list's order (`comparisonUseRows`), one hollow mark
per whole water year at modelled use ÷ the registered volume, a line at
100 % and the project's band shaded behind it; a year past the axis (at most
300 %) is an arrowhead at its edge. One neutral hue: the side of the band is
read from position, never colour. Part years, years with nothing registered
and units with no registered volume aren't drawn (the table lists them). On
screen the chart is drawn px for px at its box's width (`fit`, 11 px text, at
most 900 px wide); below 480 px (a phone) each row's label takes its own line
above its marks, and the band and the 100 % line are drawn in each row's strip
only, so nothing runs through a label (each has a halo on screen). A name cut
to fit keeps the source whole and stays distinct from the others
(`distinctShortNames`); the full label is its tooltip, and each mark's is its
water year and share. A one-line lead above it names the quantity. The
report's fixed drawing never draws its 9 px text under 9.5 px (a 549 px
minimum), scrolling sideways in a focusable box on a phone. Its SVG is named by its title and described by a sentence
counting the whole years above the band and in how many units
(`useSummary`, which the report's chart carries too, per run), from the
engine's own status for each year so it agrees with the table's "Above
registered", counting every row even while the chart is folded (and saying
how many it draws); the caption says what
a mark, the line, the band and an arrowhead are, "modelled, not metered". It
shows the first ten rows until **Show all N in the chart** / **Show the first
10 in the chart** (`aria-controls="alloc-use-plot"`); the axis is the whole
chart's, so opening it doesn't move the marks shown. Then the whole comparison as one table (one row
per unit, source and water year, in the list's order so the units to look
into first come first, each unit's years together, `rowsInListOrder`; a
source with neither use nor a volume is left out), the WUA manager's
cross-unit view. It is the picked unit's table for every unit, so since
issue #175 (2026-09-29) it is folded whole behind **Show all units' water
years (N rows)** / **Hide all units' water years** (`aria-expanded`,
`aria-controls="alloc-all-years"`; `foldList` with no cap, so a single row
shows whole), and its band note moved under the picked unit's table. Until
then it showed twelve rows until **Show all N rows**. Opened, the table
grows with the page.

**Import registered volumes** (the Import sheet, `AllocationImport.svelte`):
what the file is (WARMS extract or CSV template), a reference, the file, and
**Download the CSV template**. The preview says how many rows matched,
didn't, or have problems; the table lists rows with problems first (the
problem in red), then unmatched rows, each with a unit picker ("by farm
name", "chosen by you"); type and source share a column. **Import N rows**
(pinned at the sheet's foot, with **Choose another file**, which drops the
preview and goes back to the file picker, keeping the kind and reference) stores the valid ones, closes the
sheet and says how many were imported, left out and still unmatched. Errors
(a refused file, a file already imported) show in an alert in the sheet;
closing the sheet drops a preview. While the file is read or the import runs
the sheet can't be closed: Close is disabled, and Escape and the ✕ do nothing
(`beforeclose`); while importing, a status line says "Importing… the sheet
closes when it's done." A read or import that answers after the sheet was
closed some other way (Back takes `import=1` away) leaves the sheet as it now
is: a reopened sheet isn't filled or shut by the older request, and a
finished import is still reported on the page.

**Add or change a volume** (`AllocationForm.svelte`, `volume=new` or
`volume=<id>`): unit or water user (or "Not matched yet"), authorisation,
source, purpose, volume, storage, valid from/to, registration number,
property, the registered user (editors), reference, and **Licence
conditions** (issue #72; "a cap run keeps to the months and the rate"): the months
water may be taken (twelve boxes in water-year order, none ticked = none
stated, each a 24 px target), the maximum rate (m³/s) and the other
conditions one a line; Save and Cancel pinned.

**Phone and narrow windows**: one column (list, picked unit, volumes, every
year), with the same folds (the list six rows); each volume and each
year row is a card with its values two to a line under their labels
(container queries); picking a unit scrolls its detail into view.

- e2e: `e2e/tests/allocations.spec.ts` (import, manual match, comparison, a
  viewer without names, phone cards, axe) and
  `e2e/tests/allocations-page.spec.ts` (the header, the order, every fold
  and its button, no element scrolling inside itself wide, at 1280 and on a
  phone, the next card's heading on the first screen, `unit=` and Back, a
  shared unit link kept under the fold, the sheets, `run=` and a deleted
  run, empty states, 1280 and phone layouts, a viewer, axe in both themes; a
  30-unit catchment with 40 volumes from `e2e/support/allocations.ts`, and a
  nine-year run for the water-year fold).

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
  rebase. **Run scenario** runs it; instead of the comparison the
  applicant gets **Your results against the baseline**
  (`ApplicantResults.svelte`, `GET …/scenarios/:sid/results`,
  [scenarios.md § Applications](./scenarios.md#applications-wp-33)): the
  newest run's label and date (and "Your changes have been edited since this
  run" when they have); the **Ecological Reserve** (the outlet's days not
  met, and a table of each EWR site's months met, rate and longest run not
  met, baseline beside theirs); **The catchment** (mean natural and outlet
  flow and a chart of the outlet's flow and EWR, baseline against theirs, or
  why not: fewer than five farm holders); **Your hydrological units**
  (demand, supply, share met, the dam on the last day, baseline → theirs,
  and what ran: crops with their areas and boreholes; a unit their changes
  add is "(new)"); and **Downstream of your units** ("Farm 1 downstream:
  supply −4 %", or "No other farm or water user lies downstream of your
  units"). A run with a baseline assumption shows a note and the Reserve
  only. Before a run: "Not run yet". Under it, **Yield under this
  scenario** offers only their own units and the ones their changes add;
  the applicant (not the people they share it with) queues a yield and
  follows it on the job list, which shows them their own yield jobs only.
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
- **Comments and share links** (WP-3.15), at the top of the panel: the
  application's **Notes** button (the notes drawer on the scenario, titled
  "Comments on “name”"; [§ Notes](#notes)) and, for its applicant and the
  assessors, **Share link…**, which opens the **Share dialog** (a side sheet,
  `ShareLinksPanel.svelte` with a `scenario`): what the viewer will see (its
  changes, the EWR at each site against the baseline, the catchment's totals
  at five or more units, the public comments; never another unit, a member
  or a registered volume), "Who it's for" and "Works for" (1 week to 1
  year), **Make link** and the link shown once to copy, then the links to it
  (live first, who made it, when it ends, last opened) with **Withdraw**. A
  draft or withdrawn application says it must be submitted first and offers
  no form. The assessors list and withdraw every link to it; the applicant
  their own.
- **Evidence packs** (WP-3.14). For the project's viewers and up: each of
  the application's packs with its status badge, "Version n, code
  xxxx-xxxx-xxxx" linking to its [pack view](#evidence-pack), and when it was
  issued or drafted; *None* says an editor makes one from a run's evidence
  report. For its applicant and whoever they shared it with
  (`application-panel-my-packs`, 131_applicant_packs,
  [evidence-pack.md § Applicants](./evidence-pack.md#applicants)): the
  packs that were issued (never a draft), each linking to
  [the applicant's pack view](#the-applicants-pack-view), and when it was
  issued; *None issued yet* says the assessors issue one once it is
  submitted.

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
  "waiting N days" while it awaits a decision), changes and runs, and the
  the application's evidence packs (WP-3.14: each a status badge, newest
  version first, linking to its [pack view](#evidence-pack); *none*, or
  *couldn't be read*, which leaves the rest of the table) and the
  application's comments (the compact notes button, WP-3.15; its share
  links are in its Application panel).
- **Fit:** from 1100 × 620 the card fills the window and the rows scroll
  inside it under a sticky header; below a 640 px column each application is
  a card (name, status, applicant, submitted, "1 change · 0 runs", its
  packs, its comments) and the page scrolls.
- **States:** loading, error ("Retry"), empty ("No applications submitted.",
  with where they come from: applicants on the Project page, the baseline
  published in Runs & results) and a filter with none ("Nothing is awaiting a
  decision." and **Show all**).

**Assess together** (roadmap WP-3.11, `&view=assess` in the URL, so Back
returns to the list; `CumulativeAssessment.svelte`, the pure parts in
`cumulative.ts`): the section header's **Assess together** link swaps the
card for the cumulative impact view, and **Back to the list** swaps it back.

- **Pick:** every submitted or decided application, ticked two or more; once
  one is ticked, an application on another base run can't be (it says
  "based on another run than …"). A **Name**, then **Check they combine** (a
  dry run: nothing written) or **Assess together** (writes the assessment
  and queues its job).
- **Refused, never merged:** when two applications change the same thing,
  or one removes what another uses, each conflict is listed: its target
  (`node "Upper farm": damCapacityM3`), whether both change it or one removes
  what the other uses, and both changes side by side (each application's
  name, change number and the change in words). Changes that apply alone but
  not together (two new dams given one name) are listed too.
- **The result** (the newest assessment, or one picked under **Assessment**):
  while it runs, *Queued* or *Running each application alone and all
  together… N %* (followed every 1.5 s); a refused or failed one says why,
  line by line. Complete: one matrix, rows = each measure at each EWR site
  (the outlet first) and for the catchment (days the EWR is not met, mean
  EWR shortfall, Reserve months met and deficit at each rule-table site,
  mean flow at the outlet, supplied to existing users and their share of
  demand met), columns = **Baseline**, each application **alone**, **All
  together** (each with its change from the baseline under it, coloured
  worse or better) and **Interaction** (together less the sum of the
  separate changes; its plain-words reading is the cell's title and is read
  out), with a one-paragraph explanation of the interaction above it and
  **Download CSV** (the raw numbers, names guarded against CSV injection)
  below.
- Workspace English, like the rest of the assessors' tab.

e2e: `e2e/tests/assess-together.spec.ts` (three submitted applications: a
conflicting pair refused with both changes named, a pair that combines run
by a worker tick into the matrix, the CSV, Back to the list; axe light and
dark).

In the Scenarios tab an
application shows an "Application" tag and "… application by <name>" in the
list; only its owner edits it, and an editor who isn't its owner gets the
**Decide** form (outcome radios, reasons and conditions, **Record the
decision**; final).

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
- **A publication's record** (the season decision log, issue #119;
  `timeline.ts` `publicationRecord`): under a `publication.published` or
  `publication.notice_changed` event, wherever the whole entry shows (the
  detail, or the narrow list), the season window and data-until day, the
  run id with its engine version and runoff model, the inputs' SHA-256, the
  notice in each language it was written in ("Notice (Afrikaans): …"), the
  next publication date, the note, and a collapsed **Figures per farm (N)**
  table (supplied %, demand and supplied m³, short days, dam %, model band).
  `&kind=publication` is the log on its own. Events from before the log
  widened show only their line.
- **Narrow (a phone):** no detail; each entry shows whole under its day, with
  its buttons (44 px targets), and the page scrolls. The two selects share a
  row, the parameter box has its own.
- **Restore this version** (editors) opens a confirm that previews the diff,
  with an optional reason (Enter in it restores, once the preview is in); restore buttons are disabled while there are
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
  ([run-comparison.md](./run-comparison.md)). The Project page's **Recent
  changes** panel (the three newest) was removed in 2026-09 (issue #177):
  History is in the sidebar and its header names the latest change.
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

- **Where:** the node sheet's numeric fields and **Drains into**, its
  Supply section (the supply rule, the river pump capacity, the trigger's two
  levels, the hands-off flow and its EWR tick) and **Set River to dam by
  month**, the dam's survey curve, release rule and release months, the farm
  drawer's planted area per crop (under the crop's name), and Settings &
  calibration's scalar parameters (effective rainfall, soil-water store, dam
  evaporation factor, days in February, catchment area, GR4J X1–X4 and
  warm-up, the rain threshold, the flow-share method, the annual assurance
  threshold, the data-quality thresholds). A twelve-month row set or cleared
  reads as its range on the line ("none → by month: 0–800 m³/day", "300
  m³/day every month", `compactMonths`); History keeps the full row. Other
  monthly tables and rule editors have none.
- **Data:** one `GET …/history/fields` for the whole project
  ([api.md § Field history](./api.md#field-history)), fetched only when the
  first line renders (opening a node sheet, the drawer or Settings), never at
  first paint, and again after a model save, a settings save or a restore.
  The page shares it through context and sets it only for members whose role
  sees History (not farmers or applicants), so no one else fetches or sees
  it; hiding History from one's own sidebar (it is hidden by default) keeps
  the lines. A failed fetch leaves the lines hidden; the fields work as before.

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
  (`notes.spec.ts` checks 30). A half-typed note or an unsaved edit makes
  Escape, the close button and **Close** ask "Discard your note?" first
  (`NotesList`'s bindable `unsaved`). It is not in the URL: it opens from inside
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
- **On a scenario** (WP-3.15, the Application panel and each Applications
  row): the drawer is "Comments on “name”", with a **Who reads it** picker
  of the audiences the caller may post to, their natural one first (an
  assessor: *The assessors only*, *The assessors and the applicant's party*,
  *Public participation: shown with your name on the shared link*, *The
  project team*; one of the application's parties: the parties, the
  assessors, public participation; anyone else, only public participation,
  shown as a line instead of a picker). Each comment carries its audience as
  a badge (Assessors, Parties, Public, Team), and an edited one says
  *edited: history*, a button that opens its earlier texts inline, oldest
  first, with when each was written and replaced (`GET …/revisions`). The
  server holds the matrix (data-model.md § Notes); the picker only offers
  what it allows.
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
reads the project, the run with its settings and model snapshot, the series
list, four catchment series, the run's sign-offs and its place in the
project's publications (`GET …/runs/:runId/publication`, issue #70), and is
its own lazy route chunk. A non-member gets the workspace's "This project
doesn't exist or you don't have access to it"; a farmer (403 on the project)
is sent to their farm page, as the workspace sends them; any other role
below viewer (an applicant) reads "The catchment report isn’t part of your
role in this project."; a project with no runs, or a run that no longer
exists, says so with a link to Runs & results. The Overview's published
baseline card links to the published run's report (**Report**, beside
**Open in Runs**).

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
- **Impact by year class** (issue #53 R7, `report/LicenceImpactBoard.svelte`,
  view model `report/licenceImpact.ts`, in the impact section's chunk): the
  impact section opens with this board, the baseline as the background run.
  One column per water-year class of the baseline's natural flow (the
  project's `settings.outcomes.yearClassMethod`, terciles by default; the
  header shows the bounds and the years compared), and three rows: the
  **annual waterfall** at the outlet, mean m³ a year (Natural flow, Existing
  use in the baseline “<label>”, Proposed use (this run − baseline), Other:
  dams, storage, groundwater, land cover, Flow left at the outlet), the
  **months below the Reserve** at the project's Reserve site (the outcome
  matrix's `settings.outcomes.siteNodeId`; the outlet, with a note, when a run
  has no results there), or days below the pragmatic EWR without a rule
  table in both runs, baseline, this run and the change, and the
  **verdict** in words (`describeLicenceImpact`: "The Reserve was not met in
  4 more months over 7 dry years (…)"), from the months, never from the
  annual totals, and with no verdict colour. A class with fewer than 3
  years reads *Not enough years* in every row. A note under the board says
  existing use is the baseline's as that run modelled it, and that existing
  *authorised* use needs a baseline at every holder's full registered volume
  (a full-allocation run: Settings › Registered volumes › Allocation mode,
  or a scenario that sets it). Against such a baseline the step reads
  *Existing authorised use in the baseline “…”* and the note says so; a pair
  where only one run is at full allocation gets a note under the board
  ([model.md §2.14a](./model.md#214a-licence-impact-by-year-class-issue-53-r7-engine-and-report)).
  The route fetches the board's three series before `data-report-ready`
  (`report/impactSeries.ts`: the baseline's `natural_flow` and
  `ewr_shortfall`, this run's `ewr_shortfall`); one that can't be read, or a
  run from before the water account (engine 0.32.0), shows the reason in
  place of the board. The server PDF prints it too: an impact report's
  render session may read those two baseline series by key
  ([security.md § Render tokens](./security.md#render-tokens)).
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
  evidence in a licence application.** in bold; then the contents; for a
  published run, or one that was, **Published** with the date, by whom, and
  "; the run stakeholders see now" or "; replaced <date>", and the
  publication's restriction notice as a note, "Restriction notice: Restricted
  · 20 %…" (or "(on the publication since replaced)"), then the WUA's text in
  each language it wrote, each marked with its `lang`), then numbered
  sections: **Network** (the schematic of the run's own model, farms
  coloured by supply; the screen scrolls the usual drawing, paper prints the
  wrapped one, in page-high bands when it is taller than a page;
  `report-schematic-print.spec.ts` measures its names in the PDF with
  `pdftotext -bbox`, and checks a 25-gauge main stem prints every name whole
  on one page, none across a page edge), **Inputs** (the run's settings, monthly A-pan, pan
  coefficient and pragmatic EWR, nodes, crops and planted areas, transfers, and
  each input series' dates and days inside the run; `report/inputs.ts`.
  The transfers table gives a river off-take's **Losses on the way** (%) and
  what of them is **Seeping back to the river** ("40.0% of them, below Upper
  farm", the source when no unit is named; "none" by default; engine ≥
  1.42.0, [model.md §2.6a](./model.md)); a dam transfer shows "–" in both.
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
  for the outlet and every farm), **Assurance of supply** (when the run has
  it, engine ≥ 0.32.0: the Runs tab's Assurance panel in print mode, every
  stress grid printed, the system's then each unit's, each under its own
  "Stress classes by month: <name>" heading, with no picker; issue #70),
  **Hydrological units, warnings and checks** (the run
  summary: warnings, headline cards, the farm table; the self-checks and the
  water balance by water year, without Trace a day), **Notes** (the run's
  notes, when it has any) and **Changes since the previous publication**
  (issue #70: against the publication before this run's own, or, for a run
  never published, against the current publication, named with its label,
  date and publisher; who made the saved changes, then the input changes,
  `ChangesList`, as Compare runs lists them). A section appears only when the run has its data;
  nothing is printed as a placeholder. Every report then closes with three
  sections (WP-3.13, `components/liability/`):
  - **Validation statement** (`ValidationStatement.svelte`, the engine's
    `validationStatement`, [model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)):
    engine version, the build's invariant and soak results (the web
    release's build record, `ENGINE_BUILD`, injected at build time; *Not
    recorded for this build* in a build without one, such as local dev), the
    methodology statement it cites (version and a 12-digit hash prefix,
    `docs/methodology/`), the run's self-checks, the
    runoff coefficient (flagged above 1, audit W1), a legacy-model warning
    ("Legacy runoff model (b023 workbook, removed in engine 1.0.0): …"),
    NSE / PBIAS / KGE / log-NSE with Moriasi ratings and the monthly-flows
    caveat, the flagged data-quality years (every one, engine ≥ 1.31.1; an
    older run that hit the old cap of 5 says its list may be cut short) and
    checks, the **errata** of
    the run's engine version or its fit's (ID, what goes wrong, when it
    applies, fixed in; "None recorded for this engine version in
    docs/engine-errata.md" without one), and the **known limitations** table
    (ID, limitation, where it stands) generated from engine-audit.md. The
    sign-off dialog shows the same methodology line, and lists the errata
    after the limitations in the box that must be scrolled to its end. The same component is on screen, folded shut, in a
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
    statements a signer of the current version confirms (`signoff-4`). When
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
  statement, which clears the ticks and the read state. Once anything is
  filled in, Escape, the close button and Cancel ask "Discard the
  sign-off?" first. The Runs tab tags a
  signed run **Signed off**, and the History tab reads "Signed off a run as
  …, Pr.Sci.Nat. (Professional Natural Scientist), SACNASP, …" (an older
  event: "… (SACNASP …)").
- **Components reused, in print modes.** `LineChart`'s `print` prop draws a
  fixed `printWidth` × `height` box at 2 device pixels per CSS pixel
  (`printScale`: uPlot has no pixel-ratio option, so on a 1× screen the plot
  is laid out twice as large and scaled back into the box), with no cursor,
  zoom or controls, the whole period and a plain legend. `EwrHeatmap`'s `site`
  and `print` show one site, named in the heading, without the pickers or the
  keyboard read-out; `EwrAssurancePanel`'s `print` opens Month by month with every month (the
  report renders one panel per site); `SelfChecksPanel`'s `trace={false}`
  leaves Trace a day out.
- **Ready.** Each chart sets `data-ready="true"` on its figure once it has
  drawn (or has nothing to draw), and the page's `<main>` gets
  `data-report-ready` once every fetch is in (including the summary's lazy
  human-impact tables) and every chart has drawn (`isReportReady`). Until then
  the bar says "Preparing the report…" and **Download PDF** is disabled. The
  signal is what e2e waits on, and what the server-side render waits on.
- **Download PDF** calls `window.print()`; the hint says to choose **Save as
  PDF**. Print CSS: A4 (`@page`, added while the page is open,
  `report/printPage.ts`), a running footer on every page in the bottom
  margin from CSS page-margin boxes (`@bottom-center`, Chromium 131+): the
  page's `data-report-footer` (the engine's `REPORT_FOOTER`: project · run ·
  "Model estimates; see the Disclaimer (section N, version …). The operator
  of this software accepts no responsibility to anyone who relies on this
  report.") and "Page X of Y." (a browser without margin boxes, Firefox,
  prints the pages without it), a page break
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
  the running footer included: it comes from the page's own CSS, so the
  renderer adds none of its own (issue #70; it used `footerTemplate` until
  then, which the browser's print didn't have).
  The bar then follows the job's status (`role="status"`: "PDF queued: waiting
  for the background worker…", "Making the PDF…", "The first try failed (…);
  trying again shortly…", "PDF ready (9 pages). The link is on its way by
  email.", or "The PDF could not be made: …"), polling the API every 1.5 s
  until it settles, and offers **Download the generated PDF** (the API's
  `/reports/:jobId/pdf` route, which checks membership on each click and
  redirects to a one-minute pre-signed GET, so the link never goes stale). The wrapper carries `data-state` (`idle`, `starting`,
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
  pending, polling every 2 s), **Download the PDF** once ready (the same
  API route, a fresh one-minute S3 link per click) beside "PDFs are kept for
  7 days.", after a failure a line pointing back to the
  report, and **Open the report in the app** and **Go to the run** (**Go to
  Runs & results** for a scheduled PDF of the latest run). The card's
  `data-state` is the report's state. Anyone else, or a PDF past its 7
  days, gets "This report doesn't exist any more, or you don't have access to
  its project." Tested by `e2e/tests/server-report.spec.ts` and
  `e2e/tests/report-pages.spec.ts` (queued and failed states planted with
  `support/db.ts` `holdReportJob` / `failReport`, a viewer, not found, axe in
  both themes at desktop and phone).

### Evidence report

`/projects/:id/report?run=<runId>&evidence` (issue #71, WP-2.15 Phase C;
`report/evidence/EvidencePage.svelte`, the report itself
`EvidenceReport.svelte` in its own chunk;
[design/evidence-report.md](./design/evidence-report.md)): the licensing
evidence report of one run. `&evidence` swaps the catchment report for this
page; the rest of the route is unchanged. The server builds the whole
document (`GET …/runs/:runId/evidence-report`,
[api.md § Evidence report](./api.md#evidence-report)); the page only draws it.
Viewer role and up; a contributor or farmer is told it needs the viewer role.

- **Two modes**, from the run named. An **application** report: a scenario
  run, reported against the base run it recorded. A **baseline** report: the
  nominated run on its own (no change column, no Appendix C).
- **Entry links.** **Evidence report** on the Runs tab, beside **Report**,
  for the current nominated run or a scenario run; and in the head of a
  scenario's comparison (`ScenarioCompare`), for the scenario's last run.
- **Board 1, the checks** (screen only, open by default): every check the
  engine makes (`evidenceChecks`), failures first, each marked *stops
  issue* or *printed, doesn't stop issue*, with what was found and the fix.
  Among them (`evidence-10`) *Every river pump has a capacity* and, for an
  application, *The application's own river abstraction leaves the EWR in
  the river*, each naming the units it found
  ([evidence-pack.md § What stops issue on the river](./evidence-pack.md#what-stops-issue-on-the-river)).
  Then **Expect questions about:** what an assessor will ask for, with the
  way out (failed checks, "Not assessed" rows, a site without a REC, no stored
  fit, a flagged WR2012 check).
- **Board 2, the refusal.** When a refusing check fails (not the current
  nominated run, a legacy runoff model, a forecast run, another base run,
  another engine version, period or runoff model), the page shows only
  *This run can't be reported as evidence*, the failed checks with their
  ways out, and a link to the ordinary catchment report. Print is disabled.
  A changed baseline assumption doesn't refuse: the report shows as a
  preview under a red banner.
- **Sections**, fixed (`report/evidence/sections.ts`); a section with nothing
  to show prints *Not assessed* and why, never disappears:
  - **Summary** (page 1, `EvidenceSummary.svelte`): identity (the runs, the
    baseline's nomination and whether it is the published run, signers,
    verify), the banner (red when a baseline assumption changed, else "No
    baseline assumption changed"), **Read these first** (the flags, red
    before caution before counts, each saying which way it pushes the
    numbers), the change table (fixed rows, each with its basis: Reserve
    months met per rule-table site, days below the pragmatic EWR, shortfall
    volume, *No-flow days at the outlet* (below 1 L/s, with the longest
    spell), *Days below the EWR, first site below the works* (one row per EWR
    site that is the first below one of the application's storage or
    abstraction works, or *Not assessed* naming the works with no site
    between them and the outlet), outflow MAR with % of natural MAR, the
    applicant's own supply,
    *Registered vs modelled use* (unit-years above a registered volume,
    summed, no band; *Not assessed* without volumes), other users' supply,
    and *Other applications on this baseline, summed* (the other submitted
    or approved applications' own changes in days below the pragmatic EWR,
    added up, no band, its basis saying it is a sum of separate runs and not
    one combined run, WP-3.11; *None* when there are none the reader can
    see)), with the paired band and "worse in k of n"; then **Impact by year
    class** (the impact report's `LicenceImpactBoard`, the baseline as the
    background, the application beside it, worded by `evidenceBoard` from
    the report's `licenceImpact`, which the engine builds on the server from
    the runs' stored series and the project's `settings.outcomes` (the
    year-class method and the Reserve site, as the impact report reads
    them), so an [evidence pack](#evidence-pack) prints the same board from
    its manifest; *Not enough years* per class on a short record, and the
    note when only one run is at full allocation); *Where
    the river loses most* (the three worst months by paired median, the
    longest run of Reserve months missed, the worst month-year) and *This
    report does not decide*.
  - **1 The river**: per rule-table site, the site strip (source, component,
    unit, the REC from the rule table or *Not given*, EWR % nMAR, natural MAR
    against the determination's, and, when there are any, the months whose
    natural flow is drier than the table's driest point, where the
    requirement is scaled with the flow: G16, also a caution flag on page 1),
    the two heat maps (`grid.ts`, month × water year,
    shaded by the share of the requirement delivered, failures the heavier
    mark, lost and gained months outlined, the number in each cell), the
    paired extra days below the EWR by month (`IntervalPlot`, outlet only),
    the FDC check against the EWR curve (`FdcPlot`: from engine 1.33.0 the
    baseline's 5–95 % band shaded behind its line and the application's
    hatched, or the caption says why there is none) of the month the report
    ranks first (the largest drop in months met, else the one met least
    often) and, beside it, of the river's driest month (the lowest mean
    natural flow in the baseline, `fdcDriestMonth`; one plot, captioned as
    both, when they are the same month; `grid.ts` `fdcMonths`). From
    `evidence-7` an application report has a small table under each plot
    (`evidence-fdc-change`): the paired change in the curve at each table
    point, as the median, the 5 to 95 % range and the runs' own difference,
    and "the application's flow lower in k of n sets" (`grid.ts` `fdcChangeRows`). The caption
    (`fdcCaption`) then reads the shading as each run's own spread; where the
    application's band is drawn with no table (a pack issued before
    `evidence-7`, or runs read at different table points or units) it keeps the
    warning that overlapping ranges don't mean no change. Then the
    compliance table. Then the application's EWR charge.
  - **2 Uncertainty**: the coverage banner, the declared rule and the cited
    ensemble, the ledger of every ensemble started on the baseline (and how
    each departs from the rule; a start not completed reads *started, not
    completed: no result stored*, with a note that the app keeps nothing of
    it but who, when and its rule, since the browser stores an ensemble only
    when every set has run), the baseline's bands (R1), the paired bands
    (R2) and the printed rules.
  - **3 Model and data**: calibration record, validation (`FitProvenance`, or
    *Not assessed* without a stored fit), WR2012, the validation statement,
    and the nomination history.
  - **4 Other users** (baseline: *Every user's supply*): each unit's supply,
    days and years fully met, baseline and application, the change with its
    paired band and "worse in"; then *Served in full while an EWR site below
    fails*: per EWR site, the days each unit upstream got its whole demand on
    the site's failing days (`data-testid="evidence-served"`), and a "read
    these first" count naming them.
    Then **Other
    applications on this baseline** (`evidence-cumulative`): each other
    submitted or approved application, its status and its own change in days
    below the pragmatic EWR and in Reserve months met at the outlet, the sum
    of those counted (same engine, period and runoff model; any other says
    why it isn't) and the sum with this application; the words say it is a
    sum of separate runs, not a combined run (WP-3.11), listed as the reader
    can see them; past 50 the newest 50 are listed and nothing is summed
    (page 1's row then *Not assessed*).
  - **5 Registered water use** (WP-3.10,
    [allocations.md § In the evidence report](./allocations.md#in-the-evidence-report)):
    the allocation mode each run ran with, the band, volumes on no unit; the
    over/under-use chart (`UsePlot`, `registeredUse.ts`: a row per unit and
    water source, a mark per whole water year at modelled ÷ registered,
    hollow for the baseline, filled for the application, the 100 % line and
    the band shaded, one neutral hue, a year past 300 % an arrowhead at the
    edge); the whole years above, within and below per unit and source with
    the mean volumes; and every water year's registered volume and modelled
    use, part years listed but not counted. In a cap run, *What the cap held
    back* (`evidence-allocation-cap`, `evidence-6`): per unit and source it
    caps, the days the licence limit held use back by limit and the years
    the volume was used up, in the Allocations page's words (`capYearsText`),
    "Not capped" for the run that doesn't cap it. Units by their unit name,
    never the holder's. *Not assessed* when the runs carry no volumes, or
    none on a unit of theirs.
  - **6 The applicant's demand objects** (application only, report format
    `evidence-9`, issue #259): every demand object on the applicant's units
    (theirs, or a unit the application adds), as the application ran it and
    one it removes as the baseline did (`evidence-demand-objects`): its unit,
    name and category, what the application does to it (*Added*,
    *Changed*, *Removed*, *Unchanged*), its sizing in words
    (`demandObjects.ts` `sizingText`: "20 m³/day every month", a range and
    mean by month, or "400 × 230 l a day, 10 % losses"), its source with the
    note under it as entered, its mean demand in each run and its share
    supplied in the application. Above the table the by-source line the
    run's demand-objects table prints ("Of their demand, 30% is from meter
    records and 70% not recorded", `evidence-demand-sources`) with the rule.
    Page 1 gets a caution when most of that demand isn't from meter records,
    and the checks' *Expect questions about* one per object with no source;
    the notes stay in § 6, never on page 1. *Not assessed* when the
    applicant has no demand object (`evidence-demand-objects-na`). A pack
    drafted before `evidence-9` has no § 6: its sections print as they
    always did.
  - **Appendix A** (A.1 settings, with the declared rule; A.2 the ops with
    their class and the input diff; A.3 series and SHA-256; A.4 baseline
    history since the previous publication; A.5 warnings verbatim; A.6 every
    application run on the baseline), **Appendix B** (B.1 methodology,
    limitations and errata; B.2 sign-off; B.3 disclaimer; B.4 verify, *Not
    issued* for a draft), **Appendix C** (application only): the fixed prompts
    first (`evidence-8`), each prompt's heading and question, then the
    scenario's answer verbatim or *Not given.*; then the scenario's
    description and the run's notes, verbatim. The only free text the
    applicant writes as a statement (§ 6's source notes are model data, one
    line each). A pack
    drafted before `evidence-8` froze no prompts, so its Appendix C says they
    aren't part of the pack rather than printing *Not given*.
- **Evidence packs of this report** (screen only, under the checks): the
  packs of this run's report (an application pack by its scenario run, a
  baseline pack by the nominated run), each with its status badge, version,
  code and date, linking to its [pack view](#evidence-pack). For an editor,
  when the report may be issued, **Create evidence pack** drafts one and
  opens it; once the application (or the baseline evidence) has an issued
  pack the button is **Create version n+1 of the evidence pack**, which
  supersedes it when issued. A report that may not be issued says a pack can
  be made once every check that stops issue passes.
- **Draft stamp.** Every section head and the footer (`data-report-footer`)
  read *Draft · not issued* until an evidence pack issues it (WP-3.14), and
  in print a diagonal *Draft · not issued* watermark crosses every page
  (`position: fixed` in `@media print`, which Chromium repeats on each page;
  `aria-hidden`, the text stamps being the accessible ones), so a cropped
  page still says it.
- **Ready and print.** `data-report-ready` follows the catchment report's
  contract (every fetch in, every chart drawn). **Download draft PDF** is the
  browser's print (always light, A4). There is no server-rendered evidence
  PDF yet: it comes with the issued pack (WP-3.14).
- Tested by `e2e/tests/evidence-report.spec.ts`, for § 5 with volumes
  `e2e/tests/evidence-allocations.spec.ts`, and for § 6 with objects
  `e2e/tests/evidence-demand-objects.spec.ts`.

### Evidence pack

`/projects/:id/packs/:packId` (`routes/projects/[id]/packs/[packId]/+page.svelte`;
WP-3.14, issue #71, [evidence-pack.md](./evidence-pack.md)): one evidence
pack, rendered with the evidence report's own layout (`EvidenceReport`)
from the pack's frozen manifest (`GET …/packs/:packId`), never from the
live run. Viewer role and up; farmers read no pack, and an applicant reads
their own application's in [their own view](#the-applicants-pack-view).

- **The stamp** on every section head and in the footer
  (`packs/pack.ts` `packStamp`): *Draft pack · not issued*, *Issued · version
  n · date*, *Superseded · version n · issued date*, *Withdrawn · version n*
  (with its issue date when it had one). Once issued, every section and the
  footer also print the manifest SHA-256, the short code and the verify link
  `{origin}/verify/{code}` (`packVerifyLine`), and Appendix B.4 lists them.
  The footer is `data-report-footer`, which a server render prints on every
  page; `data-report-ready` follows the catchment report's contract, so e2e
  and the renderer wait on it. Printing is A4 and light. The page reads only
  the pack and its sign-offs, and the project for the caller's role; a
  render session, which may read only the first two, skips the project, and
  a project that can't be read leaves the pack shown without the editor's
  moves. After a sign-off, issue or withdrawal the page reads the pack again
  quietly; if that fails, the pack stays as it was, under an inline alert
  with **Try again**, and `data-report-ready` stays set. Only the latest
  load is applied, so following **Open the newer version** while a load is
  in flight can't show the older pack.
- **What isn't frozen is left out.** A pack drafted before report format
  `evidence-5` has no licence impact board in its manifest, so it prints a
  line saying the board is not part of the pack (a new version carries it)
  instead of building one from live data.
- **The bar** (screen only): Back (to the application in Scenarios, or the
  baseline run in Runs), the status badge, **Download PDF** (the browser's
  print), **Download manifest** (the canonical RFC 8785 bytes the hash is
  taken of, `evidence-pack-<code>-manifest.json`, so the file checks on the
  verify page), **Download reproduction bundle** once issued (the API's
  redirect to a signed GET, `pack-<code>.zip`;
  [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)),
  **Verify page** once issued, **Share link…** (an editor, once it was
  issued) and **Notes**, and the version, code, manifest hash, PDF hash
  (or that none is recorded) and the bundle's hash. When an erratum found
  since the manifest was frozen applies to either run's engine or its fit's
  (`errataFoundSince`, 132), a warning lists it: *Errata found since issue*,
  saying the pack never records them, or on a draft *Errata found since this
  draft was made*, saying it can't be issued until the pack is drafted again
  (`packs/pack.ts` `errataFoundSinceNote`); the draft's checklist then fails
  its errata item (`errataRecorded`), so **Issue pack** is disabled, and the
  API refuses the issue anyway (`pack_errata_since_draft`). The report below, and so the PDF, prints only the
  errata the manifest recorded.
- **Share link…** (WP-3.15, 128_pack_share_notes) opens the same
  `ShareLinksPanel` as an application's Share dialog, for this pack: what a
  link shows (verify's fields, and while it stands the river's figures, never
  a unit), then make a link (who it's for, how long), copy it once, and the
  pack's links with **Withdraw**. A withdrawn or superseded pack's dialog
  says only an issued pack can be shared and still lists its links, each
  saying it now shows only that the pack no longer stands.
- **Notes** (`NotesDrawer`, target `pack`): the team's notes on the pack and
  its public comments, with an audience picker (*The project team*, and
  *Public participation* while it is issued; the server refuses the second
  while no link is live), each note's audience badge and its edit history.
  Not in a render session.
- **Where it stands** (`packs/PackActions.svelte`): a draft's checklist from
  the API (the frozen report may be issued, both runs still carry the
  server's stamp, signed under the current pack statement), each ticked or
  with what to do; an issued pack's issue stamp; a superseded pack's link to
  the newer version; a withdrawn pack's reason, marked as shown publicly. A
  red alert when the stored manifest no longer matches its hash. For an
  editor: **Issue pack** (enabled once every line is ticked; a confirm says
  the verify page then answers publicly with the signers' names), **Delete
  draft** (an unsigned draft only), **New version…** of an issued pack (a
  new draft from the same run's report, superseding it once issued),
  **Withdraw…** (a dialog asking for a reason, 1–1 000 characters, that says
  the reason is public). The server holds every rule and its refusal is
  shown with the ways out it names.
- **Sign-off** is Appendix B.2's, against the pack statement: **Sign off this
  evidence pack…** opens the run's sign-off dialog with the pack's version,
  manifest hash and engines, the eleventh confirmation, and first a warning
  that the signer's name, registration and date are shown publicly on the
  verify page, for as long as the pack exists.
- Tested by `e2e/tests/evidence-pack.spec.ts` (create from the report, sign
  in the dialog, issue, the stamps, verify line and footer, the manifest
  download, withdraw; an application's packs in the Applications tab and
  panel, and version 2 superseding version 1), `e2e/tests/pack-share.spec.ts`
  (share link, notes) and `packs/pack.test.ts`.

#### The applicant's pack view

`/projects/:id/scenarios/:sid/packs/:packId`
(`routes/projects/[id]/scenarios/[sid]/packs/[packId]/+page.svelte`;
WP-3.15, 131_applicant_packs, [evidence-pack.md § Applicants](./evidence-pack.md#applicants)):
an issued (or since superseded or withdrawn) pack of the caller's own
application, from `GET …/scenarios/:sid/packs/:packId`, the D2 projection.
Part of the workspace, so English, like the rest of the Applicant view
([§ Language](#language)); its words are in `packs/applicantPack.ts`.

- **The head**: *Evidence pack vN · title*, the status badge, **Share
  link…** (the application's owner, whatever its standing, so they can
  withdraw their links too; making one needs it issued), **Verify page**,
  where it stands (`standingLine`: issued and standing; replaced, with
  **Open the version that replaced it**; withdrawn, with the reason), and a
  note that this is their copy: their own units by name, the others
  downstream under the names the rest of the application gives them; the assessors' copy, its PDF
  and bundle name them; issuing and withdrawing are the assessors'.
- **The river**: the Reserve at each EWR site (the outlet unnamed) and the
  river's rows of page 1's change table with the likely range, the volume
  rows only when the API gives them (a line says why not otherwise).
- **Hydrological units**: *Yours* (share of demand supplied, baseline, with
  the application, the change in points and its likely range; a unit the
  application adds says so) and *Everyone else downstream* (a one-line
  count of who gets less and who more, then each farm or water user
  downstream of the application under the name the results view and the
  map give it, "Farm 3", with the change in whole points; when the run's
  base is no longer published, a line says why none is shown). When the
  report changed a baseline assumption, a line says why no unit is shown.
- **Check this pack**: the code, issue date, manifest, PDF and bundle
  hashes, the errata found since issue when verify names any (132; the
  same note as the pack's page and verify), and the signers. No download:
  the PDF, manifest and bundle are the assessors' copies. The "pack issued"
  and "pack withdrawn" emails (133) link the applicant here.
- 404 (not theirs, not issued, another application's) and 403 each have
  their own line; the Back link returns to the application.
- Tested by `packs/applicantPack.test.ts` and
  `e2e/tests/applicant-pack.spec.ts` (from the Application panel to the
  view, their farm named and the neighbour beside it, not downstream, not
  listed (as in the results view), no download, the
  errata found since issue, a share link opened signed out, axe, the phone
  layout).

## Help (`/help`)

Every help page shares one shell (`routes/help/+layout.svelte`): the search
box heads the page, above the text, and a contents list
(`help/HelpNav.svelte`: the overview, then four groups, *Start here*,
*How it works*, *How to* and *Reference*, the last the glossary's index and
one link per topic) marks the page you're on (`aria-current`). Each group's
name is a heading (`h2`, not a link) and names its list; its links are
indented under a thin rule, so a group reads as a block (issue #162). One
group shows its pages at a time: the heading holds a disclosure button
(`aria-expanded`, a chevron), the group holding the page you're on opens by
itself as you move between pages, and opening another closes it (on the
overview and search the last one opened stays open). With all four open the
list was ~1180 px tall, so the sticky column scrolled inside itself at
1440×960 and 1280×800; with one open it is ~570 px at most and fits both
(`help.spec.ts` checks each group, opened from the keyboard, and that together
they reach every link). The contents never change as you scroll. From 900 px the contents are a 13rem column in the page,
against the app sidebar, beside the text, sticky while you read, scrolling on their own only in a
window shorter than the overview plus the longest group (~620 px), where the alternative is
clipping links. The column fits the window exactly
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
  header and each page's actions in it, the notice line, the Tables menu's grid
  modal and the node and crop sheets, and every way into the farm drawer),
  and *Compare runs and try what-ifs* points at the Compare runs tab.
  An old `/help#<term>` link goes on to the term's glossary topic page.
- **Guides** (`/help/guides/<id>`, content in `lib/help/guides.ts`): one task
  or one idea each, with an "On this page" list (a box under the intro; when
  the Help text column is at least 56rem wide, a container query on
  `help-main`, a sticky rail pinned to the column's right edge instead). A
  guide spans the Help column like the overview (issue #162), and so do
  its body text, notes and lists (no 44rem measure since 2026-09-30, which
  left half the column empty beside the figures), along with diagrams,
  picture tours, formulas and the terms table (a
  diagram is drawn at most 1.3 times its viewBox width, centred, so a small
  one's text doesn't balloon). The list
  marks the section being read (`aria-current="location"`, in bold; the last
  heading past a line near the top, `lib/help/spy.ts`, or the last section at
  the end of the page, unless a link jumped to a section still in the window,
  which stays marked; nothing while the intro shows), and a link to one
  section (`/help/guides/<id>#<section>`) lands on it and focuses its heading
  (`holdAnchor`). Numbered steps, tip and
  caution notes, formulas, diagrams, picture tours (a farm's day, GR4J's
  stores under the ground, the outlet gauge, the transfer, the EWR reach), the
  glossary terms it uses and related guides. There is no previous / next
  pager (the contents already mark where you are). Guide text is
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
  `data-scroll-region`), which only a phone should need. Every drawing is
  at most 660 units wide, so it fits the guide's column whole from 1280 px
  (582 px there; 660 × 9.5 / 11 = 570): the model pipeline (920, which
  shrank its notes to 7 px in the old 42rem column) now runs top to bottom,
  the workflow's seven steps sit in two rows, and the calibration loop, the
  validation tests and the rain sources (720) were drawn tighter
  (2026-09-30; at 720 and wider they scrolled up to 213 px sideways at
  1280). `help/diagrams/width.test.ts` holds the 660 and forbids a text size
  of a diagram's own; `diagram-labels.spec.ts` checks none scrolls at 1440
  or 1280. It is also never drawn wider than 1.3
  times its viewBox, centred in its frame, now that a guide's figures span
  the Help column. A label
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
- **Glossary**: every entry (`lib/help/content.ts` joins `tips.ts`,
  `articles.ts` and `farmer.ts`), one page per topic (issue #162; it was one
  54,000 px page). `/help/glossary` is the index: each topic with its count
  and its terms, linked. A topic is `/help/glossary/<topic>`, the slugs in
  `lib/help/glossaryLinks.ts` (`TOPIC_SLUGS`; they are URLs, so a renamed one
  needs a redirect), with a stable anchor per term
  (`/help/glossary/<topic>#<id>`, `glossaryPath`) that the ⓘ help tips,
  guides, search and "See also" link to. Its "On this page" rail lists the
  topic's terms and marks the one being read (`lib/help/spy.ts`; a term a
  link jumped to stays marked when that scrolls the page to its end), pinned to
  the column's right edge as on a guide; it scrolls on its own when the topic
  has more terms than the window holds. Search is the way to find one term.
  An old link to the one-page glossary (`/help/glossary#<id>`), or a term
  linked under the wrong topic, goes on to its topic page
  (`glossaryLinks.test.ts` fails on any app link still written the old way).
  An entry shows its short and full text, units, where it applies, other
  names and related terms, but not its `source` (a workbook sheet,
  `docs/model.md §…`, an audit finding, an issue): that is for maintainers,
  kept in the data, and `content.test.ts` fails if the reader-facing text
  names a developer document or issue. The
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
  the WUA on …. Data up to …", amber with its age when stale: "Data up to
  10 Jan 2024 (9 days ago)"; while stale, "Last 30 days" on the cards below
  becomes "30 days to 10 Jan 2024"); the WUA's
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
  wording; **Your registered water** (issue #72, `farm/RegisteredCard.svelte`,
  wording in `cards.ts` `registeredCard`, section `farm.registered`), only
  when something is registered on the farm: its own surface and groundwater
  volumes a year and dam storage in force today (`FarmView.registered`, no
  name or registration number), the season's modelled supply beside the
  year's registered volume, the modelled dam beside the registered storage,
  and "A registered volume is not an entitlement, and it doesn't say whether
  a use is lawful"; "Looking back", the model's card (dashed, neutral "Model: …"
  chip, never the notice's fills), a single link line under a `restricted`
  notice and when the river asked for no cut, since its % would only repeat
  the water-received card's (`cards.ts` `lookingBackFolds`, issue #177); the last 12 months (inline SVG bars at the rendered width, a
  summary sentence and a full table behind "Show the numbers": each month's
  needed and received, and under the received a line with the share of the
  need and the engine's stress class in plain words ("99 % · all or nearly
  all"; a line in the cell, not a fourth column, which didn't fit a 320 px
  phone in Afrikaans) (all or nearly all ≥ 95 %, a little short
  ≥ 85 %, short ≥ 70 %, very short ≥ 50 %, far too little; `chart.ts`
  `supplyLevel`, `STRESS_THRESHOLDS`, issue #70), and a line under the table
  saying what the words mean; last
  season; the farm on the river (counts, the outlet's last 30 days, the
  privacy sentence and "Who can see my hydrological unit", which loads the people by name
  and role when first opened, `GET …/access`, and falls back to the roles
  alone if that fails); **Your hydrological unit on the map** (issue #326
  A3, `farm/FarmMapCard.svelte`, wording in `farm/farmMap.ts`, section
  `farm.map`), only when the farm has a parcel or dam of its own on the map
  (`GET …/map`, [maps.md § The farmer's map](./maps.md#the-farmers-map)):
  what the map shows and that it shows no other hydrological unit, "Your land
  is coloured by the model’s look back: **Model: watch**" (no line without a
  band), each feature in words ("Your land: Vaalbank (3 000 ha)", "Your dam:
  …", "Rivers: …", "Gauges: …", "The catchment boundary"), "Where: about
  33.684° S, 21.320° E.", and "There is no background map here, so only these
  are drawn." when the build has no basemap tiles; then the map itself, a
  280 px `CatchmentMap` loaded as its own chunk (`farm/FarmMapCanvas.svelte`,
  MapLibre a chunk further), with its words, zoom buttons and keyboard hint in
  the reader's language, and a one-line key (the land in its band's colour,
  "Your land · Model: watch", the dam, river, gauge and boundary drawn as the
  map draws them). A failed request says so in one line; the offline view
  leaves it out; "Notes about your hydrological unit" ([§ Notes](#notes)); the
  CSV download. The CSV download fetches the file (the farm's last 365
  days to `dataUntil`, in whole m³, headed by the series keys; api.md
  § Farm) and puts the estimate line (`cards.ts` `disclaimer()`), in the
  page's language, as a leading `# ` line, names the columns in plain words
  with their unit in the page's language ("Water you received (m³/day)",
  `FARM_CSV_COLUMNS`, sheet section `farm.csv`), and, for a language whose
  decimal mark is a comma (Afrikaans), writes `;` between cells and a
  decimal comma, so Excel in af-ZA opens it in columns (`farm/csvNote.ts`
  `farmCsvForReader`, issue #124); a failed download says why under the
  links. **Next 14 days** (WP-2.12, `farm/ForecastCard.svelte`,
  wording in `farm/forecastCard.ts`) comes after "Looking back" only when
  the WUA published a forecast run: a "Forecast" kicker and a dashed edge
  set it apart from the cards about what happened; "Lowest dam level
  expected: about 38 % around 20 Jan" (no dam, no line), "You may be short
  on 3 of the 14 days" (or that the model doesn't expect a short day), and
  the forecast's own dates with "Forecasts change, and this is worked out
  by the model, not a promise. Only a notice from your WUA or from DWS is a
  restriction." A forecast made more than 3 days ago says how old it is
  first. The dam page shows the same card under its chart. **This season**
  (issue #53 R5, E3, `farm/OutlookCard.svelte`, wording in
  `farm/outlookCard.ts`, section `farm.outlook`) comes next, only while the
  WUA has a seasonal outlook published and its season hasn't ended: a
  "Season outlook" kicker and a dotted edge; "Your WUA set irrigation at
  85 % for 1 Oct to 30 Apr." (the level as the WUA labelled it); "In 24
  past years’ weather, at this level you got about 81 % of the water you
  needed, and between 62 % and 97 % in most of them" (10th–90th percentile;
  too few years or no demand says so); the dam at the season's end the same
  way (no dam, no line); "Your WUA reviews the level on 1 Jan."; and
  "Worked out by the model from past years’ weather: not a forecast, and
  not a promise. Only a notice from your WUA or from DWS is a
  restriction."; then "What is the season outlook?", a link to the
  `farm-season-outlook` entry on `/farm/words` (issue #122). Only this
  farm's own figures ever reach the page (`FarmView.outlook`, api.md §
  Farm). The farm page imports the card only when `outlookCard()` returns
  one, so it is a chunk of its own (under 1 KB gzipped) that a farm with no
  outlook published never downloads. That chart
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
digest). The modeller workspace stays English, and so do the public
methods and verify pages (their readers are assessors).

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
  also sets the farm view's volume unit (m³ or ML; saved as chosen, one save
after another in order, and a save that fails puts the radios back on the
saved unit with the error above them). There it is `segmented`:
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
  The landing page is prerendered once per language (issue #137): `/welcome`
  ships `lang="en"` (`app.html`) and `/welcome/af` `lang="af"`, set at build
  time by `hooks.server.ts` from the language its words came out in
  (`wordsLang()`, so still `en` if the catalogue were incomplete); the root
  layout leaves it alone until the i18n module is loaded, then keeps it in
  step as elsewhere ([§ Landing page](#landing-page)).
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

## Invitations

Adding someone by email is always an invitation (issue #136; [api.md § Your
invitations](./api.md#your-invitations)): an account that already exists
joins a catchment or team only when its holder accepts, so nobody is made a
member unasked, and the person adding never learns whether the address has
an account. The Members, Farmers and team panels say "Invitation sent to …
They'll join as … once they accept it." and list the invite as pending until
then.

- **`/account/invitations`** (`routes/account/invitations/+page.svelte`, in
  the account pages' frame, so a farmer sees it in the farm view's): one card
  per invitation with the catchment's or team's name, who sent it, the role
  in words ("as a farmer"), a farm invite's farms, the date it closes, and
  **Accept** / **Decline**. Accepting says "You joined …" with a link to it
  (a farmer's to their farm), declining "You declined the invitation to …";
  one that went meanwhile (revoked, expired) reloads the list with the error.
  Empty state: "You have no invitations waiting." Its words are translated
  (section `invitations`). Linked from the account page's **Your
  invitations**, the invite email, and the banner.
- **The invitations banner** (`auth-extras/InvitesBanner.svelte`, in
  `routes/+layout.svelte` under the confirm-email banner's place, for a
  confirmed address only): "You have N invitations waiting." with **See
  invitations**, on every signed-in page but the invitations page, while any
  wait. The count is read once per account, again after an accept or
  decline, and when the tab comes back into view (`auth-extras/inviteCount.svelte.ts`).
- The register page, opened from an invite link by an account that is
  signed in and confirmed, points to the invitations page instead of saying
  it should have access already.

## Alerts

Email alerts (WP-2.13; [api.md § Alerts](./api.md#alerts), [security.md §
Alerts](./security.md#alerts)). The workspace's words are in
`lib/components/alerts/alerts.ts` (English, no message catalogue: the
workspace never loads it), the translated pages' in `alerts/words.ts` (from
the catalogue, [§ Language](#language)); both unit-tested.

- **Summary → Active alerts** (`alerts/AlertsPanel.svelte`, under Needs
  attention): the alerts firing now, each as a sentence ("Farm One: dam
  about 8 % on 20 Sep 2026 (alert below 30 %)", "EWR at the outlet at risk
  on 5 of 14 forecast days (alert at 3)", the late or failing feeds and
  series sent by API key (headed **API data behind**, its email's subject
  too), "3 of 14 hydrological units short from … to …, in figures
  an auto run published (alert at 1)"), or "No alert is firing". An editor gets **Set up alert emails**, which loads the
  rule editor (`alerts/AlertRulesEditor.svelte`, its own chunk, fetched on
  the click): a checkbox per catchment kind (EWR at risk in the forecast,
  restriction notice, background jobs failed, data feed failing,
  hydrological units short (automatic publications)), per farm dam, under
  **Data feeds behind**, per data feed ("CHIRPS daily rainfall (Upper)",
  "(feed switched off)" when it is), and under **API data behind**, per
  series an API key writes, named as the Data page names it (its name, else
  its kind's label, `seriesDisplayName` in the engine, which the mails use
  too), "(no API key sends it now)" once a person wrote over the key's days
  (issue #120: a hand-uploaded series has none), each with its level (dam % of capacity;
  days, a feed's past its own usual delay, defaulting by source, a series'
  with no new reading past yesterday's, 2 by default; failures, jobs or
  units short in the last 7 days; range-checked in the form and by the
  API; while staleness alerts are on for anything, an unsaved feed's or
  series' rule shows as on, since the next evaluation switches it on and
  Save writes every row), a
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
  "Forecasts change." The units-short alert, staff only too
  (`mail.alert.model.short.staff`), says it is the model's estimate from
  figures an auto run published by itself, without a person checking them
  first, and not a measurement or a restriction; its body gives counts
  only ("… from 20 Sept 2026 to 26 Sept 2026: 3 of 14"), never a farm's
  name. A restriction notice (`mail.alert.restriction.wua`)
  says it is the WUA's own, shown as published, and that questions go to the
  WUA; its percentage reads as a cut, "a 20 % cut in registered water use",
  written whole as the farm page writes it (`cutPctText`: never "12.5 %"),
  and the WUA's own words are marked with their `lang` when they are in
  another language than the mail (issue #51). The operational alerts (data feed behind, API data
  behind, data feed failing, background jobs failed) are no model figure and carry no liability line.
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
  also the opt-in kinds (dam alerts for every farm, the EWR forecast, units
  short of water);
  editors and owners the operational kinds. A choice saves when made
  ("Saved." in the card's head); the switch stays usable while it saves
  (disabling it dropped the keyboard's focus), and a catchment's saves go
  to the server in order, the page taking the server's answer once the last
  is back. An alert the catchment hasn't switched on yet is starred, and the
  card's footnote (also each starred row's description) says "Not switched
  on for this catchment yet: you get nothing until the WUA turns it on." A
  catchment muted by a digest's unsubscribe says so, with *Turn alert emails
  back on*; once it is, the note and its button go and the focus moves to
  the card's title. A save that fails shows the error in the card and puts
  the switch back where the server has it (each radio is set from the
  server's answer, not left as picked). An owner's four catchments fit 1440 × 960 unscrolled; thirty
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
  back on." in a status line). The banner and its button go, so the focus
  moves to a title that stays: the page's title on `/account/alerts`, the
  **Alert emails** panel's title on the account page. Turned back on and
  refused again within a day, it says to check the address and try tomorrow.
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
  the reserve, dashed, over the last 24 months (`recentMonths`; the page
  loads every month of the run for the member summary); inline SVG at the rendered
  width, a summary sentence and a table behind "Show the numbers"), only
  when the series come back, otherwise a line saying that with so few farms
  the flows could reveal a farm's use; and **About this page** with the
  farm count, how long the link works, and that the result is no
  authorisation, licence, allocation or restriction under the National
  Water Act (that it is a model estimate that can be wrong is the caveat
  under the name, not repeated here). Under the reserve, **Print a summary
  for members** (`share/SummaryControls.svelte`): a **Period** select (*The
  last 30 days*, *This season*, the default, or *The whole model run*; the
  chosen one's dates on a line under it, so the select never cuts them off)
  and **Print or save as PDF**, which opens the browser's print dialog.
- **Member summary (issue #118):** printing the catchment view prints a
  one- or two-page summary for a WUA to send its members, not the screen
  (`share/MemberSummary.svelte`, words in `share/summary.ts`, the
  `share.summary` section). It is the share page re-laid for A4, over the
  period chosen, from the same answer: no second renderer, no new data, and
  nothing a link doesn't already show (the counts are `catchment_view`'s
  last 30 days, season or whole run per EWR site; the chart is the same
  k-ruled series). On paper: "Water Management · Member summary", the
  catchment's name, the period with its dates, the published line and
  "Printed on *date*." (the day of the print, set on `beforeprint`), the caveat; the WUA's notice (level, words, the %
  when it gave no words, who published it); each EWR site's reserve over
  the period, always with its dates ("Below its reserve on 12 of the 102
  days from 1 Oct 2023 to 10 Jan 2024."); the monthly flow chart over the
  period's months (never fewer than 12, counting back from its last; drawn
  at a fixed 680 px and scaled to the page, with its caption and verdict
  printed rather than the screen's table; past 24 months the axis labels
  years, not bare month names), or the line saying why there is none; what
  the page is (the reserve explained, as About says on screen), the farm
  count and the National Water Act line. Never the link (it
  is the credential), the header, the language switch or the legal links.
  A4 with 14 × 12 mm margins (an `@page` rule the page adds while the view
  is open), black on white whatever the screen's theme. Hidden on screen;
  in print the page hides everything else (`.screen-only`).
  `share-links.spec.ts` prints it for each period and checks it is one or
  two pages, names no farm and never prints the token.
- **Layout (issue #17):** one column on a phone (560 px at most). Once the
  page is 860 px wide (a container query) the result is 1120 px wide in two
  columns under the name: the notice, the reserve and the print card on
  the left, the flow
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
- **A scenario link** (WP-3.15, `/share#t=…&k=scenario`,
  `share/ScenarioView.svelte`, words in `share/scenario.ts`, the
  `share.scenario` section): the same shell, header and states, reading
  `POST /share/scenario`. Top to bottom: the application's name, "An
  application in *catchment*, shared read-only", where it stands
  ("Submitted on *date*, awaiting a decision" or the decision and its date),
  the caveat; then in the left column **The river's ecological reserve
  first**: for each EWR site (the outlet unnamed) the months the Reserve is
  met on the baseline beside the application, and the change in words
  ("2 months more below the Reserve with this application", in red when
  worse), and the days below the EWR at the outlet; or why there are no
  results (not run on its current changes; or not stored by the model run
  itself, so not shown). Then **What the application changes**: each change
  in words, the applicant's own unit by name and any other as "another
  hydrological unit", marked *Proposal* or, in red, *Baseline assumption*
  (with a line saying what that means), and the description. In the right
  column: the decision's reasons (once decided), **The catchment's totals**
  (flow out, water supplied, units short of 95 % of demand, baseline and
  application; only at five or more units), **Public comments** (oldest
  first, author and date, *edited*), and **About this page**. A signed-in
  member gets **Add a comment** (posted for public participation, "Shown
  with your name to everyone this application is shared with"); anyone else
  gets **Sign in to comment**, which keeps the link in this tab's
  `sessionStorage` (never the address bar) so the page opens it again after
  the sign-in. A server `404` says only members can comment, a `403` that
  it isn't open for comment. Same two-column layout from 860 px, one
  column on a phone. `scenario-share.spec.ts` pins the flow (link, phone,
  sign in, comment, the assessor's view) with axe.
- **An evidence pack link** (WP-3.15, 128, `/share#t=…&k=pack`,
  `share/PackView.svelte`, words in `share/pack.ts`, the `share.pack`
  section): the same shell, states and comment flow as a scenario link,
  reading `POST /share/pack`. The pack's title, "Licensing evidence pack,
  version *n*, shared read-only", its standing ("Issued on *date*", or
  withdrawn or replaced, with the issue date), the caveat. A withdrawn or
  replaced pack then shows a card saying so and that its figures aren't
  shown, the reason given (withdrawn) or the replacing version's code with
  a link to its verify page (replaced), and no figure. While it stands, the
  left column has **The river's ecological reserve** per EWR site (the
  outlet unnamed; baseline beside the application, and the change in
  words), **The river in figures** (page 1's river rows, worded here by
  their id: Reserve months met per site, days below the EWR, no-flow days,
  and the two volume rows only at five or more units; baseline, with the
  application and the change, and the likely range from the model sets),
  and **Days below the EWR by month** (an application). Both states have
  **Check this pack** (the code, the verify page link, the hashes, the
  signers) and, on the right, **Public comments** (a signed-in member posts
  while it stands; closed once it doesn't, the comments kept) and **About
  this page**. `pack-share.spec.ts` pins it (link from the pack page, phone,
  sign in, comment, withdraw: the same link then shows the reason and no
  figure) with axe.

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

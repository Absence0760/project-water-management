// The glossary's articles: for each tip in tips.ts (same id, same order),
// the fuller explanation (`long`, paragraphs separated by a blank line), the
// other names people search for, related entry ids and the source of the
// idea. Only the glossary, help search and the other /help pages load this,
// through content.ts; a HelpTip never does (tips.ts says why). The "Input
// data" topic's articles are in articles-data.ts, a chunk of their own
// (issue #66), and so are "Scenarios and licensing" (articles-licensing.ts)
// and the EWR topic (articles-ewr.ts), "Run results" (articles-results.ts)
// and "Goodness of fit" (articles-fit.ts); content.ts joins them.

import type { HelpArticle } from './types';

export const ARTICLES: Record<string, HelpArticle> = {
	// ---- Basics -------------------------------------------------------------
	'water-balance': {
		long: 'The model tracks every cubic metre each day. Rain becomes natural flow, natural flow is shared out to the hydrological units, each hydrological unit fills its dam, irrigates, spills and passes water downstream, and the outlet gauge receives what is left.\n\nEach hydrological unit’s daily balance closes to the cubic metre: inflow (with rain on the dam and groundwater pumped) minus consumptive use, dam evaporation and seepage lost from the catchment, minus the change in storage, equals outflow. A catchment answers three questions: how much water is there, can each hydrological unit’s irrigation be met, and is enough left in the river for the environment?',
		related: ['natural-flow', 'network', 'ewr'],
		source: 'b023 Help (workbook purpose); docs/model.md §1'
	},
	'project': {
		long: 'A project holds everything for one river catchment. Copy a project to try a what-if without touching the original; runs inside a project record exactly which inputs they used.',
		aliases: ['catchment', 'workbook'],
		related: ['run', 'roles'],
		source: 'docs/model.md §1'
	},
	'run': {
		long: 'Pressing Run model computes every day of the simulation window and stores the daily series and the summary. Later edits to the model don’t change an existing run, so results can always be explained. Each run records the engine version it was computed with.',
		aliases: ['model run', 'engine version'],
		related: ['simulation-window', 'project', 'evidence-run'],
		source: 'docs/model.md §6'
	},
	'evidence-run': {
		long: 'On Runs & results, Notes & evidence, an editor can nominate the run shown with Nominate as evidence and a required reason. Nominating another run later replaces it; both stay in the nomination history, with who nominated each, when and why. In the runs list the current one carries an Evidence badge and a replaced one Former evidence, and comparing runs says when either side is or was the evidence.\n\nA run of the legacy runoff model (removed in engine 1.0.0) can’t be nominated: it is workbook comparison only. When the nominated run is such a legacy run and a later run uses GR4J, the results say so: the nomination still stands until another run is nominated, with a reason.',
		aliases: ['nominate', 'nominated run', 'nomination history', 'former evidence'],
		related: ['run', 'runoff-model', 'roles'],
		source: 'docs/ui.md § Evidence nomination; docs/data-model.md'
	},
	'roles': {
		long: 'Each person has a role on each project. A viewer sees every input and result, can fit the runoff model to explore and download results, but can’t save or run; the workspace says “View only”. An editor changes settings and model data, uploads series, runs the model, writes run notes and nominates the evidence run. An owner also adds and removes members, changes roles and deletes the project.\n\nA project can belong to a team. Team roles use the same names: a team’s owners own every team project, its editors edit them and its viewers view them, and a team owner also manages the team. Someone who is both a direct member and a team member gets the higher of the two roles.\n\nTwo roles see far less. A **farmer** reads only the farms linked to them. An **applicant** (a licence applicant or their consultant) reads what a farmer with the same links reads, plus their own licence applications on the published baseline; they never see the model.',
		aliases: ['permissions', 'members', 'team', 'view only', 'owner', 'editor', 'viewer', 'team admin', 'farmer', 'applicant'],
		related: ['project', 'evidence-run', 'application'],
		source: 'docs/data-model.md § Access control; docs/security.md'
	},
	'team': {
		long: 'A team holds catchments for a consultancy, a department or a WUA. Everyone in it gets every team project with the role they hold in the team: a viewer reads every team project and its runs, an editor edits them (model, data and runs), and an owner owns them (delete, share, move) and manages the team. Someone also shared a project directly gets the higher of the two roles.\n\nA project without a team is personal: only the people listed under Members on its Project page can open it. An owner moves a project into a team, or back to personal, from the Team panel on the Project page; an owner only through the team must first add themselves as a direct owner to make it personal. Only teams where you are an editor or owner are offered, for a new project, a move or a copy.\n\nThe team page lists its projects worst first by their EWR status and holds its members. Team settings hold the name, the EWR traffic-light thresholds, the privacy contact, and leaving or deleting the team; the only owner has to hand over before leaving.',
		aliases: ['teams', 'team admin', 'team member', 'personal project', 'move to team', 'portfolio'],
		related: ['roles', 'invitation', 'ewr-traffic-light', 'privacy-contact'],
		source: 'docs/ui.md § Teams; docs/data-model.md § Teams'
	},
	'invitation': {
		long: 'Adding a person by email, on a project’s Members or Farmers panel or a team’s page, always sends an invitation, whether or not the address has an account. Nobody is made a member unasked, and the person adding never learns whether the address is registered. Someone without an account signs up from the email; someone with one accepts or declines under Your invitations on their account page.\n\nUntil it is accepted, the invitation is listed as pending with who sent it and when it expires, with Resend (which renews it and makes you its sender) and Revoke. It works for 7 days. An invitation whose sender has since lost the right to add people (no longer an owner) can’t be accepted until someone resends it.\n\nA farmer’s invitation names the hydrological units they will be linked to and the language of the email; it is kept apart from the members’ list.',
		aliases: ['invite', 'pending invitation', 'resend', 'revoke invitation', 'add member'],
		related: ['roles', 'team', 'farmer-link'],
		source: 'docs/ui.md § Invitations, § Project; docs/security.md (pending invites retention)'
	},
	'farmer-link': {
		long: 'A farmer is a member with the farmer role, linked by an owner to one or more hydrological units. They read only those units’ figures, from the published run, on the farm view: their dam, their supply, the WUA’s notice and the notes shown to them. They never see another unit’s name or figures, the model, the runs or the members, and the workspace is closed to them.\n\nOwners invite farmers from the Farmers panel on the Project page, one by email or many from a CSV (email, unit, language), and change a farmer’s units or remove them there. A link goes with its unit: deleting the unit in the Network and saving removes the farmer’s access to it (the Network asks first, naming them), and restoring an earlier version doesn’t link them again.\n\nAn applicant can also hold unit links, for an irrigator applying to raise their own dam; they read what a farmer with the same links reads, plus their own applications.',
		aliases: ['farmer', 'farmers', 'linked farms', 'farm link', 'invite farmers', 'farmer view'],
		related: ['roles', 'invitation', 'published-baseline', 'notes'],
		source: 'docs/ui.md § Project (Farmers), § Farmer view; docs/data-model.md'
	},
	'applying-party': {
		long: 'An applicant (a licence applicant or their consultant) shares applications only with the members of their own applying party, so put an applicant and their consultant or client in the same one. An owner types the party in the applicant’s row under Members; blank is none.\n\nA member with a party can be ticked Specialist for this party: the registered professional the applicant appointed. They sign the evidence packs of the party’s applications; an editor still drafts and issues the pack. Nobody who edits the project may also be in an applying party, so the people who build the model and the people who apply against it stay apart.',
		aliases: ['party', 'specialist', 'consultant', 'applicant party', 'specialist signer'],
		related: ['roles', 'application', 'pack-signoff', 'registration-check'],
		source: 'docs/ui.md § Project (Members); docs/data-model.md § Applicants, 167_signers'
	},
	'registration-check': {
		long: 'A specialist who signs an evidence pack declares a professional registration (SACNASP or ECSA). The app can’t confirm it, so someone at your organisation looks it up on the public register and records the check on the Project page: the member, register, category and number, the name on the register, whether they were found, who checked, when, and a note. The register’s address is given beside the form.\n\nThe verify page then says “checked against the register” for that person’s sign-offs; anyone else’s registration reads “self-declared”. An owner, or an editor acting for the responsible authority, records checks. With the owner’s tick box on (the default), issuing an evidence pack waits until each specialist signer has a check from the last year.',
		aliases: ['SACNASP', 'ECSA', 'professional registration', 'register check', 'self-declared'],
		related: ['applying-party', 'pack-signoff', 'pack-issue-checks', 'responsible-authority'],
		source: 'docs/ui.md § Project (Registration checks); 167_signers'
	},
	'licence-record': {
		long: 'An issued evidence pack and a signed-off run keep the names of the people who made and signed them, also after their accounts are deleted, because a licence decision may have to be explained later. They are kept until three years after the licence expires, or three years after the application is refused or withdrawn.\n\nAn owner records the outcome on the Project page: granted (with the date the licence expires), refused or withdrawn, the date it was decided and why (for example the authority’s letter). Until an outcome is recorded, an owner confirms every five years that the record is still needed. Nothing is deleted automatically: once the record is past its closing date, the panel says to ask the operator.',
		aliases: ['retention', 'licence outcome', 'record retention', 'kept until'],
		related: ['evidence-pack', 'evidence-run', 'responsible-authority'],
		source: 'docs/ui.md § Project (Licence record); docs/evidence-pack.md § Retention'
	},
	'share-link': {
		long: 'A share link opens a read-only page without signing in, for someone outside the project such as a catchment forum or an NGO. An owner makes a link to the published baseline on the Project page: who it’s for, and how long it works (1 week, 30 days, 90 days or 1 year). It shows the catchment’s reserve status and the WUA’s notice, never a hydrological unit’s name or figures, or the modeller’s note, and it opens only once a run is published.\n\nThe new address is shown once: copy it then, since it isn’t kept and can’t be shown again. Anyone holding it can open the page until it ends or is withdrawn. Assessors and applicants make links to a submitted application, and editors to an issued evidence pack; while such a link is live, members can post comments for public participation.\n\nThe owner’s list on the Project page holds every public link in the project, with what it opens, when it was made, when it ends and when it was last opened. Withdrawing one stops it at once.',
		aliases: ['share', 'public link', 'read-only link', 'withdraw link', 'shared view'],
		related: ['published-baseline', 'application', 'pack-share-link'],
		source: 'docs/ui.md § Project (Share links), § Share page; docs/security.md'
	},
	'project-copy': {
		long: 'Copy… in a project’s ⋯ menu on the Projects page makes a new project from the model, settings, description, time zone and input series of another. The model gets fresh ids in the same order, so the copy runs exactly as the original. Runs, evidence nominations, notes, members, farmers and the change history are not copied: the copy’s history starts with “Copied from …”, and you are its owner. It stays in the original’s team when you are an editor or owner there, and is personal otherwise. Anyone who can open a project, viewers included, can copy it.\n\nA copy is for a lasting fork: a new baseline, or a project that has to start again without its evidence. To test a change against a run and compare the two, a scenario is lighter: it keeps the change as a list of edits on that run, inside the same project.',
		aliases: ['copy', 'duplicate', 'fork', 'clone project', 'what-if'],
		related: ['project', 'scenario', 'project-file'],
		source: 'docs/api.md § Projects (POST /projects/:id/copy); docs/ui.md § Project list'
	},
	'project-file': {
		long: 'Download → Download project (JSON) on the Project page saves the project as one file: the model, the settings and the input series, with the time zone. Runs, notes, members, farmers and the history stay behind. Every member can download it, viewers included.\n\nImport project file on the Projects page turns such a file (or the workbook importer’s project file, up to 5 MB) into a new project: a preview shows what is in it before anything is sent, and the model can run straight after the import. The import record then keeps what the importer noted.',
		aliases: ['export', 'JSON', 'project document', 'download project', 'import project'],
		related: ['project-copy', 'import-record', 'project-time-zone'],
		source: 'docs/ui.md § Project, § Import a project file; docs/api.md'
	},
	'project-time-zone': {
		long: 'An IANA time zone name, such as Africa/Johannesburg (the default). Every download of the project (CSV, JSON, the workbook, the report PDF) is dated by the calendar day there, so an export made just after local midnight carries today’s date. The same day dates what the server counts for a person: the ages on the project list, the data feeds’ health, the farm page’s freshness and forecast date, and the alerts, with their 06:00 daily summary.\n\nIt doesn’t shift the series: a day of rain or flow stays the day its source gave it. An editor changes it with Save changes; a copy keeps it.',
		aliases: ['time zone', 'timezone', 'IANA', 'local day'],
		related: ['project', 'project-file', 'alert-rules'],
		source: 'docs/ui.md § Project (Time zone); docs/api.md (058_project_time_zone)'
	},
	'import-record': {
		long: 'Only a project made by an import has one. It names the file, when it was imported, who imported it and the importer’s version, then the importer’s notes and, for a b023 workbook, the unmapped report: the sheets and cells it found no place for. It is kept as it was shown at the import, so a reviewer or an assessor can check long afterwards what the importer interpreted. Every member reads it, viewers included.',
		aliases: ['importer notes', 'unmapped report', 'imported from'],
		related: ['project-file', 'project'],
		source: 'docs/ui.md § Project (Import record); 017_project_import'
	},
	'change-history': {
		long: 'Each save of the model or the settings is kept as a version: who saved it, when, the reason they typed beside Save changes, and the lines that changed. Uploads, merges and deletions of series, runs, publications, members, farmer links, invitations, share links, API keys and alert rules are recorded too, with who did each (or which API key). The History tab lists them newest first, filtered by hydrological unit, kind of change or parameter; a field’s “Changed 3×” line links there.\n\nAn editor can restore any earlier version of the model and settings. Restoring saves it as a new change, so nothing is erased and the restore can itself be undone. It needs no unsaved edits, and a restored unit comes back without its farmer links. A run’s Restore these inputs does the same from a run.\n\nSeries values aren’t part of a version. A person’s replace, merge or delete keeps the values it replaced (the newest 5 versions, for up to 180 days), with Restore the earlier values; a data feed’s or an API key’s merge keeps none. Viewers read the history; farmers and applicants never see it.',
		aliases: ['history', 'audit log', 'audit trail', 'revision', 'restore', 'reason for this change', 'field history', 'version'],
		related: ['run', 'roles', 'notes'],
		source: 'docs/ui.md § History, § Field history; docs/data-model.md § Change history and audit log'
	},
	'notes': {
		long: 'Notes keep what lives in people’s heads (“dam raised in 2019 per owner”, “logger moved in March”) against what they are about: a hydrological unit in the Network, a run, a settings group, or the project itself. The count on each notes button opens them in a side sheet; the Project page lists the newest across the project.\n\nEvery member can add one. The author edits their own (marked edited); the author or an editor deletes it, which hides it from everyone but keeps it for the audit trail. Notes are plain text and read by the project team only, except a note on a unit ticked Also show to this unit’s farmers, which its linked farmers read on their farm page. On an application, comments carry their own audience (the assessors, the parties, the team or public participation).\n\nA note goes with its target: deleting a unit or a run deletes its notes. A copy of the project doesn’t take them. A run’s own notes, by contrast, are the modeller’s one written explanation of that run.',
		aliases: ['note', 'comments', 'recent notes', 'farm-visible note'],
		related: ['change-history', 'farmer-link', 'run'],
		source: 'docs/ui.md § Notes; docs/data-model.md § Notes (037_notes.sql)'
	},
	'api-key': {
		long: 'Owners make keys on Settings & calibration, under API keys: a name, how long it works (until revoked, 90 days, 1 or 2 years), and what it may write, any series of the project or only the ones ticked. The key (wm_…) is shown once, with a copyable example request; only a hash of it is kept, so a lost key can’t be shown again, only replaced. The list shows each key’s state, what it writes, who made it and when it was last used.\n\nThe gateway sends daily readings to the ingest endpoint with the key. Only the days sent are merged into the named series, converted to its units, and sending the same days again changes nothing. A key creates a series only when the project has none of that kind; otherwise a person adds the series first. A key can’t read the model, runs, members or anything else, and allows 60 requests a minute. Each merge shows in History as API key “name”, and keeps no copy of the values it replaced.\n\nWhen the project re-runs automatically, a merge that changed days queues a re-run as the key’s creator. A push that looks wrong (a negative value, one above the series’ outlier limit, or a series it created) is still merged, but holds automatic runs until a person runs the model. Revoking a key refuses it from its next request; the row stays. An alert can warn when a series a key sends falls behind.',
		aliases: ['ingest', 'logger', 'gateway', 'API', 'token', 'push data', 'revoke key', 'WM_INGEST_KEY'],
		related: ['change-history', 'alert-rules', 'series-source'],
		source: 'docs/ui.md § API keys; docs/api.md § Ingest; docs/security.md § API keys'
	},
	'alert-rules': {
		long: 'On the Summary, Active alerts lists what is firing now; an editor’s Set up alert emails opens the rules. Each kind has a level:\n\n• Dam low (per unit with a dam): the published figures put the dam below a % of its capacity (30 % unless changed).\n• EWR at risk in the forecast: the newest forecast run has this many days at risk at the outlet (3).\n• Restriction notice: the published restriction or notice changes.\n• Data feed behind and API data behind: a feed this many days past its usual delay, or a series an API key sends with no new reading for this many days (2).\n• Data feed failing (failures in a row), Background jobs failed (in 24 hours) and Hydrological units short (on an automatic publication’s last 7 days).\n\nNothing is sent until a kind is switched on. Each alert is sent once when its figure crosses the level, and again only after it has recovered. Farmers get their own units’ dam alerts and the restriction notices, and viewers may opt in to the model’s alerts; the operational ones go to editors and owners (failing feeds and failed jobs to owners, editors opting in). Each person chooses on their account page whether to get each alert right away, in a daily summary at 06:00 or not at all. What recipients answered to “Was this alert useful?” shows under the rules, without names.',
		aliases: ['alerts', 'alert emails', 'notifications', 'dam low', 'firing', 'digest'],
		related: ['api-key', 'project-time-zone', 'published-baseline'],
		source: 'docs/ui.md § Alerts; docs/api.md § Alerts'
	},
	'ewr-traffic-light': {
		long: 'A catchment’s EWR status is judged at the outlet over the 30 days up to the last day of its figures (the published run, or the latest run when none is published). It is green when the EWR was not met on fewer than 5 % of those days, amber fewer than 20 %, and red otherwise. Those are provisional defaults, still to be confirmed by the catchment’s hydrologist.\n\nA team’s owners can set the team’s own thresholds in Team settings, and every team project is then judged by them; a personal project uses the defaults. The status orders the project list, the team page and Needs attention. It summarises one outlet over one month: read the run’s River & reserve page for the sites and days behind it.',
		aliases: ['traffic lights', 'EWR status', 'red amber green', 'thresholds', 'status pill'],
		related: ['ewr-days-not-met', 'team', 'needs-attention'],
		source: 'docs/ui.md § Project list, § Teams (decision D11)'
	},
	'needs-attention': {
		long: 'At the top of the Projects page, up to four cards name the catchments to look at first and why, most urgent first: a red EWR, hydrological units short this week, alerts firing, an amber EWR, failing or late data feeds, rain recorded after the latest figures, or figures more than 7 days old. A catchment that hasn’t run is not flagged. Show all, most urgent first sorts the whole list the same way.',
		aliases: ['attention', 'urgent', 'stale figures'],
		related: ['ewr-traffic-light', 'alert-rules'],
		source: 'docs/ui.md § Project list (Needs attention)'
	},
	'privacy-contact': {
		long: 'The person or office people ask about the personal information kept in a team’s projects (a name or office, an email address and an optional postal address), as POPIA asks of a responsible party. Team owners set it in Team settings; members read it there, farmers see it from the farm menu, and invitations name it.',
		aliases: ['POPIA', 'information officer', 'data protection contact'],
		related: ['team', 'farmer-link'],
		source: 'docs/ui.md § Teams (Team settings); 168'
	},
	'water-year': {
		long: 'Monthly inputs (A-pan evaporation, crop factors, pragmatic EWR) are entered in water-year order, starting with October. Month pickers (transfer months, dry-season months) show one toggle per month in the same Oct … Sep order.',
		aliases: ['hydrological year'],
		source: 'docs/model.md §2.1'
	},
	'units': {
		long: 'Gauge and logger flow series are usually supplied in m³/s and converted to m³/day on the way in. Dam capacities and storage are in m³. Mean annual runoff is often quoted in M.m³ per year.\n\nA quick check: 1 l/s ≈ 86 m³/day, and 1 000 m³/day ≈ 11.6 l/s.',
		aliases: ['m3/day', 'm3/s', 'cumecs', 'l/s', 'million cubic metres', 'Mm3'],
		source: 'docs/model.md §2.1, §7'
	},
	'february-days': {
		long: 'Monthly crop requirements are divided by the days in the month to get a daily demand. Use 28.25 to average over leap years (the b023 default) or 28 for a strict 365-day year.',
		related: ['irrigation-demand'],
		source: 'b023 Help (AppSettings, month and day labels)'
	},
	'simulation-window': {
		long: 'Narrow the window to study a drought or to match a calibration period. Dams start from their initial storage on the first simulated day, so allow a warm-up period before the dates you care about.',
		aliases: ['start date', 'end date', 'period'],
		related: ['dam-initial', 'calibration'],
		source: 'b023 Help (Calc. Model date window)'
	},
	'report-window': {
		long: 'Pick a critical period — a dry season or a drought year — to see how much each hydrological unit would need to reduce for irrigation to balance and the EWR to be met in that period. A window partly outside the run is clipped to it.\n\nOn Hydrological units, the Reporting window picker above the curtailment table shows the same tables over another period (the last 7, 14 or 30 days, the whole record or a custom range) without changing this setting or re-running: anyone who can see the run can use it.',
		aliases: ['reporting period', 'shortfall period'],
		related: ['ewr'],
		source: 'b023 [Shortfalls] "Set reporting period"; docs/model.md §2.11'
	},

	// ---- Network ------------------------------------------------------------
	'network': {
		long: 'The network is a tree. A hydrological unit can receive water from several upstream hydrological units but sends all of its outflow to one downstream hydrological unit; a river that splits (bifurcation) is not modelled directly — use a transfer, or merge the hydrological units.\n\nThe model works out the calculation order itself, upstream first, so each hydrological unit sees its upstream neighbours’ outflow on the same day.',
		aliases: ['tree', 'topology', 'calculation order', 'bifurcation'],
		related: ['element-farm', 'element-gauge', 'outflow-gauge', 'transfer'],
		source: 'b023 Help (Network sheet)'
	},
	'element-farm': {
		long: 'A hydrological unit is any point of the network, of three kinds: a unit with land (usually a farm, but also a sub-catchment or a town with land of its own, with its runoff, an optional dam and demands), a gauge (a measuring point) and an other water user (a town or industry that only draws water from the river, with no land of its own). The workspace, the farmer view, the farmer emails and the shared view say hydrological unit, naming the kind where it matters; the exports (CSV and workbook) and the API call it a node, and a unit with land a farm. It is not a unit of measurement (m³, l/s).\n\nModel each unit with land as the land it occupies. The same kind covers three cases, set by its parameters:\n\n• Farm (or sub-catchment) — crops, a dam if it has one, return flow.\n• Stand-alone dam — no crop areas (so no irrigation or return flow), all of its runoff (and upstream inflow, if the dam sits on the main stem) captured by the dam, no diversion.\n• Natural (unused) area — no crops, no dam capture, no diversion: it simply passes its runoff downstream.',
		aliases: ['farm', 'farm element', 'unit with land', 'sub-catchment', 'node', 'stand-alone dam', 'natural area', 'element'],
		related: ['network', 'dam-capacity', 'flow-share'],
		source: 'b023 Models sheet'
	},
	'element-gauge': {
		long: 'Use gauges where you want to read the simulated flow, for example at a weir with a record. A gauge is also an EWR site unless you untick “EWR site” (engine 1.5.0): its flow is checked against the EWR of everything upstream of it, and a shortfall there is charged to the hydrological units above it. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches; untick one that only records flow (a weir that is no Reserve site), so it charges nobody and a Reserve rule table there is skipped. It still shows its flow and EWR shortfall. The last gauge in the network is the outflow gauge, always an EWR site.',
		aliases: ['gauge', 'weir', 'EWR site', 'measuring point only'],
		related: ['outflow-gauge'],
		source: 'b023 Network sheet'
	},
	'element-user': {
		long: 'Water taken by users that are not modelled hydrological units would otherwise be handed to the hydrological units and the EWR, over-stating both. An other user has a monthly demand (m³/day), a share of what it takes that comes back below it the same day (treated wastewater) and a priority.\n\nIt takes only from the river where it sits: what reaches it from upstream, after anything upstream has taken its share. It is charged for EWR shortfalls below it like a hydrological unit, by its net impact (what it takes less what it returns).\n\nOther users are outside the irrigation equitable-share benchmark. A senior user is not curtailed for the EWR; a junior one is (Curtailment tab, "Other water users").',
		aliases: ['town', 'municipal', 'industry', 'unlisted user', 'abstraction'],
		related: ['user-priority', 'user-return', 'user-pump', 'element-farm', 'ewr'],
		source: 'docs/model.md §2.7c; roadmap WP-1.33'
	},
	'user-priority': {
		long: 'A senior user’s demand is a requirement every hydrological unit upstream of it passes before it fills its dam or irrigates, shared between those hydrological units by flow share the way the EWR is (the hydrological unit diverts less, then lets inflow and its own runoff pass below the dam). A junior user upstream of a senior one leaves the senior demand in the river too.\n\nA junior user takes only what reaches it. Hydrological units have no protected claim, so a junior user upstream of a hydrological unit still takes first: position in the river decides.\n\nA municipal allocation is usually senior, which is the default. Senior users are not curtailed for the EWR; their charge is reported and left standing.',
		aliases: ['seniority', 'senior', 'junior', 'priority'],
		related: ['element-user'],
		source: 'docs/model.md §2.7c'
	},
	'user-return': {
		long: 'A town returns part of what it abstracts through its wastewater works. That share joins the river directly below the user on the same day; the rest is consumed. 0 % means nothing comes back.',
		aliases: ['wastewater', 'return flow', 'effluent'],
		related: ['element-user', 'return-flow'],
		source: 'docs/model.md §2.7c'
	},
	'user-pump': {
		long: 'The most an other water user can take from the river in a day, m³/day: pumps × m³/h per pump × 24. Each day it takes the least of its demand, what reaches it (for a junior user, what is left after the senior demand below it) and its pump capacity; the rest is a shortfall. Its boreholes are separate and still pump. Blank is no limit, the old behaviour; 0 means it has no river pump.\n\nA senior user’s claim on the hydrological units upstream is also capped: they pass no more than its pump can take, not its whole demand. The results show what it pumped from the river and, each day, the demand its pump left unmet although the river had it (its pump-limited part, within its shortfall). A drought restriction does not cut other water users.\n\nAn evidence pack can’t be issued on a run with an other water user that has demand and no pump capacity. An other water user can’t keep a hands-off flow, so a new one in an application also stops its pack: model a new take as a hydrological unit that pumps from the river instead.',
		aliases: ['pump capacity', 'abstraction capacity', 'town pump', 'pump limited'],
		related: ['element-user', 'user-priority', 'supply-rule'],
		source: 'docs/model.md §2.7c; roadmap WP-3.8; issue #54 item 2b'
	},
	'borehole': {
		long: 'Groundwater is a separate resource with its own licences, so it counts as supply without coming out of the dam or river. A hydrological unit or user can have a combined borehole capacity and any number of individual boreholes, each with its own capacity, annual cap, mode, target and depletion share.\n\n• Supplemental — only for the demand the dam and river leave unmet.\n• Primary — pumped first; the dam and river cover the rest.\n• Emergency (drought) — supplemental, but only while the dam holds less than its trigger level at the start of the day (a hydrological unit with a dam only).\n• None — kept on record, never pumps.\n\nA borehole can pump straight to the crop or into the hydrological unit’s dam (primary keeps the dam topped up, supplemental adds what the dam lacks for the day, emergency refills it while it is low; primary and emergency pump only on a day there is demand to irrigate from the dam); water pumped into the dam never makes it spill. An annual cap stops a borehole once it has pumped that much in a water year (October to September); it starts again on 1 October.\n\nThe results show each hydrological unit’s use per water year against its caps and, for context, the GN 538 general authorisation’s volume for the property: its area × the Table 2 rate, at most 40 000 m³/a (see GN 538 general authorisation). The app never decides whether a use is lawful.\n\nPart of the pumped water that is lost in irrigation returns to the river like any other return flow.',
		aliases: ['groundwater', 'borehole', 'well', 'aquifer', 'pumping', 'annual cap', 'GN 538', 'general authorisation', 'sustainable yield'],
		related: ['stream-depletion', 'ga538', 'element-farm', 'element-user'],
		source: 'docs/model.md §2.7d; roadmap WP-1.34, WP-3.9; GN 538 (2016)'
	},
	'ga538': {
		long: 'GN 538 of 2 September 2016 (Government Gazette 40243) lets a person with lawful access to a property take groundwater without a licence, up to a volume set by the property’s size: its area in hectares × the rate Table 2 (Appendix B) lists for its quaternary catchment, one of 0, 45, 75, 150, 275 or 400 m³/ha a year, and never more than 40 000 m³ a year on a property. A property is land registered separately in a Deeds Office. In a zero-rate quaternary no groundwater may be taken under the GA at all.\n\nEnter the property area and the rate on the hydrological unit or user with boreholes. The app doesn’t carry the gazette’s table: look the rate up in Appendix B for the quaternary. Without both, the results show the 40 000 m³/a ceiling only, and the run warns.\n\nThe gazette’s year is any 12 consecutive months, so the results show the most pumped in any 12 months beside each water year: a use split across 1 October can pass both water years and still exceed the volume.\n\nThe GA doesn’t cover an alluvial aquifer directly connected to a stream (the gazette counts that as surface water; the run warns on a borehole with a stream depletion share of 80 % or more), or groundwater taken within 100 m of a watercourse’s riparian edge, 500 m of a wetland or estuary, or near a state dam. The app has no borehole locations, so it can’t check the distances. It shows the volume for context and never decides whether a use is lawful.',
		aliases: ['GN 538', 'general authorisation', 'GA', 'Table 2', 'schedule 1', 'groundwater licence', 'property area', 'quaternary rate'],
		related: ['borehole', 'stream-depletion'],
		source: 'docs/model.md §2.7d; GN 538 (2016), Government Gazette 40243, §1, §2.2, §4 and Appendix B',
		countries: ['ZA']
	},
	'demand-object': {
		long: 'A hydrological unit can carry demand objects beside its crops: a town, households, livestock, industry or a bulk supply piped out of the catchment. Each gives its demand either as m³/day for each month (a meter record, a reconciliation strategy’s average daily demand, or a workbook’s typed-over figure) or as a count × litres per unit a day (people or head of stock), grossed up for distribution losses and shaped by a monthly profile. The Red Book’s 230 l per person a day for a house connection and about 45 l per head of cattle are starting points, not defaults the model applies for you.\n\nIts demand adds to the hydrological unit’s, and the hydrological unit’s dam, river pump and boreholes supply the total. On a short day the priority decides who gets water first: first (before the crops, as basic needs are), shared (pro rata with the crops) or last. With two or more objects on a hydrological unit, the form shows its supply order as numbers instead, the crops among them: 1 is supplied first, then 2, and equal numbers share pro rata, so two municipalities whose licences differ in seniority can be supplied one after the other before the crops. The order holds among the demands on one water source: a demand whose source is the river (a river abstraction with its own pump) takes from what passes the dam after the dam side has supplied its own, so a 1 on the river can be short on a day a 3 on a full dam is met. What an object gets, times its return share, flows back to the river below the hydrological unit the same day, like treated wastewater; water piped out of the catchment returns nothing.\n\nThe results show each object’s demand, supply, shortfall and return. A demand that takes from the river by itself, at its own place in the network, is an other water user instead.',
		aliases: ['demand object', 'municipal demand', 'town', 'domestic demand', 'livestock', 'potable', 'non-crop demand', 'unit'],
		related: ['element-farm', 'element-user', 'supply-rule'],
		source: 'docs/model.md §2.7f; issue #54 item 2b; CSIR Red Book §J (2005); KZN DARD livestock water requirements'
	},
	'demand-schedule': {
		long: 'A demand object’s schedule is a list of windows, each a set of days and a factor on the object’s demand on those days. A window covers every day, a span of dates each year (1 December to 15 January wraps the year end), a one-off date range, or days around Easter (−2 is Good Friday, +1 Family Day), and can be narrowed to some weekdays: every day on Saturday and Sunday is a weekend pattern. A factor of 0 switches the object off, 0.5 halves it, 1.8 is a peak.\n\nWhere two windows cover a day, the later one in the list sets it, so the list reads “then, on these days, instead”; a day no window covers runs at the month’s demand. A day switched off has no demand, so no supply and nothing returned, and the results count it apart from days short. The switch is set by date only, not by the river’s flow.',
		aliases: ['on/off pattern', 'weekends off', 'holiday', 'shutdown', 'Easter', 'daily pattern', 'schedule'],
		related: ['demand-object'],
		source: 'docs/model.md §2.7f; issue #90 Q4 and Q12'
	},
	'basic-needs-floor': {
		long: 'A domestic or municipal demand object with people has a basic-needs floor: the people it serves × 25 litres a day, the Free Basic Water level, grossed up for distribution losses when it is sized per person. It is the number of people for a per-person object, or the people you enter for one given as m³/day by month (without them, it has no floor). On a day its demand is less than that, the floor is the day’s demand; a day its schedule switches it off has none.\n\nA restriction (a scenario’s cut in demand, as the same % for every category) never cuts the object below its floor, and the curtailment table and share-the-pain board never leave its hydrological unit less than its floor once the EWR is met: what the floor keeps is shown beside the cut. The results count the days and the volume it was supplied below its floor apart from its ordinary shortfall, and show what it got in litres a person a day, the level a municipality’s own restriction stages are set in.',
		aliases: ['basic human needs', 'free basic water', '25 litres', 'l/p/d', 'restriction floor', 'population'],
		related: ['demand-object', 'equitable-share'],
		source: 'docs/model.md §2.7f and §2.11; issue #123; issue #90 Q13; Water Services Act regulations (free basic water, 25 l per person per day)'
	},
	'demand-source': {
		long: 'How solid a demand object’s number is depends on where it comes from, and the rule agreed with the client is: meter records where they exist, else the reconciliation strategy’s AADD (annual average daily demand), else the people or head of stock × litres a day by a norm (the Red Book’s 230 l a person for a house connection). Other covers anything else: a licence volume, an estimate, or a workbook’s typed-over figure (what the workbook import records). Not recorded is every object saved before the field existed.\n\nThe source sets how the demand is given: meter records and an AADD are volumes, so m³/day for each month; a norm is a count × litres a day; other can be either. Source details holds which meter and years, which strategy and year, or which norm. The source changes no number in the run: the results list each object’s source and how much of the objects’ demand comes from each, so a report can say how much of it is measured.',
		aliases: ['demand source', 'meter records', 'AADD', 'annual average daily demand', 'reconciliation strategy', 'per-capita norm', 'litres per person per day'],
		related: ['demand-object', 'basic-needs-floor'],
		source: 'docs/model.md §2.7f; issue #54 Q11; issue #90'
	},
	'water-source': {
		long: 'Each demand of a hydrological unit, its crops and each demand object, takes its water from the unit’s own supply, the dam side (the default, what the model always did), or from a river abstraction of its own beside the dam. The dam side runs as before for the demands on it: the supply rule, the river pump of a river-first or trigger rule, off-take water and boreholes serve only them. A river abstraction has its own pump capacity (blank is no limit, and the run warns) and can have a pool at the pump: give its capacity only; it starts full and its surface is estimated from the capacity, for its evaporation.\n\nEach day, after the dam has supplied its demands and spilled, the river abstractions take from the river passing the dam, its spill included, above what the unit must leave (the senior users’ demand below, a pass-inflow release’s target and the unit’s hands-off flow). They take in the unit’s supply order: first (by rank), then the crops with shared, then last (by rank), pro rata within one; a pump takes no more than its capacity, and once the river’s share is used an abstraction draws its own pool. Each pool then refills from what is left. A drought restriction cuts a river demand as it cuts the same demand on the dam.',
		aliases: ['river abstraction', 'water source', 'run-of-river pump', 'pool', 'weir pool', 'abstraction point'],
		related: ['supply-rule', 'demand-object', 'hands-off-flow'],
		source: 'docs/model.md §2.7j; issue #344; issue #342 items 4 and 5'
	},
	'crop-supply-table': {
		long: 'The crop demand is worked out for the hydrological unit from its crops, and the table says how it is supplied: a share from the unit’s own dam (under its supply rule), a share from the river at the unit (the crops’ own pump on the flow past the dam, with its capacity and an optional pool) and a share from the dam of another unit (through a pipe or canal, with its capacity). The shares add up to 100 %. Each source is asked for its share only: a source that can’t give its share leaves a deficit, and the other sources don’t make it up.\n\nThe other unit’s dam gives the same day, from what it holds above its minimum operating level after its own unit has been supplied, before it spills: water it gives would otherwise have spilled first. That unit must be upstream or on another branch; one this unit drains into would need tomorrow’s water today, so the save refuses it. Without a table the crops take one water source, as before, and a table all on the dam or all on the river runs exactly as that source. The run shows what came in from the other dam on this unit (remote_dam_in, part of supplied) and what each dam gave other units (remote_dam_out). Pending the hydrologist: pipe losses, and a dam downstream pumping up.',
		aliases: ['water supply table', 'sources of supply', 'supply shares', 'remote dam', 'dam in another unit', 'split supply'],
		related: ['water-source', 'supply-rule', 'transfer'],
		source: 'docs/model.md §2.7k; issue #408'
	},
	'supply-rule': {
		long: 'Dam only (the default) is what the model always did: irrigation draws on the hydrological unit’s dam alone. River first pumps from the river below the dam, up to the pump’s capacity, and the dam covers the rest. Trigger uses the dam until it holds less than the trigger level at the start of a day, then pumps from the river first until the dam is back at the stop level. Run of river has no dam: the pump takes what the river gives, up to its capacity, and the rest is a deficit.\n\nThe pump only takes the flow below the dam that the hydrological unit need not pass: the senior water users’ demand below it, and a pass-inflow release’s target, stay in the river. The capacity is m³/day: pumps × m³/h per pump × 24. With no capacity set, only the river’s flow limits the pumping, and the run says so. Only run of river sends everything through the pump: on a hydrological unit with no dam, the other rules still irrigate what the dam split and River to dam route to the absent dam straight from the river, past the pump, and the run says so. Exploring is fine without a capacity, but an evidence pack can’t be issued on a run with a river pump that has none, or with such a route past the pump.',
		aliases: ['pump capacity', 'river abstraction', 'pump scenario', 'river first', 'run of river', 'dam first'],
		related: ['element-farm', 'borehole'],
		source: 'docs/model.md §2.7e; roadmap WP-3.8; issue #54 item 2c'
	},
	'drought-restriction': {
		long: 'A model rule for the WUA’s drought restrictions: cut demand by a share when the dams fall low. On each review date the model reads the storage at the start of the day as a share of capacity: by default the total of the farm dams (the review triggers’ basis), or some dams, or each unit’s own dam; and applies the deepest level that storage is below. An optional EWR trigger raises the level on a review date when the EWR wasn’t met the day before; the level holds until the next review date, and a lift date ends any restriction. A dam that comes into service during the run starts empty, so until it first holds the mildest level’s share of its capacity each review reads the dams with it and without it and applies the milder level (engine 1.70.0): a new dam filling up never makes a restriction deeper, and the water it already holds still counts. Each level cuts each part of every hydrological unit’s demand (or of the units the rule names) by its own share: its crops, and its demand objects by category (domestic, municipal, livestock and the rest), as DWS restrictions do. A domestic or municipal demand object is never cut below its basic-needs floor.\n\nThe hydrological unit’s demand stays what it wants; the cut is what its dam, river pump and boreholes are no longer asked for, so it shows as a shortfall, and the river keeps the water. The run records the level each day, each part’s cut and each unit’s demand after it, and counts the days at each level per water year. The seasonal outlook’s review triggers can be saved as the rule, Settings can start one from the WUA’s published restriction notice, and a scenario can set another rule to compare policies. The outlook itself runs without the rule. Off by default; the rule is a model input, not the restriction notice farmers see. Pending the hydrologist.',
		aliases: ['restriction level', 'curtailment rule', 'water restrictions', 'restricted demand', 'drought rule', 'storage trigger'],
		related: ['basic-needs-floor', 'supply-rule'],
		source: 'docs/model.md §2.7i and §2.15a; roadmap WP-3.8; design/planning-outputs.md R6'
	},
	'hands-off-flow': {
		long: 'A licence condition that stops abstraction when the river runs low. The hydrological unit keeps the larger of the month’s hands-off amount and, when asked, the EWR required at it (its own and upstream shares) flowing in the river: River to dam diverts only what is above it, and the river pump pumps only what is above it (and above the senior users’ demand). When less than that flows, neither takes anything. It doesn’t change what the dam’s own split sends into an on-channel dam. Off by default: a provisional default (2026-10-01), not yet confirmed by the catchment’s hydrologist, that applies to exploring and to existing users only.\n\nAn application’s evidence pack can’t be issued while the river pump, River to dam or off-take it adds or changes on the applicant’s units leaves neither the EWR nor a hands-off flow in the river in every month it takes. The baseline’s existing users aren’t held to it: the baseline is the river as it is used today.',
		aliases: ['hands off flow', 'bypass flow', 'abstraction threshold', 'minimum flow condition'],
		related: ['supply-rule', 'diversion', 'ewr'],
		source: 'docs/model.md §2.7h; roadmap WP-3.8; issue #204'
	},
	'stream-depletion': {
		long: 'Pumping near a river lowers the dry-season base flow the EWR depends on. The model takes a share d of each day’s pumping from the flow leaving the hydrological unit, delayed through a single linear store with time constant k days, so the river keeps losing water for a while after the pumps stop and, over a long run, loses d × the pumped volume in all.\n\nThe river never goes below 0: depletion due on a day with nothing left to take is owed (the depletion deficit) and comes off the first flow that returns, and the run warns about any still owed at its end. Runs before engine 1.10.0 dropped it instead (reported as unmet). A first estimate of k is the stream depletion factor, distance² × storativity ÷ transmissivity (Jenkins 1968).\n\nA gauge or logger record measured while the boreholes pumped already carries their depletion: keep them in the model when calibrating, so the fitted natural flow isn’t reduced twice.',
		aliases: ['base flow reduction', 'baseflow depletion', 'Glover', 'Jenkins', 'SDF'],
		related: ['borehole', 'ewr'],
		source: 'docs/model.md §2.7d; Jenkins (1968); Glover & Balmer (1954)'
	},
	'land-cover': {
		long: 'Each patch has a cover class, an area and a condensed (canopy) cover: its share of the hydrological unit is area × cover ÷ the hydrological unit’s area. Each class removes a share of the runoff at full cover: one share of the low flows (the part of each day’s flow up to the flow exceeded 75 % of the days) and another of the rest, because trees take proportionally more of the dry-season flow.\n\nThe class values are indicative (after the South African afforestation reduction curves of Scott & Smith 1997, and Le Maitre et al. 2016 for invasive plants, who put the national loss to invasives at about 2.9 % of the mean annual runoff); confirm them for the catchment or enter a patch’s own.\n\nThe reduction is its own run series, never hidden in the calibration. To see what clearing a class gives back, copy the project, remove the patches and compare the two runs.',
		aliases: ['invasive alien plants', 'IAP', 'forestry', 'afforestation', 'plantation', 'streamflow reduction activity', 'wattle', 'eucalyptus', 'pine'],
		related: ['element-farm', 'natural-flow'],
		source: 'docs/model.md §2.5a; Scott & Smith (1997); Le Maitre et al. (2016); roadmap WP-1.35'
	},
	'bed-losses': {
		long: 'On a losing river part of the flow soaks into the bed and banks between two points and never reaches the next one. Each hydrological unit, gauge or other water user can lose a share of the flow it passes downstream in the reach to the next one: loss = MIN(most lost in a day, share × outflow). The next unit receives the outflow less the loss, and the loss leaves the catchment: it doesn’t become groundwater that comes back as baseflow (as WRSM2000’s bed loss in the Pitman model). A share of 100 % with a daily maximum is WRSM’s fixed monthly bed loss (the maximum = the month’s bed loss ÷ its days): the whole flow is lost on days below it. More than half the flow without a maximum runs with a warning. The outlet has no reach below it.\n\nSenior water users downstream are still passed their demand in full: the units above them pass enough that it arrives after the losses on the way (except below a reach that loses the whole flow with no maximum, where nothing can arrive). The pragmatic EWR is not grossed up: it is a fixed flow at the outlet, so set it knowing the losses above it; a loss that leaves a site short shows as a shortfall there, charged to no unit, and the run warns when bed losses are on. A Reserve rule table reads its site’s natural flow net of the losses, as the river would lose them with nothing built, so a site below a losing reach doesn’t fall short with no development; the WR2012 check and its calibration penalty compare WR2012 (already net of WRSM’s bed loss) with the natural flow at the outlet net of them too.\n\nLeave it at 0 % for a perennial reach. Turn it on only where a gauge shows low flows the model keeps over-simulating that abstractions, dams and transfers don’t explain, and set it from that evidence; above 30 % needs a source. Calibration then fits the runoff with the losses in place: they trade off against the GR4J exchange, so fix them first and fit after.',
		aliases: ['transmission losses', 'channel losses', 'river losses', 'losing river', 'bedloss', 'reach loss'],
		related: ['outflow-gauge', 'ewr', 'stream-depletion'],
		source: 'docs/model.md §2.6b; WR2012 User Manual (WRC TT 689/16) §6.2.3.1; eWater Source practice note on losses; Mvandaba et al. (2018)'
	},
	'outflow-gauge': {
		long: 'Exactly one element has nothing downstream of it. Its flow is the catchment’s simulated outflow: the series checked against the pragmatic EWR and, when an observed record exists, used for the calibration statistics.',
		aliases: ['outlet', 'catchment outlet'],
		related: ['ewr', 'nse'],
		source: 'b023 Network sheet (Network Outflow Gauge)'
	},

	// ---- Units and dams -----------------------------------------------------
	'farm-area': {
		long: 'The total area is used by the Area flow-share method and, summed over all hydrological units, as the default catchment area that rain falls on. Hi/Lo areas split the same land by rainfall zone.',
		aliases: ['total area', 'catchment area of hydrological unit', 'catchment area of farm'],
		related: ['flow-share', 'catchment-area'],
		source: 'b023 Farm spec'
	},
	'hi-lo-map-area': {
		long: 'Used by the Hi/Lo flow-share method: wetter land produces more runoff per km², so the hydrological unit’s share is weighted by where its land lies rather than by area alone.',
		aliases: ['area hi', 'area lo', 'high MAP', 'low MAP'],
		related: ['flow-share', 'hi-lo-split', 'map'],
		source: 'b023 Farm spec'
	},
	'unit-map': {
		long: 'Used when each hydrological unit runs on its own rain (Settings, Rain for each unit). Rain varies a lot over short distances in the mountains, so a unit’s MAP sets the level of its rain:\n\n• With the rain gauge’s MAP: the unit runs on the gauge’s rain × unit MAP ÷ gauge MAP, and the unit’s own CHIRPS, scaled to its MAP, fills the days the gauge has none.\n• Without it: the unit runs on its own CHIRPS, scaled by MAP ÷ the CHIRPS mean annual rain over the same years (1991–2020 by default).\n\nEach factor is flat and held between 0.25 and 4. Take the MAP from a fine rainfall grid or a study of the catchment, and say which in the source: Settings → Rain for each unit → MAP from the grid fills every unit’s MAP and source from one loaded MAP grid, area-weighted over each unit’s parcel, never mixing two grids. A unit without a MAP runs on its CHIRPS with the catchment’s CHIRPS correction, or on the catchment’s rain if it has no CHIRPS. The MAP is a fixed input, never calibrated.',
		aliases: ['unit MAP', 'MAP of hydrological unit'],
		related: ['map', 'hi-lo-map-area', 'flow-share'],
		source: 'docs/model.md §2.4h; issue #482'
	},
	'flow-share': {
		long: 'Catchment natural flow is split into the runoff of each hydrological unit by a fixed share per hydrological unit. Three methods:\n\n• Area — the hydrological unit’s area over the total area.\n• Hi/Lo — area-weighted separately in the high- and low-rainfall zones, then combined with the Hi/Lo split.\n• Manual — a share you enter per hydrological unit, typically computed in a separate study.\n\nThe same shares divide the pragmatic EWR into per-unit EWR shares. A warning appears when the shares don’t sum to 1 (tolerance 0.0002).\n\nChoose the method in Settings & calibration, under Flow share between hydrological units. The hydrological unit table’s In use column and each hydrological unit’s form (Share in use) show the share it gets with the saved method, and the table’s total row their sum.',
		aliases: ['fragmentation', 'fragmented flow', 'share', 'share in use', 'in use'],
		related: ['hi-lo-split', 'farm-area', 'natural-flow'],
		source: 'b023 Farm spec; docs/model.md §2.5'
	},
	'hi-lo-split': {
		long: 'Typically taken from a Pitman study of the catchment. The two numbers should add up to 1.',
		aliases: ['Pitman split', 'hi MAP flow %', 'lo MAP flow %'],
		related: ['flow-share'],
		source: 'b023 Farm spec'
	},
	'upstream-to-dam': {
		long: 'The b023 column is labelled “upstream inflow above dam”: the share of the upstream inflow that enters the dam, above the dam wall. The rest passes below the dam.\n\n100 % is a dam on the river: it catches everything coming down, and River to dam isn’t available to it. 0 % is an off-channel dam beside the river: the river passes it by, and it fills from its share of the farm’s runoff and from River to dam. A value between is a dam that catches part of the river.\n\nThe workbook’s formula applied the fraction the other way round (to the water passing below), against its own label and its [Models] sheet. The client confirmed the label’s meaning, and the app follows it from engine 0.9.0. A workbook’s values were entered against its formula, so importing one stores 100 % − each value, which keeps what the workbook ran: a b023 100 % imports as an off-channel dam (0 %). This is also the South African convention: the Pitman/WRSM model describes farm dams by the share of the catchment that drains into them.',
		aliases: ['upstream inflow above dam', 'upstream to dam'],
		related: ['runoff-to-dam', 'diversion'],
		source: 'b023 Farm spec; docs/model.md §3 Q1 (resolved)'
	},
	'runoff-to-dam': {
		long: 'Set 100 % for a dam that captures the hydrological unit’s whole area, 0 % for a natural area or a hydrological unit whose dam doesn’t intercept its land.',
		aliases: ['farm runoff above dam', 'runoff to dam', 'own runoff into dam', 'incremental catchment runoff'],
		related: ['upstream-to-dam', 'dam-capacity'],
		source: 'b023 Farm spec'
	},
	'dam-capacity': {
		long: 'b023 treats a hydrological unit’s dams as one composite dam. Water above capacity spills downstream the same day. The dam also loses open-water evaporation and any seepage, and catches the rain on its surface (see dam evaporation).',
		aliases: ['composite dam', 'storage capacity', 'full supply'],
		related: ['dam-initial', 'dam-min', 'spill', 'dam-storage', 'dam-evaporation', 'dam-seepage'],
		source: 'b023 Farm spec'
	},
	'dam-initial': {
		long: 'The first weeks of a run depend on this guess. New hydrological units start at 0 % (empty); an imported workbook keeps its own values. Whatever you choose, begin the simulation before the period you study so the dams settle.',
		related: ['dam-capacity', 'simulation-window'],
		source: 'b023 Farm spec'
	},
	'dam-min': {
		long: 'The level below which a farmer stops irrigating from the dam (a pump intake, a reserve for stock water or the dam wall). Each day irrigation can take only yesterday’s storage plus today’s inflows above capacity × this level. A transfer out of the dam keeps the higher of its own minimum storage and this level.\n\n0 % means irrigation may empty the dam, which is how the b023 workbook works; the network editor flags such dams as a hint. The workbook’s “min %” column was the minimum for transfers, which each transfer rule carries, so imported dams start at 0 %.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['min dam volume', 'dead storage', 'minimum storage'],
		related: ['transfer', 'transfer-min-storage', 'irrigation-supplied'],
		source: 'docs/engine-audit.md Q5; docs/model.md §2.7'
	},
	'dam-evaporation': {
		long: 'The surface shrinks as the dam empties: area = area when full × (yesterday’s storage ÷ capacity)^exponent, with exponent 0.7 for small reservoirs (Liebe et al. 2005), or, when the dam has a survey curve, the area read off the curve (engine 0.35.0). Evaporation = dam evaporation factor × the month’s A-pan ÷ days in the month × area; the factor (Settings, default 0.75) is an A-pan factor: the WR90 / WR2012 lake factors are ratios to S-pan evaporation and must not be entered unchanged. Rain on the dam = the day’s rain (before the rain threshold) × area. Evaporation never takes more than the dam holds. The runoff model’s area still includes the dam surfaces, so rain on a dam is partly counted twice (small for farm dams; engine-audit N2, pending the hydrologist).\n\nOpen water lags the pan through the seasons, so Settings can take a factor per month instead of one (engine 0.35.0); left off, the one factor applies every month. **Dam evaporation preset** fills the 12 factors and a source note (both stay editable): flat 0.75, or the WR90 monthly lake factors (Midgley et al. 1994, 0.81–0.88 × S-pan) converted to A-pan at the project’s own monthly A-pan with a published S-pan ← A-pan equation (WR90’s, or Taljaard 2023’s), which gives about 0.5–0.6 × A-pan in winter and about 0.7 in summer (Western Cape-like A-pan). Enter the A-pan first (each month at least 55.4 mm for WR90’s equation, 38.5 mm for Taljaard’s, below which the conversion no longer holds) and fill again after changing it. Which preset fits the client’s catchment is pending the hydrologist.\n\nWhen a dam’s area isn’t known the run estimates it as 7.2 × capacity^0.77 m², the generalised relation for South African farm dams of Maaren & Moolman (1985), quoted by Sawunyama (2013): a small dam is shallower than a large one (mean depth about 1.2 m at 10 000 m³, 2 m at 100 000 m³). Its warnings say how many dams used the estimate, which can be far out for any one dam; runs before engine 1.63.0 used capacity ÷ 3 m. Provisional decision 2026-10-01, to be confirmed by the catchment’s hydrologist. A 100 000 m³ dam of 3 ha loses about 180 m³/day at 6 mm/day of evaporation.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['evaporation', 'lake evaporation', 'open-water evaporation', 'surface area', 'area–volume', 'lake factor'],
		related: ['dam-capacity', 'dam-seepage', 'dam-storage', 'dam-survey-curve'],
		source: 'docs/engine-audit.md N2; Linsley et al. 1982; Liebe et al. 2005; Maaren & Moolman 1985; Sawunyama 2013'
	},
	'dam-seepage': {
		long: 'Seepage = seepage per day × yesterday’s storage, taken after evaporation and never more than is left. 0 % (the default) for a sealed dam.\n\nWhere it goes (engine 0.35.0): the share set as “seepage returning” joins the hydrological unit’s outflow the same day and stays in the catchment; the rest is lost from it (to deep groundwater) and shows as its own column and water-balance line. 100 % returning, the default, is how every earlier engine ran.',
		aliases: ['leakage', 'leak'],
		related: ['dam-evaporation', 'dam-storage'],
		source: 'docs/engine-audit.md N2'
	},
	'dam-survey-curve': {
		long: 'The rows a dam survey gives, as on the DWS dam technical data form (DW789): the water level, the surface area and the volume stored at that level. With two or more rows the run interpolates the area linearly in volume from yesterday’s storage (from 0 m³ and 0 m² below the lowest row, holding the top row’s area above it), and uses it for evaporation and rain on the dam. Without a curve the power law (area when full × (storage ÷ capacity)^exponent) is used.\n\nVolumes must rise from row to row, and neither level nor area may fall as the volume rises; a save refuses a curve that breaks this. When the top row’s volume sits more than 1 % from the dam’s capacity the run warns: check one against the other. Paste the rows in the hydrological unit’s form on the Network, or, for a what-if, as a change on a scenario (Dam survey curve; add it after a capacity change so a raised dam uses its own survey).',
		aliases: ['area–volume curve', 'area-capacity curve', 'stage–storage', 'DW789', 'basin survey', 'elevation–area–volume'],
		related: ['dam-evaporation', 'dam-capacity'],
		source: 'docs/model.md §2.7a; roadmap WP-3.5'
	},
	'dam-release': {
		long: 'A low-flow or compensation release is a common licence condition. Each day, before irrigation takes its share.\n\n**Pass inflow**: the dam passes today’s inflow to it (upstream inflow and own runoff entering it, plus any diversion), up to the flow the river below the wall still needs after what bypasses the dam: either the monthly amounts entered, or, when none are, the EWR required at this hydrological unit (its own share and the shares upstream). Inflow is passed whatever the dam’s level.\n\n**Fixed**: the dam releases the month’s amount from the water above its minimum operating level.\n\nEither is capped by the outlet capacity (empty = no limit). The release joins the hydrological unit’s outflow and shows as the dam_release column. Pending the hydrologist.',
		aliases: ['compensation flow', 'low-flow release', 'EWR release', 'outlet', 'release rule', 'pass inflow'],
		related: ['dam-min', 'dam-storage'],
		source: 'docs/model.md §2.7a; roadmap WP-3.5'
	},
	'dam-survey-date': {
		long: 'The day the dam’s capacity (and its survey curve, if it has one) was measured, from a basin survey or the DWS dam technical data form. On its own it changes nothing. With a sediment rate it is the day the dam holds exactly the capacity entered: before it the dam held more, after it less.\n\nEmpty = not recorded; a sediment rate needs it, and a save refuses a rate without one.',
		aliases: ['survey date', 'basin survey date', 'capacity date'],
		related: ['dam-sediment', 'dam-survey-curve', 'dam-capacity'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'dam-sediment': {
		long: 'Dams fill with silt, so the water they can store falls over the years. The run takes the loss as steady: the capacity on a day is the capacity entered × (1 − rate × years since the survey date), more before the survey and less after it, never below empty. Dead storage, the survey curve’s volumes and the dam-level triggers (the supply rule’s, a drought borehole’s, a transfer’s reserve) are shares of the capacity and shrink with it; the area when full doesn’t.\n\nEnter the rate as a share of the surveyed capacity lost a year, 0 to 20 %; a re-survey of the same dam gives it (the capacity lost ÷ the surveyed capacity ÷ the years between). Empty or 0 = no loss. The run carries the day’s capacity as the dam_capacity column when it changes.',
		aliases: ['siltation', 'sedimentation', 'capacity loss', 'silting'],
		related: ['dam-survey-date', 'dam-capacity', 'dam-in-service'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'dam-in-service': {
		long: 'For a dam built during the record: before this day the hydrological unit has no dam, so what is routed to it passes below as on a unit without one, and irrigation draws on the river alone. From this day the dam starts empty, fills from what reaches it and works as entered.\n\nEmpty = the dam is there for the whole run.',
		aliases: ['dam built', 'commissioned', 'dam completion date'],
		related: ['dam-capacity', 'dam-sediment', 'abstraction-start'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'abstraction-start': {
		long: 'For land developed, or a user connected, during the record: before this day the unit takes no water. A hydrological unit’s crops and demand objects, and an other water user’s own demand, are 0 until then; from this day they run as entered. Its runoff and dam (if any) are unaffected.\n\nEmpty = it abstracts for the whole run. A gauge takes no water, so it can’t have one.',
		aliases: ['development date', 'abstraction from', 'start of use', 'new development'],
		related: ['dam-in-service', 'irrigation-efficiency'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'diversion': {
		long: 'Each day up to this rate is taken from the water passing below the dam (upstream inflow and runoff that bypass it) and put into storage. It is entered in m³/s, as in b023 (0.2 m³/s is 17 280 m³ a day); the app stores m³/day, which the API and the exports use.\n\nIt is for an off-channel dam. A dam on the river (Upstream inflow to dam 100 %) catches the river already, so River to dam isn’t available to it: the field is read-only and the run doesn’t use it (engine 1.68.0).\n\nBy default it takes up to this every day of the year. River to dam by month sets a capacity for each month instead, replacing the one value: 0 in the summer months fills the dam in winter only. It always leaves in the river what senior other water users downstream need: the farm diverts less first when they would be short. It leaves the EWR, or a set flow, only when the unit has a hands-off flow (under Supply). A run-of-river unit has no dam, so it diverts nothing. The dam’s spill takes what doesn’t fit.\n\nThe river pump under Supply is a separate limit, for irrigation. If one pump both fills the dam and irrigates, the run treats it as two pumps, so split its capacity between River to dam and the river pump capacity.',
		aliases: ['downstream diversion', 'divert capacity', 'diversion capacity', 'river to dam', 'river to dam by month', 'pump back'],
		related: ['upstream-to-dam', 'runoff-to-dam'],
		source: 'b023 Farm spec'
	},
	'irrigation-efficiency': {
		long: 'Application losses (evaporation from sprays, wind drift, runoff at the end of the field, deep percolation and leaks) mean a hydrological unit has to abstract more than its crops use. With efficiency e, abstraction demand = crop requirement ÷ e, and a fully supplied crop gets exactly its requirement.\n\nEach crop is under an [[irrigation-system|irrigation system]] (engine 1.72.0): its default, or another on a hydrological unit that irrigates it differently, each with its efficiency from the project’s table (SABI 2021 to start with: drip 90 %, micro-sprinkler 82 %, centre pivot 85 %, sprinkler 75–80 %, flood or furrow 70 %; a scheme’s own measurement is better). A hydrological unit runs on its crops’ efficiencies combined, each weighted by the crop’s yearly water requirement, so over a year of gross requirement it abstracts the sum of each crop’s requirement ÷ its own efficiency; each day it uses the one combined efficiency, which its form shows as text.\n\nA crop on no system (a project or document from before engine 1.72.0) uses the hydrological unit’s own stored efficiency, 90 % (drip) for a new one; while one does, its form edits that value as “Efficiency for crops with no system”. Hydrological units from before engine 0.16.0 were converted from their return flow % r as e = 1 − r with every loss returning, so their water balance per hydrological unit supplied is unchanged.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['application efficiency', 'irrigation system', 'drip', 'pivot', 'sprinkler', 'flood'],
		related: ['return-flow', 'irrigation-demand', 'crop-requirement'],
		source: 'docs/engine-audit.md N1; Allen et al. 1998 (FAO-56); Keller & Bliesner 1990'
	},
	'irrigation-system': {
		long: 'The way a crop is watered on a hydrological unit, and so its application efficiency. The project keeps a table of systems on Crops & demand (Tables, Irrigation systems): it starts with SABI’s Agricultural Design Norms (2021, Table 4), each at a value inside SABI’s range (drip 90 %, micro-sprinkler 82 %, centre pivot 85 %, permanent sprinkler 80 %, movable sprinkler 75 %, flood / furrow 70 %), and the hydrologist can change any efficiency or add a system of the scheme’s own. Changing a system’s efficiency changes every crop on it.\n\nA crop has a default system, set in its sheet. A hydrological unit that irrigates the crop differently puts it on another system in its planted areas; the rest keep the default. The unit’s efficiency is its crops’ systems combined, each weighted by its yearly water requirement ([[irrigation-efficiency]]).\n\nA project from before engine 1.72.0 kept each crop’s efficiency, and each unit’s: they became systems (a SABI one when the value matched, else a row named “Imported, NN %”), so its runs are as they were. A b023 workbook’s farms come in at 100 % − their return flow, each crop on its farm’s (a SABI system, else “Workbook, NN %”).',
		aliases: ['irrigation method', 'drip', 'micro-sprinkler', 'centre pivot', 'sprinkler', 'flood', 'furrow', 'surface irrigation', 'SABI'],
		related: ['irrigation-efficiency', 'return-flow', 'crop-requirement'],
		source: 'SABI Agricultural Design Norms 2021, Table 4 (adapted from Reinders et al. 2010); docs/model.md §2.3'
	},
	'demand-factor': {
		long: 'Set only by a scenario’s “Scale demand” change (demand.scale), never in the model itself. For a hydrological unit it multiplies the crop water requirement after effective rain, so the abstraction demand (requirement ÷ efficiency) scales with it while the crop area, the irrigation efficiency and the return flow % stay as they are: 85 % means the hydrological unit takes 85 % of what it otherwise would. For an other water user it multiplies the monthly demand. Two scaling changes multiply (0.9 twice is 0.81). The gross demand and the effective rain used are not scaled.',
		aliases: ['demand scaling', 'scale demand', 'demand.scale', 'restriction'],
		related: ['irrigation-demand', 'crop-requirement', 'irrigation-efficiency'],
		source: 'docs/scenarios.md (demand.scale); docs/design/planning-outputs.md §3.1'
	},
	'return-flow': {
		long: 'The return flow is the share of the irrigation water supplied that infiltrates the soil and drains back to the river below the hydrological unit the same day (tail-water, shallow drainage, leaks): return flow = return flow % × supplied. It adds to the hydrological unit’s outflow that day. Consumptive use (what leaves the river) is supplied − return flow.\n\nIt comes out of the application losses, so it can be at most 100 % − the irrigation efficiency: at 90 % efficiency, 10 % of the water supplied is lost, and at most that 10 % can return. Whatever of the losses doesn’t return leaves the catchment (evaporation, deep percolation). A run caps a value above the losses at them and says so, which can happen when a crop on its own, more efficient system raises the unit’s combined efficiency.\n\nNew hydrological units start at 10 % (all of drip’s losses at 90 %). Before engine 1.71.0 this was entered as a share of the losses instead; saved models were converted (share of the losses × (1 − efficiency)), so they return what they did. A hydrological unit upstream of a starved neighbour can pass it some water this way: that is real (the return is bounded by what the upstream hydrological unit abstracts) and attribution by net consumptive use accounts for it.',
		aliases: ['loss return', 'return flow %', 'drainage return', 'losses returning', 'irrigation losses'],
		related: ['irrigation-efficiency', 'irrigation-supplied'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	'spill': {
		long: 'Anything left above capacity after the day’s inflow, transfers, rain on the dam, groundwater pumped into the dam, evaporation, seepage, a dam release and irrigation. It is part of the hydrological unit’s outflow.',
		related: ['dam-capacity'],
		source: 'b023 farm element sheet'
	},
	'dam-storage': {
		long: 'Yesterday’s storage plus rain on the dam, today’s captured runoff, captured upstream inflow, diversion, transfers and groundwater pumped into the dam, minus dam evaporation, seepage, a dam release and irrigation, capped at capacity.',
		related: ['dam-capacity', 'spill'],
		source: 'b023 farm element sheet'
	},

	// ---- Crops and irrigation demand -----------------------------------------
	'apan': {
		long: 'Enter the 12 monthly values for the catchment, Oct … Sep, from an A-pan station, or from the WR90 or WR2012 quaternary data converted to A-pan: those studies publish Symons-pan (S-pan) evaporation, which reads lower than an A-pan beside it (Bosman 1990 gives the conversion). Entering S-pan unchanged understates crop demand and dam evaporation. When an A-pan grid is loaded, **Evaporation from the map** (Settings → Flow calibration) proposes the row from the catchment boundary, citing the grid; a reference-ET (ET₀) grid never fills this row, because ET₀ isn’t pan evaporation.',
		aliases: ['A pan', 'Apan', 'evaporation', 'WR90'],
		related: ['crop-factor', 'irrigation-demand', 'wr90'],
		source: 'b023 Crop demand; docs/model.md §7'
	},
	'crop-factor': {
		long: 'Gross requirement (mm) = A-pan × crop factor for that month. Factors vary with the growth stage; deciduous fruit, for example, needs little in winter.\n\nThe factor multiplies Class-A pan evaporation, not FAO reference evapotranspiration (ET₀). ET₀ is the pan coefficient Kp × A-pan, so a published FAO-56 Kc entered here overstates demand by 1/Kp − 1: a third at Kp 0.75, and about 18–67 % across Kp 0.60–0.85 (FAO-56 Table 5 goes as low as 0.35 in strong wind over dry ground). Multiply it by the pan coefficient first. A factor above 1.0 is possible but unusual against a pan, so the Crops tab points it out.\n\nLoad crop factors, under the crop table (Crops & demand › Tables › Crop factors), fills the factors from a reference library, a b023 workbook or a node-based workbook’s [Crop_Factors] sheet (FAO-56 Kc values, against ET₀). The library holds the A-pan design factors of the ARC/SABI Irrigation Design Manual (winter rainfall area, Tables 4.13–4.15; pecan from Table 4.10), each with its table and page; vegetables, staged by portion of the season, need a planting date and season length. The dialog takes you through it in steps: pick the source, set the pan coefficient (it starts at 1 for A-pan factors and 0.75, a mid FAO-56 Table 5 value, for an FAO-56 Kc set), then map each crop to a source crop (largest planted area first) and pick an irrigation system for its efficiency if it should change. Each crop’s card shows its change month by month, and beside the crops the effect on the catchment’s crop requirement and abstraction, per hydrological unit and by month, before you apply. Applying edits the table only: save it with a reason. Which set a catchment uses is the hydrologist’s call.',
		aliases: ['Kc', 'crop coefficient', 'pan factor', 'crop library', 'load crop factors', 'ARC', 'SABI', 'design manual'],
		related: ['apan', 'crop-area', 'irrigation-efficiency', 'pan-coefficient'],
		source: 'b023 Crop demand; ARC/SABI Irrigation Design Manual ch. 4; docs/model.md §2.3'
	},
	'crop-area': {
		long: 'The hydrological unit’s demand is the sum over its crops of area × requirement. Stand-alone dams and natural areas have no crop area.',
		aliases: ['cropped area', 'hectares', 'farm demand'],
		related: ['crop-factor', 'irrigation-demand'],
		source: 'b023 Farm demand'
	},
	'effective-rainfall': {
		long: 'Rain above the rain threshold gives cropped area × rain × this fraction of effective rain. It covers the day’s demand first; what the crop can’t use that day goes into the soil-water store and covers the following days. Light rain at or below the threshold never counts.\n\nThe fraction can instead be set for each month (engine 0.43.0), where a wetter or drier season changes how much of the rain the crop can use. The run warns when every month is 0, since rain would then never reduce irrigation.',
		aliases: ['effective rain'],
		related: ['irrigation-demand', 'rain-threshold', 'soil-water-store'],
		source: 'b023 Crop demand; docs/model.md §2.3'
	},
	'soil-water-store': {
		long: 'Each hydrological unit has one store over its cropped area, a one-bucket form of the FAO-56 root-zone balance. Each day: effective rain is added; the day’s gross demand is met from the store plus that rain first; what is left stays, up to this depth, and the excess drains or runs off (the runoff model already counts it). The store starts empty.\n\nThe default 25 mm is the readily available water of 0.5 m of roots in a soil holding 100 mm/m, half of which the crop can take without stress (FAO-56 Tables 19 and 22). Deeper roots or a heavier soil hold more. 0 mm turns carry-over off: each day’s rain then only offsets that day, as the b023 workbook does.\n\nThis was decided on a simulated hydrologist’s recommendation and is pending the real hydrologist’s review. The daily hydrological unit CSV and “Trace a day” show the store at the end of each day.',
		aliases: ['soil moisture', 'carry-over', 'root zone', 'readily available water', 'RAW'],
		related: ['effective-rainfall', 'irrigation-demand', 'working-columns'],
		source: 'Allen et al. 1998 (FAO-56) ch. 8; docs/engine-audit.md N3; docs/model.md §2.3'
	},
	'crop-requirement': {
		long: 'Gross demand comes from crop areas × A-pan × crop factor, spread over the days of the month. The requirement subtracts the effective rain used that day, from the day’s rain or from the soil-water store it filled on earlier days, and never goes below zero. The hydrological unit abstracts more than this to cover application losses: see irrigation demand.',
		aliases: ['crop water requirement', 'net irrigation need', 'net demand'],
		related: ['irrigation-demand', 'irrigation-efficiency', 'effective-rainfall'],
		source: 'b023 Irrigation Demand; docs/model.md §2.3'
	},
	'irrigation-demand': {
		long: 'Supply, deficit, the fraction supplied and the curtailment report are all measured against this abstraction demand, so 100 % supplied means the crop got its full requirement. With 100 % efficiency it equals the crop water requirement, as in the b023 workbook.',
		aliases: ['demand', 'abstraction'],
		related: ['crop-requirement', 'irrigation-efficiency', 'irrigation-supplied', 'irrigation-deficit'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	'irrigation-supplied': {
		long: 'Irrigation draws on yesterday’s storage above the dam’s minimum operating level plus today’s captured inflows and transfers, up to the abstraction demand. Average supplied ÷ average demand is the fraction of demand supplied; the crop gets efficiency × supplied, so the same fraction of its requirement.',
		aliases: ['supply'],
		related: ['irrigation-demand', 'irrigation-deficit'],
		source: 'b023 farm element sheet; Shortfalls sheet'
	},
	'irrigation-deficit': {
		long: 'A hydrological unit with a persistent deficit is over-allocated for the water it can capture. The b023 Shortfalls sheet reports it per hydrological unit over a reporting window.',
		aliases: ['shortfall', 'unmet demand'],
		related: ['irrigation-demand'],
		source: 'b023 Shortfalls sheet'
	},

	// ---- Transfers ------------------------------------------------------------
	'transfer': {
		long: 'Each day in an active month the transfer takes what the source dam held at the end of yesterday above its minimum level, up to the room at the destination (its free space plus that day’s irrigation demand) and the maximum rate (and daily cap, if set). Transfers move before any hydrological unit irrigates. The same volume leaves the source and enters the destination, so it always balances.\n\nb023 writes transfers as free-form formulas; the app uses these structured rules instead. Anything a workbook does that doesn’t fit them needs discussing with the hydrologist.',
		aliases: ['pipeline', 'canal', 'from', 'to'],
		related: ['transfer-months', 'transfer-rate', 'transfer-min-storage'],
		source: 'b023 Help (Transfers sheet); docs/model.md §2.6'
	},
	'transfer-months': {
		long: 'Often a winter-filling scheme: move water while the source dam spills, not in the irrigation season. Each month has its own maximum rate, so a pipe that runs at half capacity in spring and full in winter is one rule. A blank (0) month is off. A b023 workbook gives one rate and the months it runs in; that reads as the same rate in each of those months and runs exactly as before until you change a month (engine 1.14.0).',
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	'transfer-rate': {
		long: 'The day’s transfer is the smallest of the available water in the source dam, the room at the destination, the month’s rate × 86 400 s, and the daily cap when one is set.',
		aliases: ['max rate', 'daily cap'],
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	'transfer-offtake': {
		long: 'Pick **The river (an off-take)** under **Takes from**. Each day, once the source hydrological unit has taken its own water, the off-take takes from the flow leaving it, up to the month’s rate (× 86 400) and the daily cap, but never the flow it must leave: the senior users’ requirement, the target of a pass-inflow release on the source’s dam (as the source’s own river pump leaves it; engine 1.70.0), its **hands-off flow** and, with **Leaves the EWR in the river**, the EWR there. Without those it doesn’t protect the EWR, like any other abstraction, and an application that adds or changes an off-take without either can’t have its evidence pack issued.\n\n**Takes** says how much: **What the destination needs** (its demand today, and its dam’s room when it **tops up the destination’s dam**, counting what a fixed release will let out of that dam that day, so the dam ends full; under an allocation cap, only the demand its cap still allows today; engine 1.70.0) or **Up to capacity**, like a canal that runs full whatever is drawn from it. A share of what it takes, the **losses on the way**, never arrives (seepage and evaporation from the canal). By default those losses leave the catchment; **Losses seeping back** returns a share of them to the river the same day, below the source or, with **Rejoins the river below**, below a hydrological unit further down the source’s river (engine 1.42.0). The water account then counts only the rest as lost, and the EWR charge credits the returned water where the losses were charged. At the destination the water meets the demand first, before the hydrological unit’s own dam, pump and boreholes; what is left fills the dam when the rule says so, and otherwise flows on down the destination’s river, where hydrological units below it (a town on the canal) can pump it.\n\nThe destination is worked out after its source each day, so an off-take whose destination drains back into its source can’t run; the model refuses it.\n\nOff-takes from one hydrological unit take by **priority**, lowest first; those of one priority share a short river in proportion to what each asks (its capacity, or its share of the destination’s need), each leaving the flow it must leave: an equal percentage cut, so a licence split into several rules gets what it would as one rule. Enter each licence once: one entered twice at its full size takes twice, and the run warns about rules of one priority between the same two hydrological units.',
		aliases: ['off-take', 'offtake', 'canal', 'weir', 'diversion', 'hands-off flow', 'conveyance losses', 'furrow', 'canal seepage', 'seepage return'],
		related: ['transfer', 'transfer-rate', 'transfer-months'],
		source: 'docs/model.md §2.6a'
	},
	'transfer-min-storage': {
		long: 'Checked against yesterday’s end-of-day storage. The reserve kept is the higher of this value and the source dam’s minimum operating level.',
		related: ['dam-min', 'transfer'],
		source: 'b023 Transfers configuration; docs/model.md §3 Q3'
	},
	'transfer-priority': {
		long: 'Each day, before any hydrological unit irrigates, each rule moves the smallest of: what its source dam holds above its minimum (yesterday’s storage, less what earlier rules took), the room at its destination (free space in the destination’s dam once that day’s rain on it, evaporation and seepage are counted, plus that day’s irrigation demand and what a fixed release lets out of that dam that day, less what other rules already sent it), and its rate or daily cap. A transfer to a hydrological unit with no dam still serves the hydrological unit’s demand; water is never pumped into a full dam only to spill.\n\nRules run by priority, lowest first. Rules with the same priority share: two rules from one dam split its water in proportion to their own limits (their rates or daily caps, an equal percentage cut, so one rule split into two moves the same total; engine 1.70.0), each only above its own minimum (where their minimums differ, the water between them goes only to the rules whose minimum is lower, engine 1.36.0), and two rules into one hydrological unit split its room in proportion to what their sources can give, room one source can’t fill going to the others (engine 1.70.0), so the order of the list never changes a result. New rules start after the existing ones. The source’s own irrigation comes after the day’s transfers (the source doesn’t irrigate first).\n\nDecided on the recommendation of simulated hydrologist and licensing reviews (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['priority', 'order', 'pro rata', 'free space', 'receiving dam'],
		related: ['transfer', 'transfer-min-storage', 'transfer-rate'],
		source: 'docs/engine-audit.md N4, N6, Q18; docs/model.md §2.6'
	},

	// ---- Natural flow and calibration -----------------------------------------
	'natural-flow': {
		long: 'The runoff model, GR4J, turns daily rain into natural flow. The workbook fell back to a Pitman flow column on days the rain model gave nothing (quirk Q7); the app does not, so natural flow always comes from the runoff model.\n\nNatural flow is then split into hydrological unit runoff by the flow shares.',
		aliases: ['naturalised flow', 'virgin flow'],
		related: ['calibration', 'flow-share', 'runoff-model'],
		source: 'b023 Flow data sheet; docs/model.md §2.4'
	},
	'farm-runoff': {
		long: 'Natural flow × the hydrological unit’s flow share.',
		related: ['natural-flow', 'flow-share'],
		source: 'b023 Fragmented flow'
	},
	'upstream-inflow': {
		long: 'Upstream elements are always computed first, so a hydrological unit sees today’s outflow of its upstream neighbours.',
		related: ['network', 'farm-outflow'],
		source: 'b023 farm element sheet'
	},
	'farm-outflow': {
		long: 'It becomes the next element’s upstream inflow. At the outflow gauge it is the catchment’s simulated outflow.',
		related: ['upstream-inflow', 'spill', 'return-flow'],
		source: 'b023 farm element sheet'
	},
	'calibration': {
		long: 'Tune by hand (change a parameter, run, and compare simulated with observed flow: hydrograph and statistics such as NSE and PBIAS), or let Fit automatically search for the parameters. Calibrate over a period with a good observed record; the workbook uses its own calibration date window, separate from the main run.',
		aliases: ['flow calibration', 'tuning'],
		related: ['gr4j', 'nse', 'pbias', 'observed-flow'],
		source: 'b023 Help (Calibration function; Flow Calibration Cfg)'
	},
	'runoff-model': {
		long: 'GR4J is the only runoff model since engine 1.0.0, so there is nothing to choose. The workbook’s own model, the legacy runoff model, did not conserve water and was removed; runs made with it before then still open, labelled “Workbook comparison”, but can’t be re-run.\n\nThe runoff model only changes how rain becomes natural flow. Flow shares, hydrological units, dams, transfers and the EWR are the same whichever model made the flow, so an old legacy run and a GR4J run compare directly.',
		aliases: ['rain-runoff model', 'rainfall-runoff'],
		related: ['calibration', 'natural-flow', 'gr4j', 'legacy-runoff-model'],
		source: 'docs/model.md §2.4; issues #4, #16'
	},
	'gr4j': {
		long: 'GR4J (Perrin, Michel & Andréassian 2003) is used worldwide. Rain first meets evaporation; what is left partly fills a soil-moisture (production) store of capacity X1. The rest, plus what percolates out of that store, is spread in time by two unit hydrographs of time base X4 days. 90 % goes through a routing store (reference capacity X3), and 10 % goes straight to the outlet.\n\nX2 exchanges water with groundwater outside the catchment. It is fixed at 0 by default, so the catchment is closed and the balance rain − evaporation − flow = change in storage holds every day. The model first runs a warm-up (a year by default) over the start of the record, so the stores begin at a realistic level; warm-up days are never shown or scored.\n\nTypical values: X1 100–1 200 mm, X3 20–300 mm, X4 1.1–2.9 days.',
		aliases: ['X1', 'X2', 'X3', 'X4', 'production store', 'routing store', 'unit hydrograph', 'warm-up', 'Perrin'],
		related: ['runoff-model', 'pan-coefficient', 'actual-evaporation'],
		source: 'Perrin et al. (2003), J. Hydrol. 279; docs/model.md § Rain to flow: GR4J'
	},
	'pan-coefficient': {
		long: 'A Class-A pan evaporates more than a catchment’s soils and plants could, so conceptual runoff models scale it down. 0.7 is a common flat value. Monthly values (for example the WR90 or Midgley factors) can be entered instead. The coefficient does not affect irrigation demand, which uses crop factors on the A-pan directly. It is used only while GR4J’s potential evaporation is set to pan coefficient × A-pan; with a monthly PE row entered directly GR4J ignores it.\n\nThree presets fill the row as a starting point (still editable; picking one writes its name into the optional “Pan coefficient source” note): Generic (flat 0.70), Winter rainfall (e.g. Western Cape) and Summer rainfall. They are indicative, from FAO-56 Table 5 climate classes (Allen et al. 1998) — confirm against local humidity and wind. A run warns, and Settings hints, when a month sits outside FAO-56’s usual 0.6–0.85 range for a Class A pan; that is a plausibility check, not a hard limit, so a value further out still saves and runs.\n\nThe FAO-56 Table 5 helper fills the row from monthly humidity and wind, the pan’s siting and its fetch, and writes the table cells and your note on where the humidity and wind came from into the same source note. The note is provenance only: fits and runs record it, and editing it never marks a fit’s forcing as changed.\n\nBecause GR4J’s parameters trade off against evaporation, the coefficient is held fixed and never calibrated: a fit records the coefficient it ran under, and changing it afterwards marks the fit record “Forcing changed since fit”.',
		aliases: ['PET', 'potential evaporation', 'k pan', 'pan coefficient preset', 'FAO-56'],
		related: ['gr4j', 'apan', 'auto-calibration'],
		source: 'Issue #4 §1 (forcing); FAO-56 Table 5 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'gr4j-pe': {
		long: 'One A-pan row drives three things: GR4J’s potential evaporation (× the pan coefficient), irrigation demand (× the crop factors) and dam evaporation (× the dam evaporation factor). With **Pan coefficient × A-pan**, the default and what every earlier run did, changing the A-pan row moves all three.\n\n**Monthly PE, entered directly** gives GR4J its own 12 values in mm (Oct … Sep), for example a station’s FAO-56 reference evapotranspiration (ET₀) × a stated factor, with a required note of the source. GR4J then runs on that row alone; the pan coefficient is not used, and irrigation demand and dam evaporation still read the A-pan row, so a PE change moves the runoff model and nothing else. A row of zeros is refused, as a zero A-pan row is.\n\n**Evaporation from the map**, under this group, proposes the row from a reference-ET grid averaged over the catchment boundary, as it stands (factor 1); **Use** saves it with a source note naming the grid, its version and years.\n\nSettings shows the annual PE GR4J runs on under either choice. A fit records the PE input it ran under, so changing it marks the fit record “Forcing changed since fit”.',
		aliases: ['PE', 'PET', 'ET0', 'ET₀', 'reference evapotranspiration', 'monthly PE', 'evaporation source'],
		related: ['pan-coefficient', 'apan', 'gr4j'],
		source: 'Issue #39; FAO-56 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'areal-rain': {
		long: 'A valley rain gauge or a 0.05° satellite product such as CHIRPS can read well below the rain that falls on a mountain catchment as a whole: orographic rain on the ridges is what they miss most. GR4J conserves water, so on such rain it cannot make the flow the gauge records without importing water through X2, which would hide the rain error in a parameter.\n\nThe correction multiplies the rain GR4J runs on (catchment rain, else corrected CHIRPS, else forecast) by a factor per month (Oct … Sep, each 0.25–4), with the method and a required note of the source. The preferred basis is an **independent MAP**: the catchment’s mean annual precipitation from WR2012, an isohyetal map or a gridded MAP averaged over the catchment, divided by the forcing’s own mean annual rain over its complete water years (one flat factor, since an annual MAP says nothing about the seasons). **Rain gauges** in or near the catchment are the other independent basis. A factor **fitted** to the flow record is allowed but makes the rain level a calibrated multiplier that trades off against X1 and the evaporation, and every run says so.\n\nOnly the runoff model reads it. Irrigation demand’s effective rain and rain on the dams keep the recorded rain, because the fields and dams sit in the valley where the gauge is. The runoff coefficient, the WR2012 rain scaling, the water account and the plausibility checks read the corrected rain, which runs show as the daily “Areal catchment rainfall” column. A fit records the factors it ran under, so changing them marks the fit record “Forcing changed since fit”.',
		aliases: ['areal rain', 'areal rainfall', 'rain factor', 'MAP correction', 'orographic rain', 'rain scaling', 'arealRain'],
		related: ['gr4j', 'chirps-bias', 'rain-final', 'gr4j-pe'],
		source: 'Engine 1.13.0; docs/model.md §2.4g; docs/calibration-research.md § Rain forcing'
	},
	'unit-rain': {
		long: 'Off (the default), GR4J runs once on the catchment rain and each hydrological unit gets its flow share of the natural flow. On, GR4J runs once for each unit with land, with the one calibrated parameter set, the catchment’s evaporation and the unit’s own area, and each unit’s runoff is its own inflow; the natural flow at the outlet is their routed sum. Each unit’s rain is, in this order:\n\n• **Its own rain gauge**, as recorded, its gaps filled by its CHIRPS scaled to its MAP.\n• **The catchment gauge × unit MAP ÷ gauge MAP**, when the gauge’s MAP is set here and the unit has a MAP. Days the gauge has none take the unit’s CHIRPS scaled to its MAP.\n• **Its own CHIRPS**, scaled by its MAP ÷ the CHIRPS mean annual rain over the MAP period (1991–2020 by default, at least 5 complete years), or with the catchment’s CHIRPS correction when it has no MAP.\n• **Otherwise the catchment rain**, as with the switch off, with the areal rainfall correction; the run warns, naming the unit.\n\nEvery factor is flat and held between 0.25 and 4, and a held one warns. Demand, rain on the dams and the WR2012 check keep the catchment rain. Set up each unit’s CHIRPS under Data feeds, Rain for each unit, and its MAP on the unit’s form. GR4J is nonlinear, so switching it on changes the flow even where the rain is the same: refit afterwards. The run lists each unit’s rule, factor and source.',
		aliases: ['per-unit rain', 'rain per unit', 'unit rain', 'semi-distributed GR4J', 'unitRain'],
		related: ['unit-map', 'areal-rain', 'gr4j', 'flow-share'],
		source: 'docs/model.md §2.4h; issue #482'
	},
	'actual-evaporation': {
		long: 'The part of potential evaporation that rain meets directly, plus what the soil-moisture store can give up. On dry days with a dry store it falls well below PET.',
		related: ['gr4j', 'pan-coefficient'],
		source: 'Perrin et al. (2003)'
	},
	'wr2012-check': {
		long: 'WR2012 (Water Resources of South Africa 2012) gives each quaternary catchment a naturalised mean annual runoff (MAR) and mean monthly flows: the river as it would be with no hydrological units, dams or abstraction. Enter them from the study for the quaternary this project lies in, with the period they cover and where they come from. The app doesn’t ship WR2012 data.\n\nEach run then compares its simulated natural flow, never the outflow, with the reference. The reference is scaled to the modelled catchment by the area ratio (the default), or, if you choose it and the quaternary MAP is entered, by the area and the rainfall ratio (the run’s mean annual rain ÷ the quaternary MAP). Runoff doesn’t scale in proportion to rain, so treat the rainfall scaling as a first estimate.\n\nThe report gives the MAR ratio over the complete water years both cover and over the whole run, the 12 monthly ratios with the dry-season months marked, and the correlation of the monthly pattern. A MAR that differs by 10 % is noted, by 25 % (or 15 % wetter) is queried, and by 50 % makes the run unusable for EWR findings until it is explained. The thresholds are editable.\n\nMonthly means are in million m³ per month (not m³/s) and should add up to the MAR within 5 %. A MAR larger than the rain on the quaternary (MAP × area) is rejected.',
		aliases: ['WR2012', 'naturalised flow', 'naturalized flow', 'MAR', 'quaternary', 'Water Resources of South Africa'],
		related: ['natural-flow', 'wr2012-penalty', 'gr4j'],
		source: 'Bailey & Pitman, Water Resources of South Africa 2012 Study (WRC); docs/model.md § WR2012 check',
		countries: ['ZA']
	},
	'catchment-area': {
		long: 'Set it only when the modelled hydrological units don’t cover the whole catchment and you want rain over the full area. 1 mm over 1 km² = 1 000 m³.',
		related: ['farm-area', 'gr4j'],
		source: 'b023 Farm spec (total area)'
	},
	'rain-threshold': {
		long: 'Filters out drizzle that the soil absorbs, so it doesn’t reduce irrigation demand (“Rain threshold for demand”). GR4J uses all the rain. In the legacy runoff model (removed in engine 1.0.0) the same thresholded rain also drove runoff (quirk Q6).',
		related: ['effective-rainfall', 'legacy-runoff-model'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §3 Q6'
	},
	'base-flow': {
		long: 'GR4J has no separate base-flow store: its routing store carries most of the storm flow too. Where the app needs base flow (Low flows judged on) it separates it from the flow with the Lyne–Hollick filter. The Base flow column of a daily table belongs to a legacy run (engine < 1.0.0): there base flow receded day by day along the recession curve, and a big enough rain pulse reset it to the pulse size.',
		aliases: ['baseflow', 'low flow', 'quickflow'],
		related: ['gr4j', 'legacy-runoff-model'],
		source: 'b023 Flow data; docs/model.md §2.4'
	},
	'legacy-runoff-model': {
		long: 'The workbook’s empirical model: rain above the threshold made a peak a · rain^b × catchment area × a summer or winter factor (a summer month, or a winter month before a big storm switched it to winter response), which then receded along a recession curve, next to a slowly receding base flow. The engine audit found that it does not conserve water: one small storm could return several times its own volume as flow, so it was never evidence and engine 1.0.0 removed it.\n\nRuns made with it before then still open read-only, badged “Workbook comparison”: they can be compared and exported, but not re-run, nominated as evidence, signed or published. Their daily table keeps the model’s own columns (summer flag, rain flow, response flow, base flow). A project still set to it runs GR4J, with a warning to check the GR4J parameters.',
		aliases: ['legacy model', 'b023 recession', 'peak coefficient', 'summer factor', 'winter factor', 'summer months', 'recession curve', 'workbook comparison'],
		related: ['runoff-model', 'gr4j', 'base-flow'],
		source: 'docs/model.md §2.4 (retired); docs/engine-audit.md H1; issue #16'
	}
};

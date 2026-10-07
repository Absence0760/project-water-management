// Script URLs in the page (docs/security.md § Input handling). Svelte escapes
// an attribute's text but not its meaning: `href={x}` with x =
// "javascript:alert(1)" runs script when clicked, and so do `src`, `action`,
// `formaction` and `srcdoc`. This walks every component under src/ and checks
// each URL-bearing attribute:
//
//   - a value whose head is literal text ("/…", "?tab=…", "#…", "{base}/farm")
//     fixes the scheme itself, and the scheme must be http(s), mailto or tel
//     (never javascript:, data:, vbscript:, and never a protocol-relative
//     "//host");
//   - a value whose head is an expression (`href={runHref(id)}`, `{href}`)
//     can be anything at run time, so its expression must be one of the
//     REVIEWED heads below, each with the reason it can't carry a script URL.
//     A new one fails here until someone looks at where its value comes from.
//
// The app's URL builders are then called with hostile ids (a node, run or
// project id is data) and must still land on the app's own origin. Around
// that: no `srcdoc`, no frame/object/embed element, no script-URL assignment
// from TypeScript, and every `target="_blank"` link carries rel="noopener".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareTabHref } from './components/compare/picker';
import { farmDrawerHref } from './components/crops/farmDrawer';
import { farmHref } from './components/farm/load';
import { fieldHistoryHref } from './components/history/fieldLine';
import { noteHref } from './components/notes/notes';
import { runHref } from './components/overview/attention';
import { curtailmentHref } from './components/portfolio/portfolio';
import { riverHref } from './components/river/links';
import { mapNodeHref } from './workspace/mapLinks';
import { supplyHref } from './components/supply/links';
import { withoutParam, withParam } from './workspace/overlays';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Attributes whose value the browser loads or navigates to. */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'ping', 'xlink:href', 'background', 'cite', 'data']);
/** Schemes a literal URL may name. Everything else (javascript:, data:, vbscript:, file:, …) is refused. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Expressions allowed at the head of a URL attribute, by their leading name
 * (`runHref(meta.id)` → `runHref`, `api.farm.exportUrl(…)` →
 * `api.farm.exportUrl`) and the components (`in`, paths under src/) where
 * that name was reviewed. A name means what its component makes it mean (a
 * local `href`, an imported `runHref`), so the same name in another
 * component is unreviewed until it is added here; a listed component that no
 * longer uses the name fails as stale. The builders marked BUILDER are
 * called with hostile ids in the last test.
 */
const REVIEWED: Record<string, { why: string; in: string[] }> = {
	// App URL builders: each returns "?tab=…", "#…" or "{base}/…" with its ids encoded (BUILDER).
	withParam: { why: 'BUILDER: "?" + URLSearchParams of the current page', in: ['lib/components/allocations/AllocationsTab.svelte', 'lib/components/crops/CropsTab.svelte', 'lib/components/scenarios/ApplicantView.svelte', 'lib/components/dams/DamsTab.svelte', 'lib/components/map/MapTab.svelte', 'lib/components/network/NetworkTab.svelte', 'lib/components/settings/SettingsTab.svelte', 'lib/components/supply/SupplyTab.svelte'] },
	runHref: { why: 'BUILDER: "?tab=runs&run=" + encoded id', in: ['lib/components/dams/DamsTab.svelte', 'lib/components/overview/LatestRun.svelte', 'lib/components/overview/OverviewTab.svelte', 'lib/components/overview/PublishedBaseline.svelte', 'lib/components/river/RiverTab.svelte', 'lib/components/supply/SupplyTab.svelte', 'routes/projects/[id]/reports/[jobId]/+page.svelte'] },
	riverHref: { why: 'BUILDER: "?tab=river…"', in: ['lib/components/runs/RunsTab.svelte'] },
	mapNodeHref: { why: 'BUILDER: "?tab=map&node=" + encoded node id (workspace/mapLinks.ts, #326 A2)', in: ['lib/components/crops/CroplandProposalsBox.svelte', 'lib/components/dams/DamProposalsBox.svelte', 'lib/components/dams/DamsTab.svelte', 'lib/components/supply/SupplyTab.svelte'] },
	'view.src': { why: 'LocalityMap: data:image/svg+xml of the engine\'s own locality figure (packages/engine/src/geo/localityMap.ts, numbers and escaped names only), shown in an <img>, where an SVG runs no script (report/evidence/locality.ts)', in: ['lib/components/report/evidence/LocalityMap.svelte'] },
	mapHref: { why: 'NodeCard/NodeDetail: their `mapHref` prop, which NetworkTab builds with mapNodeHref(node id) or leaves null', in: ['lib/components/network/NodeCard.svelte', 'lib/components/network/NodeDetail.svelte'] },
	supplyHref: { why: 'BUILDER: "?" + URLSearchParams', in: ['lib/components/dams/DamsTab.svelte', 'lib/components/runs/RunsTab.svelte', 'lib/components/supply/SupplyTab.svelte'] },
	farmHref: { why: 'BUILDER: "{base}/farm/" + encoded project id; NodeCard: its `farmHref` prop, which NetworkTab builds with withParam', in: ['lib/components/network/NodeCard.svelte', 'routes/farm/+page.svelte', 'routes/farm/[projectId]/+page.svelte'] },
	farmDrawerHref: { why: 'BUILDER: "?…farm=" overlay link', in: ['lib/components/overview/SupplyByFarm.svelte'] },
	compareTabHref: { why: 'BUILDER: "?" + URLSearchParams', in: ['lib/components/runs/RunsTab.svelte'] },
	packHref: {
		why: 'BUILDER: "{base}/projects/" + encoded project id + "/packs/" + encoded pack id (packs/pack.ts)',
		in: ['lib/components/packs/PackActions.svelte', 'lib/components/report/evidence/EvidencePage.svelte', 'lib/components/scenarios/ApplicationPanel.svelte', 'lib/components/scenarios/ApplicationsTab.svelte']
	},
	'c.licenceUrl': { why: 'data sources page: each credit\'s licence link, a literal https:// URL in lib/components/legal/dataCredits.ts (dataCredits.test.ts checks every one starts with https://)', in: ['routes/data-sources/+page.svelte'] },
	bundleUrl: { why: 'pack page: api.packs.bundleUrl (PUBLIC_API_URL + the encoded project and pack ids), never from a response', in: ['routes/projects/[id]/packs/[packId]/+page.svelte'] },
	manifestUrl: { why: 'pack page: URL.createObjectURL of the manifest JSON it builds, a blob: URL for the download', in: ['routes/projects/[id]/packs/[packId]/+page.svelte'] },
	curtailmentHref: { why: 'BUILDER: "{base}/projects/…" (portfolio.ts; the team page wraps it under the same name)', in: ['routes/teams/[id]/+page.svelte', 'lib/components/projects/ProjectTable.svelte'] },
	historyHref: { why: 'BUILDER: compare/attribution.ts "/projects/" + encoded project id + "?tab=history"', in: ['lib/components/compare/CompareView.svelte'] },
	// Local builders and constants in the component itself: a literal "?", "#" or "{base}/" head.
	tabHref: { why: 'routes/projects/[id]: "?tab=<TabId>" or the current pathname', in: ['routes/projects/[id]/+page.svelte'] },
	addDataHref: { why: 'ProjectTable: `${base}/projects/${id}?add=data`', in: ['lib/components/projects/ProjectTable.svelte'] },
	projectHref: { why: 'OverviewTab: project/links.ts "?tab=project" + an anchor', in: ['lib/components/overview/OverviewTab.svelte'] },
	guide: { why: 'SectionHeader: its `guide` prop, which the workspace page and ApplicantView build as "{base}/help/guides/" + a TAB_GUIDE id (lib/workspace/tabs.ts, a constant; guides.test.ts checks each is a real guide)', in: ['lib/components/workspace/SectionHeader.svelte'] },
	loginHref: { why: 'register page: `${base}/login?next=` + encoded next', in: ['routes/register/+page.svelte'] },
	termsHref: { why: 'TermsSummary: its `termsHref` prop, "/terms" by default; the register page passes `${base}/terms`', in: ['lib/components/legal/TermsSummary.svelte'] },
	forgotHref: { why: 'login page: `${base}/forgot-password…`', in: ['routes/login/+page.svelte'] },
	settingsHref: { why: 'team page: withParam(page.url, …)', in: ['routes/teams/[id]/+page.svelte'] },
	back: {
		why: 'EvidencePage, the pack pages: `${base}/projects/${id}?tab=scenarios&scenario=` + encoded id, or "?tab=runs&run=" + encoded id',
		in: [
			'lib/components/report/evidence/EvidencePage.svelte',
			'routes/projects/[id]/packs/[packId]/+page.svelte',
			'routes/projects/[id]/scenarios/[sid]/packs/[packId]/+page.svelte',
			'routes/projects/[id]/scenarios/[sid]/participation/+page.svelte'
		]
	},
	applicantPackHref: {
		why: 'BUILDER: "{base}/projects/" + encoded project id + "/scenarios/" + encoded scenario id + "/packs/" + encoded pack id (packs/applicantPack.ts; a pack id the API maps as a UUID or drops)',
		in: ['lib/components/scenarios/ApplicationPanel.svelte', 'routes/projects/[id]/scenarios/[sid]/packs/[packId]/+page.svelte']
	},
	scenarioHref: { why: 'ApplicationsTab: local "?tab=scenarios&scenario=" + encoded id', in: ['lib/components/scenarios/ApplicationsTab.svelte'] },
	filterHref: { why: 'ApplicationsTab: withoutParam(page.url, "status") or withParam(page.url, "status", f)', in: ['lib/components/scenarios/ApplicationsTab.svelte'] },
	assessHref: { why: 'ApplicationsTab: withParam(page.url, "view", "assess")', in: ['lib/components/scenarios/ApplicationsTab.svelte'] },
	listHref: { why: 'ApplicationsTab: withoutParam(page.url, "view")', in: ['lib/components/scenarios/ApplicationsTab.svelte'] },
	newHref: { why: 'ScenariosTab: withParam(page.url, "new", "1")', in: ['lib/components/scenarios/ScenariosTab.svelte'] },
	panelHref: { why: 'PublishedBaseline: runHref(…) + "#res-publication" or "?tab=runs"', in: ['lib/components/overview/PublishedBaseline.svelte'] },
	compareHref: { why: 'PublishedBaseline / ScenarioCompare: compareTabHref(…) or "?…"', in: ['lib/components/overview/PublishedBaseline.svelte', 'lib/components/scenarios/ScenarioCompare.svelte'] },
	reserveHref: { why: 'RunSummaryView: riverHref(…)', in: ['lib/components/runs/RunSummaryView.svelte'] },
	otherUsesHref: { why: 'RunSummaryView: supplyHref(run id, a fixed #res-… anchor from otherUsesLink), a `?tab=` query', in: ['lib/components/runs/RunSummaryView.svelte'] },
	balanceHref: {
		why: 'SelfChecksPanel: the literal "#res-water-balance" RunsTab passes; WaterAccountPanel: runHref(run id) + "#res-water-balance", which RiverTab passes',
		in: ['lib/components/runs/SelfChecksPanel.svelte', 'lib/components/reliability/WaterAccountPanel.svelte']
	},
	accountHref: { why: 'WaterBalanceTable: riverHref(run id, "res-water-account"), which RunsTab passes', in: ['lib/components/runs/WaterBalanceTable.svelte'] },
	previewHref: { why: 'NodeDetail: farmHref(…)', in: ['lib/components/network/NodeDetail.svelte'] },
	issueHref: { why: 'BUILDER: "?tab=<area>" with the item id encodeURIComponent-ed (model/validate.ts issueHref)', in: ['lib/components/model/IssueList.svelte'] },
	'p.href': { why: 'ProblemLinks: issueHref(…), "#" + a NumberInput id, or a draft adapter\'s "?tab=project" / "?tab=settings#<group id>" (SaveBar, ModelSaveRow, the page)', in: ['lib/components/model/ProblemLinks.svelte'] },
	plantedHref: { why: 'NodeDetail: NetworkTab builds "?" + URLSearchParams of the current page with farm=<node id>, or leaves it null', in: ['lib/components/network/NodeDetail.svelte'] },
	transfersHref: { why: 'NodeDetail: NetworkTab passes the literal "?tab=transfers" or null', in: ['lib/components/network/NodeDetail.svelte'] },
	main: { why: 'farm why/dam pages: farmHref(…)', in: ['routes/farm/[projectId]/dam/+page.svelte', 'routes/farm/[projectId]/why/+page.svelte'] },
	href: { why: 'the farm page’s href(sub) = farmHref(…), RecentNotes’ noteHref(…), and DamCard/LookingBack’s `href` prop, whose callers are checked here too', in: ['lib/components/farm/DamCard.svelte', 'lib/components/farm/LookingBack.svelte', 'lib/components/notes/RecentNotes.svelte', 'routes/farm/[projectId]/+page.svelte'] },
	reports: { why: 'CompareView: reportHref(), `${base}/projects/<project id>/report?` + URLSearchParams (run, against)', in: ['lib/components/compare/CompareView.svelte'] },
	'step.href': { why: 'HelpCrumbs: its `trail` prop; the help pages pass `${base}/help` and help-guide paths built from guide ids', in: ['lib/components/help/HelpCrumbs.svelte'] },
	fieldHistoryHref: { why: 'BUILDER: history/fieldLine.ts "?" + URLSearchParams (tab, kind, unit, q)', in: ['lib/components/history/FieldHistoryLine.svelte'] },
	editHref: { why: 'DemandsTable: the literal "?tab=crops&farm=" or "?tab=network&edit=" + encodeURIComponent(node id)', in: ['lib/components/network/DemandsTable.svelte'] },
	entryHref: { why: 'HistoryTab: withParam(page.url, "entry", key)', in: ['lib/components/history/HistoryTab.svelte'] },
	uploadHref: { why: 'MapSetupPill prop: MapTab passes withParam(page.url, "upload", "1")', in: ['lib/components/map/MapSetupPill.svelte'] },
	'rainLink.href': { why: 'MapSetupPill prop: MapTab passes the literal "?tab=settings&rain=boundary#set-feeds"', in: ['lib/components/map/MapSetupPill.svelte'] },
	reportHref: { why: 'report job page: `${base}/projects/` + encoded project id + "/report" (+ "?run=" + encoded run id)', in: ['routes/projects/[id]/reports/[jobId]/+page.svelte'] },
	'register.registerUrl': {
		why: 'SignoffSection, the public verify page, the registration checks panel: liability/registration.ts constant https:// link to the ECSA or SACNASP public register',
		in: ['lib/components/liability/SignoffSection.svelte', 'routes/verify/[[code]]/+page.svelte', 'lib/components/project/RegistrationChecksPanel.svelte']
	},
	ARC4_URL: { why: 'crops/library.ts constant https:// link to the SABI manual', in: ['lib/components/crops/LoadCropFactorsDialog.svelte'] },
	FAO56_TABLE5_URL: { why: 'crops/loadFactors.ts constant https:// link to FAO-56 ch. 3 (Table 5)', in: ['lib/components/crops/LoadCropFactorsDialog.svelte'] },
	glossaryPath: { why: 'help glossary: "/help/glossary/<slug>#<id>", the slug from TOPIC_SLUGS and the id from the static help text (lib/help/glossaryLinks.ts)', in: ['lib/components/help/HelpTip.svelte', 'lib/components/help/RichText.svelte', 'routes/help/glossary/+page.svelte', 'routes/help/glossary/[topic]/+page.svelte', 'routes/help/guides/[id]/+page.svelte', 'routes/help/search/+page.svelte'] },
	topicPath: { why: 'help glossary: "/help/glossary/<slug>" from the TOPIC_SLUGS table (lib/help/glossaryLinks.ts)', in: ['routes/help/glossary/+page.svelte'] },
	'unrun.path': { why: 'GetStarted: projects/example.ts startFromExample\'s "/projects/" + encodeURIComponent(the new project\'s id), after {base}', in: ['lib/components/projects/GetStarted.svelte'] },
	'l.href': { why: 'HelpNav: "/help…" paths built in the component from guide ids (lib/help/guides.ts) and topicPath', in: ['lib/components/help/HelpNav.svelte'] },
	pictureSrc: { why: 'help pictures: "/help/<static file name>" from the SHOTS table', in: ['lib/components/help/HelpTip.svelte', 'lib/components/help/PictureTour.svelte'] },
	pictureSrcset: { why: 'help pictures: two pictureSrc paths with widths (help/pictures.ts)', in: ['lib/components/help/PictureTour.svelte'] },
	srcset: { why: 'landing Diorama: `${base}/landing/hero-<day|dusk>-<width>.<avif|webp>`, the widths from art.generated.ts (numbers)', in: ['lib/components/landing/Diorama.svelte'] },
	set: { why: 'landing Shot: `${base}/landing/screen-<name>-<light|dark>-<width>.<avif|webp>`, name a literal from Screens.svelte', in: ['lib/components/landing/Shot.svelte'] },
	addressOf: { why: 'LanguageSwitch: its `addressOf` prop; the landing page passes `${base}` + landingPath(code), "/welcome" or "/welcome/<code>" for a code of the language table (issue #137)', in: ['lib/i18n/LanguageSwitch.svelte'] },
	abs: { why: 'landing link-preview tags: new URL(`${base}` + a literal path, page.url).href, the page’s own origin', in: ['lib/components/landing/Landing.svelte'] },
	// Objects built in code from the builders above.
	'done.href': { why: 'the invitations page: `${base}/teams/`, `/farm/` or `/projects/` + the encoded id of what was joined', in: ['routes/account/invitations/+page.svelte'] },
	'back.href': { why: 'FarmShell prop: callers pass `${base}/farm` or farmHref(…)', in: ['lib/components/farm/FarmShell.svelte'] },
	'preview.href': { why: 'FarmShell prop: FarmPage builds `${base}/projects/<encoded id>?tab=network`', in: ['lib/components/farm/FarmShell.svelte'] },
	'more.href': { why: 'SupplyByFarm / ReserveStrip prop: OverviewTab passes supplyHref / riverHref', in: ['lib/components/overview/ReserveStrip.svelte', 'lib/components/overview/SupplyByFarm.svelte'] },
	'h.href': { why: 'LatestRun: latestRun.ts rows with DAMS_HREF and the builders', in: ['lib/components/overview/LatestRun.svelte'] },
	'r.href': { why: 'CompareView: the `reports` list, reportHref() (`${base}/projects/<id>/report?` + URLSearchParams); projects/NeedsAttention: outcomes.ts attention() reasons, built by curtailmentHref (`${base}/projects/…`) or absent', in: ['lib/components/compare/CompareView.svelte', 'lib/components/projects/NeedsAttention.svelte'] },
	allHref: { why: 'projects/NeedsAttention prop: the list page passes hrefWith(…)', in: ['lib/components/projects/NeedsAttention.svelte'] },
	hrefWith: { why: 'projects list page: "?" + URLSearchParams(owner, sort, q), or `${base}/`', in: ['routes/+page.svelte'] },
	'it.href': { why: 'NeedsAttention: attention.ts items built from runHref / farmDrawerHref or "?tab=…" literals', in: ['lib/components/overview/NeedsAttention.svelte'] },
	'c.href': { why: 'RunSummaryView: credibility.ts "#res-…" anchors', in: ['lib/components/runs/RunSummaryView.svelte'] },
	// Values that come from outside the component, each checked where it enters.
	'api.packs.pdfUrl': {
		why: 'an issued evidence pack’s PDF download: PUBLIC_API_URL + an encoded path of the project and pack ids (lib/api/client.ts packs.pdfUrl); the API answers 302 to a signed URL of its own (119_pack_render)',
		in: ['routes/projects/[id]/packs/[packId]/+page.svelte']
	},
	'api.scenarios.packCopyUrl': {
		why: 'an applicant’s printable copy of an issued pack (165_applicant_copy): PUBLIC_API_URL + an encoded path of the project, application and pack ids (lib/api/client.ts scenarios.packCopyUrl); the API answers 302 to a signed URL of its own',
		in: ['routes/projects/[id]/scenarios/[sid]/packs/[packId]/+page.svelte']
	},
	'current.url': { why: 'the report PDF link: serverPdf.ts reportsApi.get sets it from api.reports.pdfUrl (PUBLIC_API_URL + an encoded path), never from the response (serverPdf.test.ts)', in: ['lib/components/report/ServerPdf.svelte', 'routes/projects/[id]/reports/[jobId]/+page.svelte'] },
	'api.farm.exportUrl': { why: 'api client: PUBLIC_API_URL (build config) + an encoded path', in: ['routes/farm/[projectId]/+page.svelte'] },
	'api.scenarios.participationCsvUrl': { why: 'api client: PUBLIC_API_URL (build config) + an encoded path', in: ['routes/projects/[id]/scenarios/[sid]/participation/+page.svelte'] },
	'api.allocations.exportUrl': { why: 'api client: PUBLIC_API_URL (build config) + an encoded path', in: ['lib/components/allocations/AllocationsTab.svelte'] },
	// data: URLs built in code, a synthetic CSV example with a `download` attribute (never user text, never HTML).
	exampleHref: { why: 'EWR editors: `data:text/csv;charset=utf-8,` + encodeURIComponent(synthetic CSV)', in: ['lib/components/settings/EwrHighFlowsEditor.svelte', 'lib/components/settings/EwrRuleTablesEditor.svelte'] },
	csvHref: { why: 'GridPasteDialog: `data:text/csv;charset=utf-8,` + encodeURIComponent(the grid as CSV, names defused by csvCell; empty while closed)', in: ['lib/components/model/GridPasteDialog.svelte'] },
	templateHref: { why: 'AllocationImport: `data:text/csv;charset=utf-8,` + encodeURIComponent(the template CSV)', in: ['lib/components/allocations/AllocationImport.svelte'] }
};

/** TypeScript that points the page, or an element, at a URL. Only a blob download link is allowed. */
const TS_URL_SINKS =
	/\.(href|src|action|formAction|srcdoc)\s*=(?!=)|\.setAttribute\(\s*['"`](href|src|action|formaction|srcdoc|xlink:href)['"`]|\blocation\s*=(?!=)|\blocation\.(assign|replace)\s*\(|\bwindow\.open\s*\(|['"`]\s*(javascript|vbscript)\s*:/gi;
const TS_URL_SINKS_ALLOWED: Record<string, string> = {
	'lib/export/download.ts': 'saveBlob: a.href = URL.createObjectURL(blob), a blob: URL for a download',
	'lib/auth/wafCaptcha.ts': 'loadCaptchaSdk: script.src = the build-time CAPTCHA SDK URL, refused unless it matches CAPTCHA_SCRIPT (https, *.captcha-sdk.awswaf.com/<id>/jsapi.js), the one origin the CSP allows'
};

function sourceFiles(dir: string, ext: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name), ext);
		if (e.name.endsWith('.test.ts')) return [];
		return ext.test(e.name) ? [join(dir, e.name)] : [];
	});
}

// ---------------------------------------------------------------------------
// A small Svelte markup scanner: tags and their attributes, braces balanced.
// ---------------------------------------------------------------------------

interface Attr {
	/** Lower-cased name; `{name}` shorthand gives its name, a spread gives "...". */
	name: string;
	/** The raw value: `{expr}`, `"text {expr}"`, bare text; null for a bare attribute. */
	value: string | null;
	/** True for `{name}` shorthand. */
	shorthand?: boolean;
}
interface Tag {
	name: string;
	attrs: Attr[];
	text: string;
}

/** The markup of a component: script, style and comments removed. */
function markup(svelte: string): string {
	return svelte
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

/** Index just past the `}` matching the `{` at `i`. */
function skipBraces(s: string, i: number): number {
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}' && --depth === 0) return i + 1;
	}
	return s.length;
}

function tags(html: string): Tag[] {
	const out: Tag[] = [];
	let i = 0;
	while (i < html.length) {
		const ch = html[i]!;
		if (ch === '{') {
			i = skipBraces(html, i);
			continue;
		}
		if (ch !== '<' || !/[A-Za-z]/.test(html[i + 1] ?? '')) {
			i++;
			continue;
		}
		const start = i;
		const name = /^<([A-Za-z][\w:.-]*)/.exec(html.slice(i))![1]!;
		i += name.length + 1;
		const attrs: Attr[] = [];
		while (i < html.length && html[i] !== '>') {
			const c = html[i]!;
			if (/\s|\//.test(c)) {
				i++;
				continue;
			}
			if (c === '{') {
				const end = skipBraces(html, i);
				const inner = html.slice(i + 1, end - 1).trim();
				attrs.push(inner.startsWith('...') ? { name: '...', value: inner } : { name: inner.toLowerCase(), value: `{${inner}}`, shorthand: true });
				i = end;
				continue;
			}
			const an = /^[^\s=>/{]+/.exec(html.slice(i))?.[0] ?? html[i]!;
			i += an.length;
			if (html[i] !== '=') {
				attrs.push({ name: an.toLowerCase(), value: null });
				continue;
			}
			i++;
			let v = '';
			if (html[i] === '{') {
				const end = skipBraces(html, i);
				v = html.slice(i, end);
				i = end;
			} else if (html[i] === '"' || html[i] === "'") {
				const q = html[i]!;
				let j = i + 1;
				while (j < html.length && html[j] !== q) j = html[j] === '{' ? skipBraces(html, j) : j + 1;
				v = html.slice(i + 1, j);
				i = j + 1;
			} else {
				const m = /^[^\s>]+/.exec(html.slice(i))?.[0] ?? '';
				v = m;
				i += m.length;
			}
			attrs.push({ name: an.toLowerCase(), value: v });
		}
		out.push({ name: name.toLowerCase(), attrs, text: html.slice(start, i + 1) });
		i++;
	}
	return out;
}

/** Split an attribute value into literal text and `{expr}` parts. */
function parts(value: string): { lit?: string; expr?: string }[] {
	const out: { lit?: string; expr?: string }[] = [];
	let i = 0;
	while (i < value.length) {
		if (value[i] === '{') {
			const end = skipBraces(value, i);
			out.push({ expr: value.slice(i + 1, end - 1).trim() });
			i = end;
		} else {
			const j = value.indexOf('{', i);
			out.push({ lit: value.slice(i, j < 0 ? value.length : j) });
			i = j < 0 ? value.length : j;
		}
	}
	return out;
}

/** `runHref(meta.id)` → `runHref`, `api.farm.exportUrl(p)` → `api.farm.exportUrl`, `data!` → `data`. */
const headName = (expr: string) => /^[\w$.]+/.exec(expr.replace(/^\(|!$/g, ''))?.[0] ?? expr;

type Verdict = { ok: true } | { ok: false; why: string } | { dynamic: string };

/** How a URL attribute's value decides its scheme. */
function classify(value: string): Verdict {
	let ps = parts(value);
	// `{base}` is the app's base path ("" or "/x", from svelte.config.js): what follows it is the head.
	if (ps[0]?.expr === 'base') ps = ps.slice(1);
	const first = ps[0];
	if (!first) return { ok: true };
	if (first.expr !== undefined) return { dynamic: headName(first.expr) };
	// What the browser reads: it drops ASCII whitespace and control characters, so "java\tscript:" is javascript:.
	const lit = first.lit!.replace(/[\u0000- ]/g, '');
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(lit)?.[1]?.toLowerCase();
	if (scheme && !SAFE_SCHEMES.has(scheme)) return { ok: false, why: `${scheme}: URL` };
	if (/^[/\\]{2}/.test(lit)) return { ok: false, why: 'protocol-relative URL (another host)' };
	// "/{x}": x decides whether it is "//host", so it is the head.
	if (/^[/\\]$/.test(lit) && ps[1]?.expr !== undefined) return { dynamic: headName(ps[1].expr) };
	return { ok: true };
}

interface Found {
	file: string;
	tag: Tag;
	attr: Attr;
}

function scan(): { files: string[]; found: Found[] } {
	const files = sourceFiles(SRC, /\.svelte$/);
	const found = files.flatMap((f) =>
		tags(markup(readFileSync(f, 'utf8'))).flatMap((tag) => tag.attrs.map((attr) => ({ file: f.slice(SRC.length), tag, attr })))
	);
	return { files, found };
}

// `data` is a URL only on <object>, which is banned outright below; elsewhere it is a component prop.
const isUrlAttr = (t: Tag, a: Attr) => URL_ATTRS.has(a.name) && (a.name !== 'data' || t.name === 'object');

describe('URL attributes', () => {
	it('the scanner reads tags, attributes and shorthand, and classifies literal, base-relative and dynamic values', () => {
		const t = tags(markup('<script>const a = "<a href=javascript:x>";</script><a class="x" href="{base}/p/{id}?q={f({ a: 1 })}" {href} {...rest}>x</a>{#if a<b}<img src={s} alt="">{/if}'));
		expect(t.map((x) => x.name)).toEqual(['a', 'img']);
		expect(t[0]!.attrs.map((a) => [a.name, a.value])).toEqual([
			['class', 'x'],
			['href', '{base}/p/{id}?q={f({ a: 1 })}'],
			['href', '{href}'],
			['...', '...rest']
		]);
		expect(classify('{base}/p/{id}')).toEqual({ ok: true });
		expect(classify('?tab=runs&run={id}')).toEqual({ ok: true });
		expect(classify('#{b.id}')).toEqual({ ok: true });
		expect(classify('https://example.org/x')).toEqual({ ok: true });
		expect(classify('mailto:{email}')).toEqual({ ok: true });
		expect(classify('{runHref(meta.id)}')).toEqual({ dynamic: 'runHref' });
		expect(classify('{api.farm.exportUrl(p, n)}')).toEqual({ dynamic: 'api.farm.exportUrl' });
		expect(classify('{base}{pictureSrc(shot)}')).toEqual({ dynamic: 'pictureSrc' });
		expect(classify('{base}/{x}')).toEqual({ dynamic: 'x' });
		expect(classify('/{x}')).toEqual({ dynamic: 'x' });
		// The script URLs, however they are spelled.
		for (const bad of ['javascript:alert(1)', 'JavaScript:{x}', ' java\tscript:x', 'vbscript:x', 'data:text/html,<b>', '//evil.example', '/\\evil.example', '{base}//evil.example']) {
			expect(classify(bad), bad).toMatchObject({ ok: false });
		}
	});

	it('every URL attribute in every component has a literal safe scheme or a reviewed expression', () => {
		const { files, found } = scan();
		// Positive control: the walk reaches the components and sees their links.
		expect(files.length).toBeGreaterThan(100);
		const urls = found.filter((x) => isUrlAttr(x.tag, x.attr) && x.attr.value !== null);
		expect(urls.length).toBeGreaterThan(150);
		expect(urls.some((x) => x.file.endsWith('report/ServerPdf.svelte') && x.attr.value === '{current.url}')).toBe(true);
		const used = new Set<string>();
		const offenders = urls.flatMap(({ file, attr }) => {
			const v = classify(attr.value!);
			if ('dynamic' in v) {
				used.add(`${file}: ${v.dynamic}`);
				return REVIEWED[v.dynamic]?.in.includes(file)
					? []
					: [`${file}: ${attr.name}=${attr.value} (unreviewed expression "${v.dynamic}" here: add this file to its REVIEWED entry, with where its value comes from)`];
			}
			return v.ok ? [] : [`${file}: ${attr.name}="${attr.value}" (${v.why})`];
		});
		expect(offenders).toEqual([]);
		// No stale entries: every reviewed name is still used in every component it lists.
		const listed = Object.entries(REVIEWED).flatMap(([head, r]) => r.in.map((f) => `${f}: ${head}`));
		expect(listed.length).toBeGreaterThan(Object.keys(REVIEWED).length);
		expect(listed.filter((k) => !used.has(k))).toEqual([]);
	});

	it('no srcdoc, and no frame, object or embed element', () => {
		const all = sourceFiles(SRC, /\.svelte$/).flatMap((f) => tags(markup(readFileSync(f, 'utf8'))).map((tag) => ({ file: f.slice(SRC.length), tag })));
		// Positive control: the walk sees plain elements.
		expect(all.some(({ tag }) => tag.name === 'a')).toBe(true);
		const offenders = all.flatMap(({ file, tag }) => [
			...(tag.attrs.some((a) => a.name === 'srcdoc') ? [`${file}: srcdoc on <${tag.name}>`] : []),
			...(/^(iframe|frame|frameset|object|embed|portal)$/.test(tag.name) ? [`${file}: <${tag.name}>`] : [])
		]);
		expect(offenders).toEqual([]);
		// The check itself.
		expect(tags('<iframe srcdoc="<b>x</b>"></iframe>').map((t) => [t.name, t.attrs[0]?.name])).toEqual([['iframe', 'srcdoc']]);
	});

	it('every link that opens a new tab carries rel="noopener" (or noreferrer)', () => {
		const { found } = scan();
		const blanks = found.filter(({ tag, attr }) => /^(a|area|form)$/.test(tag.name) && attr.name === 'target' && attr.value !== '_self');
		// Positive control: the one external link (the SABI manual) is seen.
		expect(blanks.some((b) => b.file.endsWith('crops/LoadCropFactorsDialog.svelte'))).toBe(true);
		const offenders = blanks
			.filter(({ tag }) => {
				const rel = tag.attrs.find((a) => a.name === 'rel')?.value ?? '';
				return !/\bno(opener|referrer)\b/.test(rel);
			})
			.map(({ file, tag }) => `${file}: ${tag.text}`);
		expect(offenders).toEqual([]);
		// The check itself: a bare target=_blank fails it, rel="noopener" passes.
		const [bad, good] = tags('<a href="https://x.example" target="_blank">x</a><a href="https://x.example" target="_blank" rel="noopener">x</a>');
		expect(bad!.attrs.some((a) => a.name === 'rel')).toBe(false);
		expect(good!.attrs.find((a) => a.name === 'rel')?.value).toBe('noopener');
	});

	it('no TypeScript points the page or an element at a URL, except the blob download link', () => {
		expect('a.href = x'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('el.setAttribute("src", x)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('window.location = next'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('location.assign(next)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('window.open(u)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect(`const u = 'javascript:void 0'`.match(TS_URL_SINKS)).toHaveLength(1);
		expect('if (a.href === b) {}'.match(TS_URL_SINKS)).toBeNull();
		expect('const href = runHref(id)'.match(TS_URL_SINKS)).toBeNull();
		// A component's markup holds code too: a Svelte 5 inline handler
		// (onclick={() => (location.href = next)}) sits outside <script>, so the
		// whole file is read, as rawHtml.test.ts reads it.
		expect('<button onclick={() => (location.href = next)}>go</button>'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('<a href={runHref(id)} onclick={() => window.open(u)}>x</a>'.match(TS_URL_SINKS)).toHaveLength(1);
		const files = sourceFiles(SRC, /\.(svelte|ts|js)$/);
		const hits = files.flatMap((f) => {
			const rel = f.slice(SRC.length);
			return (readFileSync(f, 'utf8').match(TS_URL_SINKS) ?? []).map((m) => ({ rel, m }));
		});
		// Positive control: the download helper's blob link is found (and allowed).
		expect(hits.some((h) => h.rel === 'lib/export/download.ts')).toBe(true);
		expect(hits.filter((h) => !(h.rel in TS_URL_SINKS_ALLOWED)).map((h) => `${h.rel}: ${h.m}`)).toEqual([]);
	});

	it('the URL builders keep a hostile id on the app’s own origin', () => {
		const origin = 'https://app.example';
		const page = new URL(`${origin}/projects/p1?tab=network&view=map#top`);
		const lands = (href: string) => new URL(href, page).origin;
		const hostile = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example', '/\\evil.example', '\t//evil.example', 'https://evil.example/', '"><img src=x onerror=alert(1)>'];
		for (const id of hostile) {
			const hrefs = [
				withParam(page, 'dam', id),
				withoutParam(page, id),
				runHref(id),
				riverHref(id, 'res-flow'),
				mapNodeHref(id),
				supplyHref(id, { unit: id, window: id }),
				farmHref('', id, id, true, 'dam'),
				farmHref('/app', id, id, true),
				farmDrawerHref(null, id),
				compareTabHref({ projectId: id, runId: id }, { projectId: id, runId: id }),
				curtailmentHref({ id, sourceRunId: id }),
				fieldHistoryHref({ filter: id }, id),
				noteHref({ target: 'node', nodeId: id, runId: null, settingKey: null }) ?? '',
				noteHref({ target: 'run', nodeId: null, runId: id, settingKey: null }) ?? ''
			];
			for (const h of hrefs) expect(lands(h), `${JSON.stringify(id)} → ${h}`).toBe(origin);
		}
		// Positive control: the check tells an off-site link from an app one.
		expect(lands('//evil.example/x')).not.toBe(origin);
		expect(lands('?tab=runs')).toBe(origin);
	});
});

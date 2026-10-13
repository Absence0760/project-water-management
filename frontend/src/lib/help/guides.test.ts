import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EWR_TRAFFIC_LIGHT } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { HELP, helpFor } from './content';
import { SHOTS } from './pictures';
import { TOUR } from './tour';
import { SETTINGS_SECTIONS } from '$lib/components/settings/sections';
import { ALL_TABS, TAB_GUIDE } from '$lib/workspace/tabs';
import {
	DIAGRAM_IDS,
	GUIDE_KIND_TITLES,
	GUIDES,
	TAB_TITLES,
	guideFor,
	inline,
	inSentence,
	plainText,
	searchGuides,
	sectionId,
	type GuideBlock,
	type PictureStop
} from './guides';

const texts = (b: GuideBlock): string[] => {
	switch (b.type) {
		case 'steps':
		case 'list':
			return b.items;
		case 'diagram':
			return [b.caption];
		case 'picture':
			return [b.caption, ...b.stops.map((st) => st.text)];
		default:
			return [b.text];
	}
};
const allText = GUIDES.flatMap((g) => [g.summary, ...g.sections.flatMap((s) => s.blocks.flatMap(texts))]);

/** Everything shown through RichText (inline()): guide text, captions and every picture stop, the /help tour's too. Formulas are shown as written. */
const stopTexts = (st: PictureStop): string[] => [st.text, ...(st.more?.points ?? [])];
const renderedText = [
	...GUIDES.flatMap((g) =>
		g.sections.flatMap((s) =>
			s.blocks.flatMap((b) => {
				if (b.type === 'formula') return [];
				if (b.type === 'picture') return [b.caption, ...b.stops.flatMap(stopTexts)];
				return texts(b);
			})
		)
	),
	...TOUR.flatMap(stopTexts)
];

describe('guides', () => {
	it('have unique, url-safe ids and known kinds and tabs', () => {
		const ids = GUIDES.map((g) => g.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const g of GUIDES) {
			expect(g.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(Object.keys(GUIDE_KIND_TITLES), g.id).toContain(g.kind);
			if (g.tab) expect(Object.keys(TAB_TITLES), g.id).toContain(g.tab);
			expect(g.title.trim().length, g.id).toBeGreaterThan(0);
			expect(g.summary.length, `${g.id} summary`).toBeLessThanOrEqual(160);
			expect(g.sections.length, g.id).toBeGreaterThan(0);
		}
	});

	it('give every workspace page a guide its header can link to, about that page', () => {
		for (const tab of ALL_TABS) {
			const g = guideFor(TAB_GUIDE[tab]);
			expect(g, `${tab} → ${TAB_GUIDE[tab]}`).toBeDefined();
			expect(g!.tab, `${tab} → ${g!.id}`).toBe(tab);
		}
		// Every page guide is some page's header link, so none is orphaned.
		const linked = new Set(Object.values(TAB_GUIDE));
		for (const g of GUIDES.filter((x) => x.kind === 'page')) expect(linked.has(g.id), g.id).toBe(true);
	});

	it('start with exactly one “start here” guide', () => {
		expect(GUIDES[0]!.kind).toBe('start');
		expect(GUIDES.filter((g) => g.kind === 'start')).toHaveLength(1);
	});

	it('give every section a unique anchor within its guide', () => {
		for (const g of GUIDES) {
			const anchors = g.sections.map((s) => sectionId(s.heading));
			expect(new Set(anchors).size, g.id).toBe(anchors.length);
			for (const a of anchors) expect(a, g.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			// Must not collide with the page's own section ids.
			for (const a of anchors) expect(['terms-h', 'related-h'], g.id).not.toContain(a);
		}
	});

	it('leave the glossary’s long text no broken link (the glossary renders it as guide markup)', () => {
		const broken = HELP.flatMap((e) => inline(e.long).filter((p) => p.kind === 'broken').map((p) => `${e.id}: ${p.text}`));
		expect(broken).toEqual([]);
		// The markup is rendered, not shown: **bold** in an article reads as bold.
		expect(inline('a **b** c').map((p) => p.kind)).toEqual(['text', 'strong', 'text']);
	});

	it('only link to glossary entries and guides that exist', () => {
		const broken = allText.flatMap((t) => inline(t).filter((p) => p.kind === 'broken'));
		expect(broken).toEqual([]);
		for (const g of GUIDES) {
			for (const id of g.terms ?? []) expect(helpFor(id), `${g.id} term ${id}`).toBeDefined();
			for (const id of g.related ?? []) {
				expect(guideFor(id), `${g.id} related ${id}`).toBeDefined();
				expect(id, g.id).not.toBe(g.id);
			}
		}
	});

	it('give the EWR traffic light’s cut-offs as the engine has them', () => {
		expect(allText.join('\n')).toContain(`**green** means the EWR was not met on fewer than ${EWR_TRAFFIC_LIGHT.green} % of the days, **amber** fewer than ${EWR_TRAFFIC_LIGHT.amber} %, and **red** ${EWR_TRAFFIC_LIGHT.amber} % or more`);
	});

	it('leave no markup unparsed (stray ** or [[ )', () => {
		for (const t of allText) {
			const plain = plainText(t);
			expect(plain, t).not.toMatch(/\*\*|\[\[|\]\]/);
		}
	});

	it('leave no asterisk in any rendered text or caption (bold and italic markup both parse)', () => {
		expect(renderedText.length).toBeGreaterThan(allText.length / 2);
		for (const t of renderedText) {
			const shown = inline(t)
				.map((p) => p.text)
				.join('');
			expect(shown, t).not.toContain('*');
		}
	});

	it('put every picture stop on a marker its shot has', () => {
		for (const g of GUIDES) {
			for (const b of g.sections.flatMap((sec) => sec.blocks)) {
				if (b.type !== 'picture') continue;
				const spots = b.stops.map((st) => st.spot);
				expect(new Set(spots).size, g.id).toBe(spots.length);
				for (const spot of spots) expect(SHOTS[b.shot].spots[spot], `${g.id}: ${b.shot}.${spot}`).toBeDefined();
			}
		}
	});

	it('use every diagram, and each diagram has a component with a text alternative', () => {
		const used = GUIDES.flatMap((g) => g.sections.flatMap((s) => s.blocks.filter((b) => b.type === 'diagram').map((b) => b.id)));
		expect([...new Set(used)].sort()).toEqual([...DIAGRAM_IDS].sort());

		const dir = fileURLToPath(new URL('../components/help/diagrams', import.meta.url));
		const files = readdirSync(dir).filter((f) => f.endsWith('.svelte'));
		expect(files).toHaveLength(DIAGRAM_IDS.length);
		const registry = readFileSync(fileURLToPath(new URL('../components/help/Diagram.svelte', import.meta.url)), 'utf8');
		for (const f of files) {
			const src = readFileSync(`${dir}/${f}`, 'utf8');
			expect(src, f).toMatch(/<svg[^>]*\brole="img"/);
			expect(src.match(/aria-label="([^"]+)"/)?.[1]?.length ?? 0, f).toBeGreaterThan(80);
			// Themed through Diagram.svelte's shared classes only: no colours of its own.
			expect(src, f).not.toMatch(/<style|#[0-9a-f]{3,6}\b|rgb\(/i);
			expect(registry, f).toContain(`./diagrams/${f}`);
		}
		// Marker ids are document-global: two diagrams on one page must not share one.
		const markers = files.flatMap((f) => [...readFileSync(`${dir}/${f}`, 'utf8').matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]));
		expect(new Set(markers).size).toBe(markers.length);
	});
});

// ---------------------------------------------------------------------------
// "Settings → X → Y" paths. Help and the app's own words name where a setting
// is; when a panel is renamed or moved (Flow generation became Flow
// calibration → Rain into GR4J) the old path kept being printed. Every path
// that starts at Settings, or at a Settings panel's name, must name a real
// panel (components/settings/sections.ts) and, after it, headings that panel
// really shows (its slice of the page and the components rendered in it).
// ---------------------------------------------------------------------------

const dirOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url)).replace(/\/$/, '');
const COMPONENTS = dirOf('../components');
const SRC = dirOf('..');
const ROUTES = dirOf('../../routes');

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = `${dir}/${e.name}`;
		if (e.isDirectory()) walk(p, out);
		else if (/\.(svelte|ts)$/.test(e.name) && !/\.test\.ts$|\.d\.ts$/.test(e.name)) out.push(p);
	}
	return out;
}
const svelteByName = new Map<string, string[]>();
for (const f of walk(COMPONENTS).filter((f) => f.endsWith('.svelte'))) {
	const n = f.slice(f.lastIndexOf('/') + 1, -'.svelte'.length);
	svelteByName.set(n, [...(svelteByName.get(n) ?? []), f]);
}

/** Visible headings, legends, panel titles, button and label words in a Svelte source. */
function headingsIn(src: string): string[] {
	const out: string[] = [];
	const clean = (s: string) => s.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
	for (const m of src.matchAll(/<(h[2-5]|legend|summary|button|label)\b[^>]*>([^<{]+)/g)) out.push(clean(m[2]!));
	for (const m of src.matchAll(/\b(legend|title|name|label)="([^"{]+)"/g)) out.push(clean(m[2]!));
	// Words a tag shows through an expression ({mapOnly ? 'Rain from the map' : 'Attach a feed'}).
	for (const m of src.matchAll(/'([A-Z][^'\n]{2,60})'/g)) out.push(clean(m[1]!));
	// Words a tag shows through an expression ({mapOnly ? 'Rain from the map' : 'Attach a feed'}).
	for (const m of src.matchAll(/'([A-Z][^'\n]{2,60})'/g)) out.push(clean(m[1]!));
	return out.filter((s) => s.length > 1);
}

/** The headings a Settings panel shows: its slice of the file that holds its id, and every component used in it, recursively. */
function panelHeadings(id: string): string[] {
	const host = walk(COMPONENTS).filter((f) => f.endsWith('.svelte')).find((f) => readFileSync(f, 'utf8').includes(`id="${id}"`));
	if (!host) throw new Error(`no component holds id="${id}"`);
	const src = readFileSync(host, 'utf8');
	const from = src.indexOf(`id="${id}"`);
	const next = src.slice(from + 1).search(/id="set-/);
	const slice = next < 0 ? src.slice(from) : src.slice(from, from + 1 + next);
	const seen = new Set<string>();
	const heads = headingsIn(slice);
	const visit = (code: string) => {
		for (const m of code.matchAll(/<(?:[A-Za-z]+\.)?([A-Z][A-Za-z0-9]+)\b/g)) {
			for (const f of svelteByName.get(m[1]!) ?? []) {
				if (seen.has(f)) continue;
				seen.add(f);
				const s = readFileSync(f, 'utf8');
				heads.push(...headingsIn(s));
				visit(s);
			}
		}
	};
	visit(slice);
	return heads;
}

// Every panel the page has, by its heading: the menu's, plus the ones above and after it.
const PANELS = new Map<string, string>([
	...SETTINGS_SECTIONS.map((s) => [s.label, s.id] as [string, string]),
	['Judge results by', 'set-judge'],
	['API keys', 'set-api-keys'],
	['Scheduled reports', 'set-report-schedules']
]);
const panelCache = new Map<string, string[]>();
const headingsOf = (id: string) => panelCache.get(id) ?? (panelCache.set(id, panelHeadings(id)), panelCache.get(id)!);

/** Each "Settings → A → B" (or "A → B" where A is a panel) in a text, as its steps, markup removed. */
function settingsPaths(text: string): string[][] {
	const plain = text
		.replace(/<\/?[A-Za-z][^<>]*>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
		.replace(/\*\*?/g, '')
		.replace(/\s+/g, ' ');
	const labels = [...PANELS.keys()].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	const starts = [
		...[...plain.matchAll(/\bSettings(?: & calibration)? → /g)].map((m) => m.index + m[0].length),
		// A panel's own name starting a path, unless a "→" before it already did.
		...[...plain.matchAll(new RegExp(`(?<![\\w-])(?:${labels}) → `, 'g'))].filter((m) => !/→ $/.test(plain.slice(0, m.index))).map((m) => m.index)
	];
	return starts.map((at) => {
		let rest = plain.slice(at);
		const steps: string[] = [];
		for (;;) {
			const arrow = rest.indexOf(' → ');
			const stop = rest.search(/[.,;:()’'"?!]|$/);
			if (arrow >= 0 && arrow < stop) {
				steps.push(rest.slice(0, arrow).trim());
				rest = rest.slice(arrow + 3);
			} else {
				steps.push(rest.slice(0, stop).trim());
				return steps;
			}
		}
	});
}

/** Why a path doesn't resolve, or null. The last step may run on into the sentence, so it only has to start with a name. */
function pathProblem(steps: string[]): string | null {
	const names = (i: number) => (i === steps.length - 1 ? (n: string) => steps[i] === n || steps[i]!.startsWith(`${n} `) : (n: string) => steps[i] === n);
	const panel = [...PANELS.keys()].sort((a, b) => b.length - a.length).find(names(0));
	if (!panel) return `“${steps[0]}” is no Settings panel`;
	const heads = headingsOf(PANELS.get(panel)!);
	for (let i = 1; i < steps.length; i++) {
		const own = steps[i]!;
		// A step written in lower case continues the sentence ("Settings → the daily EWR at the outlet"): not a name.
		if (i === steps.length - 1 && /^[a-z]/.test(own)) break;
		if (!heads.some(names(i))) return `“${own}” isn’t shown under ${panel}`;
	}
	return null;
}

describe('Settings paths named in help and in the app', () => {
	const helpTexts: [string, string][] = [
		...HELP.flatMap((e) => [[`glossary ${e.id}`, e.short], [`glossary ${e.id}`, e.long]] as [string, string][]),
		...GUIDES.flatMap((g) => [g.summary, ...g.sections.flatMap((s) => s.blocks.flatMap(texts))].map((t) => [`guide ${g.id}`, t] as [string, string])),
		...TOUR.flatMap((st) => stopTexts(st).map((t) => [`tour ${st.spot}`, t] as [string, string]))
	];
	// The app's own words: source with its comments taken out (a comment may describe an old layout).
	const appTexts: [string, string][] = [...walk(SRC), ...walk(ROUTES)]
		.filter((f) => !f.includes('/lib/help/'))
		.map((f) => [
			f.slice(SRC.length),
			readFileSync(f, 'utf8')
				.replace(/<!--[\s\S]*?-->/g, '')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1')
		]);

	it('finds the paths it checks', () => {
		expect(settingsPaths('Open **Settings & calibration → Flow calibration → Rain into GR4J**, then save.')).toEqual([['Flow calibration', 'Rain into GR4J']]);
		expect(settingsPaths('switched on in **Fit the parameters → Fit automatically**, makes')).toEqual([['Fit the parameters', 'Fit automatically']]);
		expect(settingsPaths('Settings → Calibration record → Flow gaps can fill them')).toEqual([['Calibration record', 'Flow gaps can fill them']]);
		expect(pathProblem(['Flow generation', 'Rain for each unit'])).toMatch(/no Settings panel/);
		expect(pathProblem(['Flow calibration', 'Rain into GR4J', 'Rain for each unit is on'])).toBeNull();
		expect(pathProblem(['Rain gaps', 'Nowhere in particular'])).toMatch(/isn’t shown under Rain gaps/);
	});

	it('name a real panel, and headings that panel shows', () => {
		const broken = [...helpTexts, ...appTexts].flatMap(([where, text]) =>
			settingsPaths(text).flatMap((steps) => {
				const p = pathProblem(steps);
				return p ? [`${where}: Settings → ${steps.join(' → ')} (${p})`] : [];
			})
		);
		expect(broken).toEqual([]);
	});
});

describe('inline', () => {
	it('splits bold labels, glossary links and guide links', () => {
		expect(inline('Press **Save**, see [[ewr]] or [[nse|the NSE]] and [[guide:add-data|uploads]].')).toEqual([
			{ kind: 'text', text: 'Press ' },
			{ kind: 'strong', text: 'Save' },
			{ kind: 'text', text: ', see ' },
			{ kind: 'term', id: 'ewr', text: 'EWR (Environmental Water Requirement)' },
			{ kind: 'text', text: ' or ' },
			{ kind: 'term', id: 'nse', text: 'the NSE' },
			{ kind: 'text', text: ' and ' },
			{ kind: 'guide', id: 'add-data', text: 'uploads' },
			{ kind: 'text', text: '.' }
		]);
	});

	it('reads *italics* only where the asterisks stand apart from a word', () => {
		expect(inline('Open *Review*, then *Build the model*.')).toEqual([
			{ kind: 'text', text: 'Open ' },
			{ kind: 'em', text: 'Review' },
			{ kind: 'text', text: ', then ' },
			{ kind: 'em', text: 'Build the model' },
			{ kind: 'text', text: '.' }
		]);
		expect(inline('5*3 and 2*4')).toEqual([{ kind: 'text', text: '5*3 and 2*4' }]);
	});

	it('resolves a field key to its glossary entry, and marks unknown references', () => {
		expect(inline('[[node.damCapacityM3]]')).toEqual([{ kind: 'term', id: 'dam-capacity', text: 'dam capacity' }]);
		expect(inline('[[nope]] [[guide:nope|x]]').filter((p) => p.kind === 'broken')).toHaveLength(2);
	});

	it('lowercases an ordinary term mid-sentence but keeps acronyms and names', () => {
		expect(inSentence('Runoff model')).toBe('runoff model');
		expect(inSentence('Transfer')).toBe('transfer');
		expect(inSentence('Days in February')).toBe('days in February');
		expect(inSentence('EWR (Environmental Water Requirement)')).toBe('EWR (Environmental Water Requirement)');
		expect(inSentence('CHIRPS rainfall')).toBe('CHIRPS rainfall');
		expect(inSentence('GR4J')).toBe('GR4J');
		expect(inSentence('A-pan evaporation')).toBe('A-pan evaporation');
		expect(inSentence('NSE (Nash–Sutcliffe efficiency)')).toBe('NSE (Nash–Sutcliffe efficiency)');
	});

	it('splits italics from bold, and leaves a lone or spaced asterisk as text', () => {
		expect(inline('under *Review*, then **Save**')).toEqual([
			{ kind: 'text', text: 'under ' },
			{ kind: 'em', text: 'Review' },
			{ kind: 'text', text: ', then ' },
			{ kind: 'strong', text: 'Save' }
		]);
		expect(inline('*Build the model* first')).toEqual([
			{ kind: 'em', text: 'Build the model' },
			{ kind: 'text', text: ' first' }
		]);
		expect(inline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
	});

	it('leaves plain text alone', () => {
		expect(inline('no markup, 1 × 2')).toEqual([{ kind: 'text', text: 'no markup, 1 × 2' }]);
	});
});

describe('searchGuides', () => {
	it('returns nothing for an empty query', () => {
		expect(searchGuides('  ')).toEqual([]);
	});

	it('ranks title matches first and needs every word', () => {
		expect(searchGuides('calibration')[0]!.id).toBe('how-calibration-works');
		expect(searchGuides('transfer')[0]!.id).toBe('add-a-transfer');
		expect(searchGuides('chirps factor').map((g) => g.id)).toContain('rain-gap-filling');
		expect(searchGuides('zzzz')).toEqual([]);
	});

	it('searches the text without its markup, ignoring case and accents', () => {
		// “Save changes” is written **Save changes** in the network guide.
		expect(searchGuides('save changes').map((g) => g.id)).toContain('build-the-network');
		expect(searchGuides('KLEMEŠ').map((g) => g.id)).toContain('how-calibration-works');
	});
});

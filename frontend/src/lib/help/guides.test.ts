import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { helpFor } from './content';
import { SHOTS } from './pictures';
import { TOUR } from './tour';
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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP } from './content';
import { NAV_SECTIONS, TAB_LABELS } from '$lib/workspace/tabs';
import { DIAGRAM_IDS, GUIDES, OPTIONAL_MODEL_TABS, SETUP_STEPS, SETUP_TABS, TAB_TITLES, guideFor, inline, plainText } from './guides';
import { SHOTS, SHOT_ALT, TIP_PICTURES, pictureSrc, pictureSrcset, type Light, type ShotId } from './pictures';
import { TOUR } from './tour';

const shots = Object.keys(SHOTS) as ShotId[];
const staticFile = (src: string) => fileURLToPath(new URL(`../../../static${src}`, import.meta.url));

/** A WebP's pixel size, from its first chunk (VP8X, lossy VP8 or lossless VP8L). */
function webpSize(file: string): { width: number; height: number } {
	const b = readFileSync(file);
	expect(b.toString('ascii', 0, 4) + b.toString('ascii', 8, 12), file).toBe('RIFFWEBP');
	const chunk = b.toString('ascii', 12, 16);
	if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
	if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	if (chunk === 'VP8L') {
		const bits = b.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	throw new Error(`${file}: unknown WebP chunk ${chunk}`);
}
const noBroken = (text: string) => inline(text).filter((p) => p.kind === 'broken');

describe('help pictures', () => {
	it('ship both widths of every shot, and describe each one', () => {
		for (const shot of shots) {
			const { width, height, spots } = SHOTS[shot];
			expect(width, shot).toBeGreaterThan(height);
			for (const w of [width, width / 2]) {
				const file = fileURLToPath(new URL(`../../../static${pictureSrc(shot, w)}`, import.meta.url));
				expect(existsSync(file), file).toBe(true);
			}
			expect(SHOT_ALT[shot].length, shot).toBeGreaterThan(60);
			for (const [key, p] of Object.entries(spots)) {
				expect(p.x, `${shot}.${key}`).toBeGreaterThan(0);
				expect(p.x, `${shot}.${key}`).toBeLessThan(100);
				expect(p.y, `${shot}.${key}`).toBeGreaterThan(0);
				expect(p.y, `${shot}.${key}`).toBeLessThan(100);
			}
		}
	});

	it('ship every shot at dusk too, at the same sizes as by day, for dark mode (issue #521)', () => {
		for (const shot of shots) {
			const { width } = SHOTS[shot];
			for (const w of [width, width / 2]) {
				const day = staticFile(pictureSrc(shot, w));
				const dusk = staticFile(pictureSrc(shot, w, 'dusk'));
				expect(dusk, shot).toContain(`/help/${shot}-dusk-${w}.webp`);
				expect(existsSync(dusk), dusk).toBe(true);
				// One camera, so the same markers fit both: the two must be the same size.
				expect(webpSize(day).width, day).toBe(w);
				expect(webpSize(dusk), dusk).toEqual(webpSize(day));
				// Under check:bundle's 100 KB per-asset ceiling (scripts/guards/check_web_bundle_budget.mjs).
				expect(statSync(dusk).size, dusk).toBeLessThan(100 * 1024);
			}
		}
	});

	it('build a srcset for each lighting from the same widths', () => {
		const light = (l: Light) => pictureSrcset('farm', '/base', l);
		expect(light('day')).toBe('/base/help/farm-600.webp 600w, /base/help/farm-1200.webp 1200w');
		expect(light('dusk')).toBe('/base/help/farm-dusk-600.webp 600w, /base/help/farm-dusk-1200.webp 1200w');
	});

	it('give help-tip pictures only to glossary entries that exist, ringing a feature their shot has', () => {
		const ids = new Set(HELP.map((e) => e.id));
		for (const [id, { shot, spot }] of Object.entries(TIP_PICTURES)) {
			expect(ids.has(id), id).toBe(true);
			expect(shots, id).toContain(shot);
			if (spot) expect(Object.keys(SHOTS[shot].spots), id).toContain(spot);
		}
	});

	it("don't repeat one picture across tips: each shows its own feature, and no shot serves many", () => {
		const pairs = Object.entries(TIP_PICTURES).map(([id, { shot, spot }]) => ({ id, key: `${shot}#${spot ?? ''}`, shot }));
		const byKey = Map.groupBy(pairs, (p) => p.key);
		for (const [key, list] of byKey) expect(list.map((p) => p.id), key).toHaveLength(1);
		const byShot = Map.groupBy(pairs, (p) => p.shot);
		for (const [shot, list] of byShot) expect(list.length, shot).toBeLessThanOrEqual(8);
	});
});

describe('catchment tour', () => {
	it('has one stop per marker on the catchment picture, each once', () => {
		const spots = TOUR.map((s) => s.spot);
		expect(new Set(spots).size).toBe(spots.length);
		expect([...spots].sort()).toEqual(Object.keys(SHOTS.catchment.spots).sort());
	});

	it('only links to guides, glossary entries, close-ups and diagrams that exist', () => {
		for (const s of TOUR) {
			expect(s.guide && guideFor(s.guide), `${s.spot} → ${s.guide}`).toBeTruthy();
			expect(noBroken(s.text), s.spot).toEqual([]);
			expect(s.more, s.spot).toBeDefined();
			for (const p of s.more!.points) expect(noBroken(p), s.spot).toEqual([]);
			if (s.more!.shot) expect(shots, s.spot).toContain(s.more!.shot);
			if (s.more!.diagram) expect(DIAGRAM_IDS, s.spot).toContain(s.more!.diagram);
			expect(s.more!.shot || s.more!.diagram, `${s.spot}: a close-up or a diagram`).toBeTruthy();
		}
	});
});

describe('setup path', () => {
	it('walks the setup tabs once, in setup order, each with a how-to guide', () => {
		expect(SETUP_STEPS.map((s) => s.tab)).toEqual([...SETUP_TABS]);
		for (const id of SETUP_TABS) expect(TAB_TITLES[id], id).toBe(TAB_LABELS[id]);
		for (const s of SETUP_STEPS) {
			const g = guideFor(s.guide);
			expect(g, s.tab).toBeDefined();
			expect(g!.kind, s.tab).toBe('howto');
			expect(g!.tab, s.tab).toBe(s.tab);
		}
		expect(GUIDES.length).toBeGreaterThan(SETUP_STEPS.length);
	});

	it("follows the workspace's Build the model section, whose order the help describes", () => {
		const model = NAV_SECTIONS.find((sec) => sec.id === 'model')!.tabs as readonly string[];
		expect(SETUP_TABS.filter((id) => model.includes(id))).toEqual(model.filter((id) => !OPTIONAL_MODEL_TABS.includes(id)));
		// The optional tabs are real model tabs, not a way to drop one quietly.
		for (const id of OPTIONAL_MODEL_TABS) expect(model).toContain(id);
	});

	it('"Getting around a project" names the sidebar’s sections, and their tabs, in the sidebar’s order', () => {
		const section = guideFor('the-whole-process')!.sections.find((s) => s.heading === 'Getting around a project')!;
		const block = section.blocks.find((b) => b.type === 'p' && b.text.includes('grouped in three sections'));
		expect(block).toBeDefined();
		const text = plainText((block as { text: string }).text);
		let at = 0;
		for (const s of NAV_SECTIONS) {
			const found = text.indexOf(s.label, at);
			expect(found, `${s.label} after position ${at}`).toBeGreaterThanOrEqual(at);
			at = found + s.label.length;
			for (const id of s.tabs) {
				const label = TAB_LABELS[id];
				const f = text.indexOf(label, at);
				expect(f, `${label} under ${s.label}`).toBeGreaterThanOrEqual(at);
				at = f + label.length;
			}
		}
	});
});

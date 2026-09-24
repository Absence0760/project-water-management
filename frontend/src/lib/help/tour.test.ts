import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP } from './content';
import { DIAGRAM_IDS, GUIDES, SETUP_STEPS, TAB_TITLES, guideFor, inline } from './guides';
import { SHOTS, SHOT_ALT, TIP_PICTURES, pictureSrc, type ShotId } from './pictures';
import { TOUR } from './tour';

const shots = Object.keys(SHOTS) as ShotId[];
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

	it('give help-tip pictures only to glossary entries that exist', () => {
		const ids = new Set(HELP.map((e) => e.id));
		for (const [id, shot] of Object.entries(TIP_PICTURES)) {
			expect(ids.has(id), id).toBe(true);
			expect(shots, id).toContain(shot);
		}
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
	it('walks every workspace tab once, in tab order, each with a how-to guide', () => {
		expect(SETUP_STEPS.map((s) => s.tab)).toEqual(Object.keys(TAB_TITLES));
		for (const s of SETUP_STEPS) {
			const g = guideFor(s.guide);
			expect(g, s.tab).toBeDefined();
			expect(g!.kind, s.tab).toBe('howto');
			expect(g!.tab, s.tab).toBe(s.tab);
		}
		expect(GUIDES.length).toBeGreaterThan(SETUP_STEPS.length);
	});
});

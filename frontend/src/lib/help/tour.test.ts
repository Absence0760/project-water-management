import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDES, SETUP_STEPS, TAB_TITLES, guideFor, inline } from './guides';
import { TOUR, TOUR_IMAGE, TOUR_SPOTS } from './tour';

describe('catchment tour', () => {
	it('has one stop per hotspot the render wrote, each once', () => {
		const ids = TOUR.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(Object.keys(TOUR_SPOTS).sort());
	});

	it('places every marker on the picture', () => {
		for (const [id, p] of Object.entries(TOUR_SPOTS)) {
			expect(p.x, id).toBeGreaterThan(0);
			expect(p.x, id).toBeLessThan(100);
			expect(p.y, id).toBeGreaterThan(0);
			expect(p.y, id).toBeLessThan(100);
		}
		expect(TOUR_IMAGE.width).toBeGreaterThan(TOUR_IMAGE.height);
	});

	it('only links to guides and glossary entries that exist', () => {
		for (const s of TOUR) {
			expect(guideFor(s.guide), `${s.id} → ${s.guide}`).toBeDefined();
			expect(inline(s.text).filter((p) => p.kind === 'broken'), s.id).toEqual([]);
		}
	});

	it('ships the picture the page points at', () => {
		for (const w of [800, 1600]) {
			const file = fileURLToPath(new URL(`../../../static/help/catchment-${w}.webp`, import.meta.url));
			expect(existsSync(file), file).toBe(true);
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

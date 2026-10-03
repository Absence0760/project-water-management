import { describe, expect, it } from 'vitest';
import { confluenceChoices, ConfluenceAmbiguity, CONFLUENCE_M, lineDistM, type NearReachLine } from './reach.js';

// The junction behind issue #374's follow-up, rebuilt: a gauge 32 m from a
// 67 km² tributary, 92 m from the 422 km² river above the junction, 102 m from
// the 497 km² river below it (HydroRIVERS 11491129, 11491128, 11491355).
const J: [number, number] = [21.26042, -28.32708];
const m = (dx: number, dy: number): [number, number] => [J[0] + dx / 97900, J[1] + dy / 110950];
const reach = (reachId: number, upstreamKm2: number, line: [number, number][], click: [number, number]): NearReachLine => ({
	dataset: 'HydroRIVERS-v10',
	reachId,
	upstreamKm2,
	distanceM: lineDistM(click, line),
	start: line[0]!,
	end: line.at(-1)!
});

describe('confluenceChoices', () => {
	it('offers the river below the junction, the main river above it and the tributary, for a click at the junction', () => {
		const click = m(-20, 25);
		const near = [
			reach(11491129, 66.9, [m(2000, 1500), m(800, 600), J], click),
			reach(11491128, 421.5, [m(-1500, 2500), m(-500, 900), J], click),
			reach(11491355, 497.3, [J, m(1500, -1500), m(2500, -2500)], click)
		].sort((a, b) => a.distanceM - b.distanceM);
		const c = confluenceChoices(click, near)!;
		expect(c.map((x) => [x.reachId, x.role, x.label])).toEqual([
			[11491355, 'below', 'the river below the junction'],
			[11491128, 'above', 'the main river above the junction'],
			[11491129, 'above', 'the tributary above the junction']
		]);
		expect(new ConfluenceAmbiguity(c).message).toBe(
			'This point is at a confluence: the river below the junction (497 km²), the main river above the junction (422 km²), the tributary above the junction (67 km²). Pick the river you mean.'
		);
	});

	it('is no confluence where one river’s two reaches meet with about the same area', () => {
		const click = m(10, 10);
		const near = [reach(1, 420, [m(-2000, 2000), J], click), reach(2, 431, [J, m(2000, -2000)], click)];
		expect(confluenceChoices(click, near)).toBeNull();
	});

	it('is no confluence when the other river is further than CONFLUENCE_M', () => {
		const click = m(0, 0);
		const near = [reach(1, 420, [m(-2000, 0), m(2000, 0)], click), reach(2, 30, [m(-2000, CONFLUENCE_M + 60), m(2000, CONFLUENCE_M + 60)], click)];
		expect(confluenceChoices(click, near)).toBeNull();
	});

	it('names a river whose ends are both far as along the point, beside a tributary ending by it', () => {
		const click = m(0, 20);
		const near = [reach(1, 420, [m(-3000, 0), m(3000, 0)], click), reach(2, 25, [m(0, 1500), m(0, 60)], click)].sort((a, b) => a.distanceM - b.distanceM);
		expect(confluenceChoices(click, near)!.map((x) => [x.reachId, x.role, x.label])).toEqual([
			[1, 'along', 'the river along the point'],
			[2, 'above', 'the river above the junction']
		]);
	});
});

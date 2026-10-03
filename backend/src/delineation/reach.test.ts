import { describe, expect, it } from 'vitest';
import { areaAlong, confluenceChoices, ConfluenceAmbiguity, CONFLUENCE_M, fractionAlong, HEAD_KM2, junctionBeside, JUNCTION_SIDE_M, lineDistM, type NearReachLine } from './reach.js';

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
	end: line.at(-1)!,
	line
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

describe('the reach’s area at the click (the hydrologist persona’s finding 13)', () => {
	// A straight reach 4 km long running south, its upstream area (at its lower end) 50 km².
	const line: [number, number][] = [m(0, 0), m(0, -1000), m(0, -4000)];
	it('measures how far down the line a point lies, by length, from beside it too', () => {
		expect(fractionAlong(m(0, 0), line)).toBe(0);
		expect(fractionAlong(m(0, -4000), line)).toBe(1);
		expect(fractionAlong(m(0, -1000), line)).toBeCloseTo(0.25, 3);
		expect(fractionAlong(m(300, -2000), line)).toBeCloseTo(0.5, 3);
		// Past either end: clamped.
		expect(fractionAlong(m(0, 500), line)).toBe(0);
		expect(fractionAlong(m(0, -4600), line)).toBe(1);
	});
	it('a head reach (nothing flowing in) starts at HydroRIVERS’ 10 km² and grows to its area down the line', () => {
		expect(HEAD_KM2).toBe(10);
		const r = { upstreamKm2: 50, line };
		expect(areaAlong(r, m(0, -4000), null)).toBeCloseTo(50, 6);
		expect(areaAlong(r, m(0, -1000), null)).toBeCloseTo(10 + 40 * 0.25, 3);
		expect(areaAlong(r, m(0, 0), null)).toBeCloseTo(10, 6);
		// A head reach smaller than the threshold: its own area throughout.
		expect(areaAlong({ upstreamKm2: 6, line }, m(0, 0), null)).toBeCloseTo(6, 6);
	});
	it('a reach with inflows starts at what flows in', () => {
		expect(areaAlong({ upstreamKm2: 50, line }, m(0, -2000), 30)).toBeCloseTo(40, 3);
		// Inflows that (by the source's rounding) exceed the reach's own area never raise it past that.
		expect(areaAlong({ upstreamKm2: 50, line }, m(0, 0), 51)).toBeCloseTo(50, 6);
	});
});

describe('junctionBeside', () => {
	// The same junction; a gauge on one of its rivers, too far from it to be asked.
	const lines = {
		trib: [m(2000, 1500), m(800, 600), J] as [number, number][],
		main: [m(-1500, 2500), m(-500, 900), J] as [number, number][],
		below: [J, m(1500, -1500), m(2500, -2500)] as [number, number][]
	};
	const nearOf = (click: [number, number]) =>
		[reach(11491129, 66.9, lines.trib, click), reach(11491128, 421.5, lines.main, click), reach(11491355, 497.3, lines.below, click)].sort((a, b) => a.distanceM - b.distanceM);
	const rivers = [
		{ key: 'HydroRIVERS-v10:11491129', role: 'above', km2: 66.9 },
		{ key: 'HydroRIVERS-v10:11491128', role: 'above', km2: 421.5 },
		{ key: 'HydroRIVERS-v10:11491355', role: 'below', km2: 497.3 }
	];

	it('gives a click 350 m up the main river that junction’s rivers, the main river chosen, without asking', () => {
		// 350 m along the main river's last segment from the junction (it runs 500 m W, 900 m N).
		const click = m(-170, 306);
		const near = nearOf(click);
		expect(confluenceChoices(click, near)).toBeNull();
		const b = junctionBeside(click, near)!;
		expect(b.chosenKey).toBe('HydroRIVERS-v10:11491128');
		expect(b.rivers).toEqual(expect.arrayContaining(rivers));
		expect(b.rivers).toHaveLength(3);
	});

	it('gives a click 350 m down the river below that junction, the river below chosen', () => {
		const click = m(247, -247);
		const b = junctionBeside(click, nearOf(click))!;
		expect(b.chosenKey).toBe('HydroRIVERS-v10:11491355');
		expect(b.rivers).toEqual(expect.arrayContaining(rivers));
	});

	it('gives nothing past JUNCTION_SIDE_M, or where the nearest reach’s ends meet no other river', () => {
		const far = m(-1400, 2330); // on the main river, ~1.5 km up its line from the junction
		expect(Math.hypot(1400, 2330)).toBeGreaterThan(JUNCTION_SIDE_M);
		expect(junctionBeside(far, nearOf(far))).toBeNull();
		// One river's two reaches meeting: one flows in, so no junction.
		const click = m(-200, 300);
		const one = [reach(1, 420, [m(-2000, 2000), J], click), reach(2, 431, [J, m(2000, -2000)], click)].sort((a, b) => a.distanceM - b.distanceM);
		expect(junctionBeside(click, one)).toBeNull();
		expect(junctionBeside(click, [])).toBeNull();
	});
});

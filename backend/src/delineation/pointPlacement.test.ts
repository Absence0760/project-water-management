import { describe, expect, it } from 'vitest';
import { placementOf, placementWarnings, type PointPlacement } from './pointPlacement.js';

// The warnings a Start or Divide plan carries for a point's placement (pure).

const pl = (over: Partial<PointPlacement>): PointPlacement => ({ placedBy: 'snapped', larger: null, ...over });

describe('placementWarnings', () => {
	it('names a much larger channel beside a snapped point, and offers it', () => {
		const [w] = placementWarnings('Weir', [20.5, -33.5], pl({ larger: { at: [20.49, -33.5], distanceM: 420, km2: 300, pointKm2: 1.5 } }));
		expect(w).toMatch(/^A much larger terrain channel runs 420 m west of Weir: at least 300 km² drains through it, against 1\.50 km² where the point was put\. Use that channel, or keep the point if it is on the small stream\.$/);
	});

	it('says a dam outline only clips a much larger channel, and that the dam was taken as off it (the hydrologist’s review, finding 9)', () => {
		const w = placementWarnings('Upper dam', [20.5, -33.5], pl({ placedBy: 'polygon', larger: { at: [20.5, -33.501], distanceM: 120, km2: 450, pointKm2: 0.04, outline: true } }));
		expect(w).toHaveLength(1);
		expect(w[0]).toMatch(
			/^Upper dam’s outline also covers a much larger channel 120 m south of its outflow: at least 450 km² drains through it, but only a cell or two of it lies inside the outline, so the dam was taken as off that channel \(filled by a pump or a furrow\) and its outflow put where its own water leaves it \(0\.04 km²\)\. If the dam is on that river, use that channel; otherwise keep it\.$/
		);
	});

	it('says nothing for a point on the nearest terrain channel with no larger channel beside it', () => {
		expect(placementWarnings('Weir', [20.5, -33.5], pl({}))).toEqual([]);
	});
});

describe('placementOf', () => {
	it('keeps a dam’s marked position in the plan, and adds nothing for an unmarked one (194)', () => {
		expect(placementOf({ placedBy: 'polygon', damPosition: 'off_channel' })).toEqual({ placedBy: 'polygon', larger: null, damPosition: 'off_channel' });
		expect(placementOf({ placedBy: 'polygon' })).toEqual({ placedBy: 'polygon', larger: null });
	});
});

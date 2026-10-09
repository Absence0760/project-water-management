import { describe, expect, it } from 'vitest';
import { lineDistM } from './reach.js';

// A point's distance from a mapped river's line (nearestReach's measure).
const J: [number, number] = [21.26042, -28.32708];
const m = (dx: number, dy: number): [number, number] => [J[0] + dx / 97900, J[1] + dy / 110950];

describe('lineDistM', () => {
	it('is the distance to the nearest segment, in metres', () => {
		expect(lineDistM(m(0, 100), [m(-500, 0), m(500, 0)])).toBeCloseTo(100, 0);
	});

	it('is the distance to the nearer end past a segment’s end', () => {
		expect(lineDistM(m(800, 0), [m(-500, 0), m(500, 0)])).toBeCloseTo(300, 0);
	});

	it('takes the nearest line of a MultiLineString', () => {
		expect(
			lineDistM(m(0, 100), [
				[m(-500, 1000), m(500, 1000)],
				[m(-500, 50), m(500, 50)]
			])
		).toBeCloseTo(50, 0);
	});
});

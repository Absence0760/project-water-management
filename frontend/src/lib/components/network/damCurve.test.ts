import { describe, expect, it } from 'vitest';
import { curveNotes, curveText, parseDamCurve } from './damCurve';

describe('parseDamCurve', () => {
	it('reads comma, semicolon, tab and space separated rows, skipping a header and blank lines', () => {
		const text = 'Level (m), Area (m²), Volume (m³)\n100, 0, 0\n\n101;8000;4000\n102\t14000\t15000\n103 20000 32000\n';
		expect(parseDamCurve(text)).toEqual({
			rows: [
				{ levelM: 100, areaM2: 0, volumeM3: 0 },
				{ levelM: 101, areaM2: 8000, volumeM3: 4000 },
				{ levelM: 102, areaM2: 14000, volumeM3: 15000 },
				{ levelM: 103, areaM2: 20000, volumeM3: 32000 }
			],
			error: null
		});
	});

	it('says which line it could not read', () => {
		expect(parseDamCurve('100, 0, 0\n101, 8000').error).toBe('Line 2: expected 3 values (level, area, volume), found 2.');
		expect(parseDamCurve('100, 0, 0\nlevel, area, volume').error).toBe('Line 2: "level" is not a number.');
		expect(parseDamCurve('100, x, 0').error).toBe('Line 1: every value must be a number.');
		expect(parseDamCurve('  \n').error).toMatch(/No rows/);
	});

	it('round-trips through curveText', () => {
		const rows = [
			{ levelM: 100.5, areaM2: 0, volumeM3: 0 },
			{ levelM: 102, areaM2: 1500.25, volumeM3: 900 }
		];
		expect(parseDamCurve(curveText(rows)).rows).toEqual(rows);
		expect(curveText(null)).toBe('');
	});
});

describe('curveNotes', () => {
	const rows = [
		{ levelM: 100, areaM2: 0, volumeM3: 0 },
		{ levelM: 103, areaM2: 20_000, volumeM3: 32_000 }
	];

	it('says the power law is in use without a curve', () => {
		expect(curveNotes(null, 40_000)).toEqual({ error: null, notes: [expect.stringMatching(/No survey curve: using the power-law area/)] });
	});

	it('passes on the rule a curve breaks, as the save would refuse it', () => {
		expect(curveNotes([rows[0]!], 32_000).error).toBe('A survey curve needs at least two rows.');
	});

	it('flags a top row more than 1 % from the capacity', () => {
		expect(curveNotes(rows, 32_200).notes).toHaveLength(1);
		const off = curveNotes(rows, 40_000);
		expect(off.error).toBeNull();
		expect(off.notes[0]).toBe("The survey's top row holds 32\u202f000 m³ but the capacity is 40\u202f000 m³ (more than 1 % apart). Check one against the other.");
	});
});

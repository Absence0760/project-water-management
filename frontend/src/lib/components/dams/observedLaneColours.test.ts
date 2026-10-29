// The Dams tab's Seen from space strips (./observed.ts observedLanes, issue
// #604 R5-B), computed as the flow-quality strips are
// (calibration/flowFlagColours.test.ts; ui-playbook.md § 3, "Compute
// colour-blind separation"). Three strips (disagree, seen full, seen empty),
// and a fourth, doubled, for the days a radar view was compared (issue #624),
// along the foot of a chart that draws the modelled area (--series-1), the
// views (--series-2 points), the views not compared (--text-muted points) and
// the full area (--text-2, dashed). The review measured --danger and --warning
// 0.7 apart for a light-theme deuteranope and the dark --danger 9.8 from the
// --series-2 points for a tritanope, so the strips have their own --lane-*
// colours, held here for every reader, not only normal vision: each pair of
// strips ΔE00 ≥ 12, each strip ≥ 13 from every line, and 3:1 on the card.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, cssHex, deFor, VISIONS, worstDe, type Theme } from '#lib/a11y/colourVision.js';
import type { ObservedDam, ObservedPoint } from '#lib/api/types.js';
import { OBSERVED_LANE_COLOR, OBSERVED_LINE_COLORS, observedChartSeries, observedLanes } from './observed';

const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
const hex = (theme: Theme, token: string) => cssHex(css, theme, token);
const LANES = Object.values(OBSERVED_LANE_COLOR);
/** Two strips side by side, under any of the four visions. */
const APART = 12;
/** A strip and a line or point, under any of the four visions (the playbook's 13, held for colour-blind readers too). */
const FROM_LINES = 13;

const point = (date: string, more: Partial<ObservedPoint> = {}): ObservedPoint => ({
	date,
	source: 'wofs',
	wetAreaM2: 20_000,
	pctObserved: 100,
	modelledAreaM2: 30_000,
	compared: true,
	skip: null,
	seenFull: false,
	seenEmpty: false,
	modelFull: false,
	modelEmpty: false,
	mismatch: null,
	...more
});

describe('the Seen from space strips’ colours (issue #604 R5-B)', () => {
	it('draws every strip in its own token, and the chart only in the lines the test holds them apart from', () => {
		const pts = [
			point('2022-01-02', { seenFull: true, mismatch: 'seen-full' }),
			point('2022-01-03', { seenEmpty: true }),
			point('2022-01-04', { compared: false, skip: 'partly-seen' }),
			point('2022-01-05', { source: 's1' })
		];
		const dam = { nodeId: 'n', features: [], fullArea: { areaM2: 40_000, from: 'entered' }, inRun: true, points: pts, summary: {} } as unknown as ObservedDam;
		expect(observedLanes(dam).map((l) => l.color)).toEqual(LANES);
		// Only the radar strip is doubled: its look, not its colour alone, sets it apart from the flags.
		expect(observedLanes(dam).map((l) => !!l.doubled)).toEqual([false, false, false, true]);
		const lines = observedChartSeries(dam, { startDate: '2022-01-01', values: [1, 2, 3, 4] }).map((s) => s.color);
		expect(lines.every((c) => (OBSERVED_LINE_COLORS as readonly (string | undefined)[]).includes(c)), lines.join()).toBe(true);
		// The tokens as app.css has them (a move means these numbers need computing again).
		expect([hex('light', '--lane-disagree'), hex('dark', '--lane-disagree')]).toEqual(['#bb2211', '#ff9977']);
	});

	for (const theme of ['light', 'dark'] as const) {
		it(`${theme}: every two strips are ΔE00 ≥ ${APART} apart for every reader`, () => {
			const close: string[] = [];
			for (let i = 0; i < LANES.length; i++)
				for (let j = i + 1; j < LANES.length; j++) {
					const d = worstDe(hex(theme, LANES[i]!), hex(theme, LANES[j]!));
					if (d < APART) close.push(`${LANES[i]}|${LANES[j]} ${d.toFixed(1)}`);
				}
			expect(close).toEqual([]);
		});

		it(`${theme}: every strip is ΔE00 ≥ ${FROM_LINES} from every line and point the chart draws, for every reader`, () => {
			const close: string[] = [];
			for (const lane of LANES)
				for (const line of OBSERVED_LINE_COLORS)
					for (const v of VISIONS) {
						const d = deFor(hex(theme, lane), hex(theme, line), v);
						if (d < FROM_LINES) close.push(`${lane}|${line} ${v} ${d.toFixed(1)}`);
					}
			expect(close).toEqual([]);
		});

		it(`${theme}: every strip is at least 3:1 on the panel the chart sits on (WCAG 1.4.11)`, () => {
			for (const lane of LANES) expect(contrast(hex(theme, lane), hex(theme, '--surface')), lane).toBeGreaterThanOrEqual(3);
		});
	}

	it('the old colours failed: --danger and --warning for a light-theme deuteranope, --danger and the --series-2 points in dark', () => {
		expect(deFor(hex('light', '--danger'), hex('light', '--warning'), 'deutan')).toBeLessThan(1);
		expect(deFor(hex('dark', '--danger'), hex('dark', '--series-2'), 'tritan')).toBeLessThan(FROM_LINES);
	});
});

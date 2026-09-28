import { describe, expect, it } from 'vitest';
import { InvalidImportOptionsError } from './errors';
import type { ImportedSeries } from './flowData';
import { duplicateLogger, gaugeAsReference, validateScaling } from './gauge';
import { Report } from './report';

// Ported from scripts/wbt-import/test_gauge_reference.py: synthetic series only (no workbook).
function flowSeries(): ImportedSeries[] {
	return [
		{ kind: 'rain_catchment_mm', name: 'Rain', unit: 'mm', startDate: '2006-06-29', values: [1, 1, 1, 1, 1] },
		{ kind: 'flow_observed_m3s', name: 'Gauge', unit: 'm3/s', startDate: '2006-06-29', values: [2, null, 4, 3, 0] },
		{ kind: 'flow_logger_m3s', name: 'Logger', unit: 'm3/s', startDate: '2006-06-29', values: [1, 1, 1, 1, 1] }
	];
}

function run(series: ImportedSeries[], settings: { calibrationFlowKind: string | null }, from?: string, factor?: number) {
	const report = new Report();
	gaugeAsReference(series, settings, validateScaling(from === undefined && factor === undefined ? undefined : { scalingFrom: from, scaleFactor: factor }), report);
	return report.notes;
}

describe('gaugeAsReference', () => {
	it('relabels the gauge and leaves the other series alone', () => {
		const series = flowSeries();
		const settings = { calibrationFlowKind: 'flow_logger_m3s' as string | null };
		const notes = run(series, settings);
		expect(series.map((s) => s.kind)).toEqual(['rain_catchment_mm', 'flow_reference_m3s', 'flow_logger_m3s']);
		expect(series[1]!.values).toEqual([2, null, 4, 3, 0]); // no scaling asked for
		expect(series[1]!.name).toBe('Gauge');
		expect(settings.calibrationFlowKind).toBe('flow_logger_m3s'); // a logger choice is kept
		expect(notes.length).toBe(1);
		expect(notes[0]!.message).toContain('flow_reference_m3s');
		expect(notes.some((n) => n.message.startsWith('WARNING'))).toBe(false);
	});

	it('undoes a scaling from the given day', () => {
		const series = flowSeries();
		const notes = run(series, { calibrationFlowKind: null }, '2006-07-01', 0.8);
		// 2006-06-29 and -30 are before the cut-off; blanks stay blank; zeros stay zero.
		expect(series[1]!.values).toEqual([2, null, 5, 3.75, 0]);
		expect(notes[0]!.message).toContain('divided by 0.8 (3 days)');
		// The logger is not touched.
		expect(series[2]!.values).toEqual([1, 1, 1, 1, 1]);
	});

	it('scales every day when the cut-off is before the record', () => {
		const series = flowSeries();
		run(series, { calibrationFlowKind: null }, '1990-01-01', 2);
		expect(series[1]!.values).toEqual([1, null, 2, 1.5, 0]);
	});

	it('unsets an rUseFlow on the gauge, with a warning', () => {
		const settings = { calibrationFlowKind: 'flow_observed_m3s' as string | null };
		let notes = run(flowSeries(), settings);
		expect(settings.calibrationFlowKind).toBeNull();
		let warnings = notes.filter((n) => n.message.startsWith('WARNING: '));
		expect(warnings.length).toBe(1);
		expect(warnings[0]!.severity).toBe('warning');
		expect(warnings[0]!.message).toContain('runs use the logger record');

		const noLogger = flowSeries().filter((s) => s.kind !== 'flow_logger_m3s');
		const s2 = { calibrationFlowKind: 'flow_observed_m3s' as string | null };
		notes = run(noLogger, s2);
		expect(s2.calibrationFlowKind).toBeNull();
		warnings = notes.filter((n) => n.message.startsWith('WARNING: '));
		expect(warnings[0]!.message).toContain('no observed flow record');
	});

	it('notes a workbook with no gauge column rather than failing', () => {
		const series = flowSeries().filter((s) => s.kind !== 'flow_observed_m3s');
		const notes = run(series, { calibrationFlowKind: null });
		expect(series.map((s) => s.kind)).toEqual(['rain_catchment_mm', 'flow_logger_m3s']);
		expect(notes[0]!.message).toContain('nothing to re-label');
	});

	it('rejects half a scaling or a bad factor', () => {
		const bad: [string | undefined, number | undefined][] = [
			['2006-07-01', undefined],
			[undefined, 0.8],
			['2006-07-01', 0],
			['2006-07-01', -1],
			['2006-07-01', NaN],
			['07/01/2006', 0.5],
			['2006-02-30', 0.5]
		];
		for (const [from, factor] of bad) {
			expect(() => validateScaling({ scalingFrom: from, scaleFactor: factor }), `${from} ${factor}`).toThrow(InvalidImportOptionsError);
		}
		expect(validateScaling(undefined)).toBeNull();
		expect(validateScaling({ scalingFrom: '2006-07-01', scaleFactor: 0.5 })).toEqual({ scalingFrom: '2006-07-01', scaleFactor: 0.5 });
	});
});

// Ported from test_gauge_reference.py DuplicateLogger (issue #54).
describe('duplicateLogger', () => {
	const copied = () => {
		const series = flowSeries();
		series[2]!.values = [...series[1]!.values];
		return series;
	};
	const dedupe = (series: ImportedSeries[], settings: { calibrationFlowKind: string | null }) => {
		const report = new Report();
		duplicateLogger(series, settings, report);
		return report.notes;
	};

	it('drops a copy, and a logger choice moves to the gauge', () => {
		const series = copied();
		const settings = { calibrationFlowKind: 'flow_logger_m3s' as string | null };
		const notes = dedupe(series, settings);
		expect(series.map((s) => s.kind)).toEqual(['rain_catchment_mm', 'flow_observed_m3s']);
		expect(settings.calibrationFlowKind).toBe('flow_observed_m3s');
		expect(notes).toHaveLength(1);
		expect(notes[0]!.message).toBe(
			"WARNING: [Flow data] the logger column is a copy of the gauge column (the same value on every day), so it is not imported as a second record: a copy would read as two instruments agreeing, and as an independent validation record, which it is not; rUseFlow's logger choice now names the gauge, the same record (issue #54)"
		);
		expect(notes[0]!.severity).toBe('warning');
	});

	it('keeps a gauge choice', () => {
		const settings = { calibrationFlowKind: null as string | null };
		const notes = dedupe(copied(), settings);
		expect(settings.calibrationFlowKind).toBeNull();
		expect(notes[0]!.message).not.toContain('now names the gauge');
	});

	it('keeps a logger that differs on one day, has a blank where the gauge has a value, or starts elsewhere', () => {
		for (const change of ['value', 'blank', 'start'] as const) {
			const series = copied();
			if (change === 'value') series[2]!.values[4] = 0.001;
			else if (change === 'blank') series[2]!.values[0] = null;
			else series[2]!.startDate = '2006-06-30';
			const settings = { calibrationFlowKind: 'flow_logger_m3s' as string | null };
			expect(dedupe(series, settings), change).toEqual([]);
			expect(series).toHaveLength(3);
			expect(settings.calibrationFlowKind).toBe('flow_logger_m3s');
		}
	});
});

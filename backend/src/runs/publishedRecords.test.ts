// Which of a run's stored series hold a published DWS gauge record (#523 G8, runs/publishedRecords.ts).
import { OBSERVED_SERIES_LABEL } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { publishedRecordMeta, riverGauge } from './publishedRecords.js';

const gauge = { nodeId: null, key: 'observed_flow', label: OBSERVED_SERIES_LABEL.flow_observed_m3s };
const logger = { nodeId: null, key: 'observed_flow_other', label: OBSERVED_SERIES_LABEL.flow_logger_m3s };

describe('publishedRecordMeta', () => {
	it('marks the outlet series that holds a record a DWS feed wrote whole, by the engine’s label (positive control)', () => {
		expect(Object.fromEntries(publishedRecordMeta([gauge, logger], { flow_observed_m3s: 'A2H012' }))).toEqual({
			observed_flow: { publishedBy: 'DWS', station: 'A2H012' }
		});
		// The calibration record may be the logger's; then the gauge is the other one.
		const swapped = [
			{ ...gauge, label: OBSERVED_SERIES_LABEL.flow_logger_m3s },
			{ ...logger, label: OBSERVED_SERIES_LABEL.flow_observed_m3s }
		];
		expect(Object.fromEntries(publishedRecordMeta(swapped, { flow_observed_m3s: 'A2H012' }))).toEqual({
			observed_flow_other: { publishedBy: 'DWS', station: 'A2H012' }
		});
	});

	it('marks nothing without a DWS record, for a private logger, a node’s series or another key', () => {
		expect(publishedRecordMeta([gauge, logger], undefined).size).toBe(0);
		expect(publishedRecordMeta([gauge, logger], {}).size).toBe(0);
		// The logger's record wasn't DWS-fed: only what was.
		expect(publishedRecordMeta([logger], { flow_observed_m3s: 'A2H012' }).size).toBe(0);
		// A calibration site's series is a node's, never marked.
		expect(publishedRecordMeta([{ ...gauge, nodeId: 'n1' }], { flow_observed_m3s: 'A2H012' }).size).toBe(0);
		expect(publishedRecordMeta([{ ...gauge, key: 'simulated_outflow' }], { flow_observed_m3s: 'A2H012' }).size).toBe(0);
	});

	it('marks no gap-filled record: a filled day may be a donor record’s', () => {
		const fill = { nodeId: null, key: 'observed_flow_fill', label: 'fill' };
		expect(publishedRecordMeta([gauge, fill], { flow_observed_m3s: 'A2H012' }).size).toBe(0);
		// The other record's fill leaves the calibration record marked.
		const otherFill = { nodeId: null, key: 'observed_flow_other_fill', label: 'fill' };
		expect([...publishedRecordMeta([gauge, otherFill], { flow_observed_m3s: 'A2H012' }).keys()]).toEqual(['observed_flow']);
	});

	it('takes only a DWS river gauge’s code', () => {
		expect(riverGauge('A2H012')).toBe('A2H012');
		for (const bad of ['A2R001', 'a2h012', 'A2H01', '', null, undefined]) expect(riverGauge(bad), String(bad)).toBeNull();
		expect(publishedRecordMeta([gauge], { flow_observed_m3s: 'A2R001' }).size).toBe(0);
	});
});

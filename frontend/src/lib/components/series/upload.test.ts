import { describe, expect, it } from 'vitest';
import { mergePreview } from './coverage';
import { inStoredUnit } from './upload';

describe('inStoredUnit', () => {
	it('scales a flow file in l/s to m³/s, keeping gaps', () => {
		expect(inStoredUnit('flow_observed_m3s', 'l/s', [1500, null, 250])).toEqual({ unit: 'm³/s', values: [1.5, null, 0.25] });
	});

	it('leaves a file already in the stored unit as it is', () => {
		const values = [3, null, 4];
		expect(inStoredUnit('rain_catchment_mm', 'mm', values)).toEqual({ unit: 'mm', values });
	});

	it('leaves a unit the table does not know as given, for the server to refuse', () => {
		expect(inStoredUnit('flow_observed_m3s', 'furlongs', [1])).toEqual({ unit: 'furlongs', values: [1] });
	});

	it('an l/s file that repeats the stored m³/s days changes none of them', () => {
		// The bug: compared raw, 1200 l/s against a stored 1.2 m³/s counted as changed.
		const stored = { startDate: '2021-10-01', values: inStoredUnit('flow_observed_m3s', 'l/s', [1200, 800]).values };
		const file = inStoredUnit('flow_observed_m3s', 'l/s', [1200, 800, 600]);
		const p = mergePreview(stored, { startDate: '2021-10-01', values: file.values });
		expect({ added: p.added, changed: p.changed, unchanged: p.unchanged }).toEqual({ added: 1, changed: 0, unchanged: 2 });
	});
});

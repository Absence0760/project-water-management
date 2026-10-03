import { describe, expect, it } from 'vitest';
import { mergePreview } from './coverage';
import { inStoredUnit, latestFileText } from './upload';

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

describe('latestFileText', () => {
	/** A file whose text arrives when the test says. */
	const slowFile = () => {
		let settle!: { resolve: (t: string) => void; reject: (e: Error) => void };
		const p = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
		return { file: { text: () => p }, ...settle };
	};

	it('drops a read that a later pick overtook, however late it lands', async () => {
		const read = latestFileText();
		const big = slowFile();
		const first = read(big.file);
		const second = read({ text: async () => 'small.csv' });
		expect(await second).toBe('small.csv');
		big.resolve('big.csv');
		expect(await first).toBeNull();
	});

	it('drops a read when the file is cleared, and a superseded read’s failure', async () => {
		const read = latestFileText();
		const a = slowFile();
		const first = read(a.file);
		expect(await read(null)).toBeNull();
		a.reject(new Error('NotReadableError'));
		expect(await first).toBeNull();
	});

	it('reads the latest pick, and lets its own failure through', async () => {
		const read = latestFileText();
		expect(await read({ text: async () => 'only.csv' })).toBe('only.csv');
		await expect(read({ text: () => Promise.reject(new Error('NotReadableError')) })).rejects.toThrow('NotReadableError');
	});
});

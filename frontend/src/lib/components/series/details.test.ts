import type { SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asksSite, productField, rowSiteMark, siteText, uploadUnitText } from './details';

const meta = (kind: string, more: Partial<SeriesMeta> = {}): SeriesMeta => ({ id: 's', kind, name: '', unit: 'm³/s', startDate: '2020-01-01', length: 1, ...more });
const gauges = [{ id: 'g1', name: 'Middle weir' }];

describe('productField', () => {
	it('asks a CHIRPS series its product, recorded or not', () => {
		expect(productField(meta('rain_chirps_mm'))).toBe('chirps');
		expect(productField(meta('rain_chirps_mm', { product: 'CHIRPS', productVersion: '2.0' }))).toBe('chirps');
	});

	it('shows a free product only once one is recorded, and nothing for other kinds', () => {
		expect(productField(meta('rain_catchment_alt_mm', { product: 'SASSCAL AWS', productVersion: '1' }))).toBe('text');
		expect(productField(meta('rain_catchment_alt_mm'))).toBeNull();
		expect(productField(meta('rain_catchment_mm', { product: 'x', productVersion: '1' }))).toBeNull();
	});
});

describe('asksSite', () => {
	it('asks a flow record where it was measured when the model has a gauge above the outlet', () => {
		expect(asksSite(meta('flow_observed_m3s'), gauges)).toBe(true);
		expect(asksSite(meta('flow_logger_m3s'), gauges)).toBe(true);
		expect(asksSite(meta('flow_observed_m3s'), [])).toBe(false);
	});

	it('still asks a record placed at a gauge that has left the model, so it can be moved back', () => {
		expect(asksSite(meta('flow_observed_m3s', { siteNodeId: 'gone' }), [])).toBe(true);
	});

	it('never asks rain or the reference gauge', () => {
		expect(asksSite(meta('rain_catchment_mm'), gauges)).toBe(false);
		expect(asksSite(meta('flow_reference_m3s'), gauges)).toBe(false);
	});
});

describe('siteText and rowSiteMark', () => {
	it('names the outlet, a gauge, or a gauge no longer in the model', () => {
		expect(siteText(null, gauges)).toBe('The outlet');
		expect(siteText('g1', gauges)).toBe('Gauge Middle weir');
		expect(siteText('gone', gauges)).toBe('A hydrological unit no longer in the model');
	});

	it('marks a row only when its record sits at a gauge', () => {
		expect(rowSiteMark(meta('flow_observed_m3s'), gauges)).toBeNull();
		expect(rowSiteMark(meta('flow_observed_m3s', { siteNodeId: 'g1' }), gauges)).toBe('At gauge Middle weir');
		expect(rowSiteMark(meta('flow_logger_m3s', { siteNodeId: 'gone' }), gauges)).toBe('At a hydrological unit no longer in the model');
		expect(rowSiteMark(meta('rain_catchment_mm', { siteNodeId: 'g1' }), gauges)).toBeNull();
	});
});

describe('uploadUnitText', () => {
	it('says the unit and the conversion, or that it was not recorded', () => {
		expect(uploadUnitText(meta('flow_observed_m3s', { sourceUnit: 'l/s', sourceUnitFactor: 0.001 }))).toBe('l/s, converted to m³/s (× 0.001)');
		expect(uploadUnitText(meta('flow_observed_m3s', { sourceUnit: 'm³/s', sourceUnitFactor: 1 }))).toBe('m³/s');
		expect(uploadUnitText(meta('flow_observed_m3s', { sourceUnit: 'm³/s' }))).toBe('m³/s');
		expect(uploadUnitText(meta('flow_observed_m3s'))).toBe('Not recorded');
	});
});

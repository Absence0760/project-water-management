// Flow records not placed in the network (issue #659, docs/ui.md § Settings & calibration).
import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import { measuredAtHref, unplacedRecords, unplacedWhy } from './unplaced';

const node = (id: string, name: string, kind: NetworkNode['kind'], down: string | null) => ({ id, name, kind, downstreamNodeId: down });
const NODES = [node('O', 'Outlet', 'gauge', null), node('G', 'Weir', 'gauge', 'O'), node('F', 'Farm', 'farm', 'O')];
const rec = (id: string, kind: string, name: string, siteNodeId: string | null = null) => ({ id, kind, name, siteNodeId });

describe('unplaced flow records', () => {
	it('flags a record whose gauge is gone, one at a node that isn’t a gauge inside the network, and a second outlet record', () => {
		const series = [
			rec('1', 'flow_observed_m3s', 'B outlet record'),
			rec('2', 'flow_observed_m3s', 'A outlet record'),
			rec('3', 'flow_logger_m3s', 'Logger'),
			rec('4', 'flow_observed_m3s', 'Weir record', 'G'),
			rec('5', 'flow_observed_m3s', 'Old weir', 'gone'),
			rec('6', 'flow_logger_m3s', 'At the farm', 'F'),
			rec('7', 'flow_observed_m3s', 'At the outlet node', 'O'),
			rec('8', 'rain_catchment_mm', 'Rain', 'gone')
		];
		expect(unplacedRecords(series, NODES).map((r) => [r.id, r.why, r.at])).toEqual([
			// The run reads the first outlet record by name (byte order): "A outlet record".
			['1', 'second', null],
			['5', 'gone', null],
			['6', 'notInner', 'Farm'],
			['7', 'notInner', 'Outlet']
		]);
		expect(unplacedRecords(null, NODES)).toEqual([]);
		expect(unplacedRecords([rec('4', 'flow_observed_m3s', 'Weir record', 'G')], NODES)).toEqual([]);
	});

	it('says why, and links to the record’s Measured at on Data', () => {
		expect(unplacedWhy({ why: 'gone', at: null })).toBe('its Measured at names a gauge no longer in the model');
		expect(unplacedWhy({ why: 'notInner', at: 'Farm' })).toBe('its Measured at is “Farm”, not a gauge inside the network');
		expect(unplacedWhy({ why: 'second', at: null })).toMatch(/second outlet record of its kind/);
		expect(measuredAtHref('a b')).toBe('?tab=series&series=a%20b#data-chart');
	});
});

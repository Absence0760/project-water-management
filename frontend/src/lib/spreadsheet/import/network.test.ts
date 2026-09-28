import { describe, expect, it } from 'vitest';
import { downstreamLinks, readNetwork } from './network';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

describe('readNetwork', () => {
	it('reads elements, kinds and upstream names in table order', () => {
		const { elements, outflow } = readNetwork(new B023Workbook(syntheticB023().build()), new Report());
		expect(elements).toEqual([
			{ name: 'Farm A', kind: 'farm', upstream: [] },
			{ name: 'Farm B', kind: 'farm', upstream: ['Farm A'] },
			{ name: 'Outlet', kind: 'gauge', upstream: ['Farm B'] }
		]);
		expect(outflow).toBe('Outlet');
	});

	it('matches names across whitespace and case of the type', () => {
		const b = syntheticB023().set('Network', 'J27', ' Farm   B ').set('Network', 'K28', ' GAUGE ').set('Network', 'M28', 'Farm  B');
		const { elements } = readNetwork(new B023Workbook(b.build()), new Report());
		expect(elements.map((e) => [e.name, e.kind])).toEqual([
			['Farm A', 'farm'],
			['Farm B', 'farm'],
			['Outlet', 'gauge']
		]);
		expect(elements[2]!.upstream).toEqual(['Farm B']);
	});

	it('imports an unknown element type as a farm and lists it', () => {
		const report = new Report();
		const { elements } = readNetwork(new B023Workbook(syntheticB023().set('Network', 'K26', 'Dam').build()), report);
		expect(elements[0]!.kind).toBe('farm');
		expect(report.unmapped).toEqual([expect.objectContaining({ code: 'element-type-unknown', element: 'Farm A', text: 'Dam' })]);
	});
});

describe('downstreamLinks', () => {
	it('inverts the upstream columns', () => {
		const report = new Report();
		const links = downstreamLinks(
			[
				{ name: 'A', kind: 'farm', upstream: [] },
				{ name: 'B', kind: 'farm', upstream: [] },
				{ name: 'C', kind: 'farm', upstream: ['A', 'B'] },
				{ name: 'G', kind: 'gauge', upstream: ['C'] }
			],
			'G',
			report
		);
		expect([...links]).toEqual([
			['A', 'C'],
			['B', 'C'],
			['C', 'G'],
			['G', null]
		]);
		expect(report.notes).toEqual([]);
	});

	it('does not note several roots when the outflow gauge is not one of them', () => {
		const report = new Report();
		downstreamLinks(
			[
				{ name: 'A', kind: 'farm', upstream: [] },
				{ name: 'B', kind: 'farm', upstream: [] }
			],
			'Elsewhere',
			report
		);
		expect(report.notes).toEqual([]);
	});
});

import { describe, expect, it } from 'vitest';
import { modelWindow } from './modelWindow';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

const dates = ['1960-01-01', '1960-01-02', '2001-10-01', '2024-09-29', '2024-09-30'];
const home = (d1: string | null, dn: string | null) => {
	const b = syntheticB023().name('zHome_CalcDate1', 'Home!$E$14').name('zHome_CalcDateN', 'Home!$E$15');
	if (d1) b.set('Home', 'E14', { date: d1 });
	if (dn) b.set('Home', 'E15', { date: dn });
	return new B023Workbook(b.build());
};

// Issue #54: a workbook whose flow record starts decades before its rain; [Home] calculates from where the rain starts.
describe('modelWindow', () => {
	it('runs the [Home] calculation window when it cuts the flow record short', () => {
		expect(modelWindow(home('2001-10-01', '2024-09-29'), dates)).toEqual({
			simulationStart: '2001-10-01',
			simulationEnd: '2024-09-29',
			note: "[Home] the workbook calculates 2001-10-01 to 2024-09-29, inside [Flow data]'s 1960-01-01 to 2024-09-30: runs cover that window (settings.simulationStart / End); every series keeps its full record"
		});
		expect(modelWindow(home('2001-10-01', '2024-09-30'), dates)).toMatchObject({ simulationStart: '2001-10-01', simulationEnd: null });
	});

	it('leaves the run on the whole flow record when [Home] covers it, lies outside it, is reversed or missing', () => {
		expect(modelWindow(home('1960-01-01', '2024-09-30'), dates)).toBeNull();
		expect(modelWindow(home('1940-01-01', '2030-01-01'), dates)).toBeNull();
		expect(modelWindow(home('2024-09-29', '2001-10-01'), dates)).toBeNull();
		expect(modelWindow(home(null, null), dates)).toBeNull();
		expect(modelWindow(new B023Workbook(syntheticB023().build()), dates)).toBeNull();
	});
});

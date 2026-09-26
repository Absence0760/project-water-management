import { describe, expect, it } from 'vitest';
import { modelWindow } from './modelWindow';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

const dates = ['1951-06-01', '1951-06-02', '1996-08-01', '2025-08-28', '2025-08-29'];
const home = (d1: string | null, dn: string | null) => {
	const b = syntheticB023().name('zHome_CalcDate1', 'Home!$E$14').name('zHome_CalcDateN', 'Home!$E$15');
	if (d1) b.set('Home', 'E14', { date: d1 });
	if (dn) b.set('Home', 'E15', { date: dn });
	return new B023Workbook(b.build());
};

// Issue #54: [Flow data] from 1951 but rain from 1996; the workbook calculates from 1996.
describe('modelWindow', () => {
	it('runs the [Home] calculation window when it cuts the flow record short', () => {
		expect(modelWindow(home('1996-08-01', '2025-08-28'), dates)).toEqual({
			simulationStart: '1996-08-01',
			simulationEnd: '2025-08-28',
			note: "[Home] the workbook calculates 1996-08-01 to 2025-08-28, inside [Flow data]'s 1951-06-01 to 2025-08-29: runs cover that window (settings.simulationStart / End); every series keeps its full record"
		});
		expect(modelWindow(home('1996-08-01', '2025-08-29'), dates)).toMatchObject({ simulationStart: '1996-08-01', simulationEnd: null });
	});

	it('leaves the run on the whole flow record when [Home] covers it, lies outside it, is reversed or missing', () => {
		expect(modelWindow(home('1951-06-01', '2025-08-29'), dates)).toBeNull();
		expect(modelWindow(home('1940-01-01', '2030-01-01'), dates)).toBeNull();
		expect(modelWindow(home('2025-08-28', '1996-08-01'), dates)).toBeNull();
		expect(modelWindow(home(null, null), dates)).toBeNull();
		expect(modelWindow(new B023Workbook(syntheticB023().build()), dates)).toBeNull();
	});
});

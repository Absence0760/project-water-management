import { describe, expect, it } from 'vitest';
import { MONTHLY_SETTINGS_FORMAT, monthlySettingRows, monthlySettingsCsv, planSettingsPaste } from './monthlyPaste';

const settings = () => ({ apanMm: [150, 160, 170, 180, 170, 150, 110, 80, 60, 60, 90, 120], panCoefficient: new Array(12).fill(0.7) });
const plan = (r: ReturnType<typeof planSettingsPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('monthly evaporation paste (issue #477)', () => {
	it('has the pan coefficient row only while GR4J runs on pan × A-pan', () => {
		expect(monthlySettingRows(settings(), true).map((r) => r.id)).toEqual(['apanMm', 'panCoefficient']);
		expect(monthlySettingRows(settings(), false).map((r) => r.id)).toEqual(['apanMm']);
	});

	it('reads both rows by name or a short name, and either alone', () => {
		const rows = monthlySettingRows(settings(), true);
		const p = plan(planSettingsPaste('Parameter\tOct\tNov\nA-pan (mm)\t155\t160\nKp\t0.72\t0.7', rows));
		expect(p.changes.map((c) => [c.rowId, c.column, c.to])).toEqual([
			['apanMm', 'Oct', 155],
			['panCoefficient', 'Oct', 0.72]
		]);
		expect(plan(planSettingsPaste('Month\tDec\nPan coefficient\t0.65', rows)).changes).toHaveLength(1);
		// A pan coefficient while GR4J reads a monthly PE row: no such row here.
		expect(plan(planSettingsPaste('Parameter\tOct\nA-pan\t1\nPan coefficient\t0.6', monthlySettingRows(settings(), false))).notes).toContain(
			"Left out a row the table doesn't have: Pan coefficient."
		);
	});

	it('stops on a pan coefficient above 2 and a negative A-pan', () => {
		const rows = monthlySettingRows(settings(), true);
		expect(planSettingsPaste('Pan coefficient\t2.1', rows)).toEqual({ error: 'Pan coefficient, Oct: 2.1 is above 2.' });
		expect(planSettingsPaste('A-pan evaporation\t-5', rows)).toEqual({ error: 'A-pan evaporation, Oct: -5 mm is below 0 mm.' });
	});

	it('a bare row pasted into a month fills from there', () => {
		const rows = monthlySettingRows(settings(), true);
		const p = plan(planSettingsPaste('0.8\t0.8\t0.8', rows, { row: 1, col: 9 }));
		expect(p.changes.map((c) => [c.rowId, c.column])).toEqual([
			['panCoefficient', 'Jul'],
			['panCoefficient', 'Aug'],
			['panCoefficient', 'Sep']
		]);
	});

	it('its CSV pastes back as no change', () => {
		const rows = monthlySettingRows(settings(), true);
		const csv = monthlySettingsCsv(rows);
		expect(csv.split('\r\n').slice(0, 3)).toEqual([
			'Parameter,Unit,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep',
			'A-pan evaporation,mm,150,160,170,180,170,150,110,80,60,60,90,120',
			'Pan coefficient,× A-pan,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7'
		]);
		const p = plan(planSettingsPaste(csv, rows));
		expect(p.changes).toEqual([]);
		expect(p.unchanged).toBe(24);
	});

	it('its Expected format example reads, both rows matched', () => {
		const p = plan(planSettingsPaste(MONTHLY_SETTINGS_FORMAT.example, monthlySettingRows(settings(), true)));
		expect(p.notes).toEqual(['Matched 2 rows by name.']);
		expect(p.changes.length + p.unchanged).toBe(24);
	});
});

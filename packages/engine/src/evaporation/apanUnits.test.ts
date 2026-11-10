// A unit id that is a prototype key ("__proto__") stays a plain entry of the
// per-unit A-pan rows (CodeQL js/remote-property-injection): the rows come
// from a project's settings, so a node id is user-provided.
import { describe, expect, it } from 'vitest';
import { resolveApanUnits, scaleApanUnits, type ApanUnitsSettings } from './apanUnits';

const ROW = [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110];
const unit = (id: string) => ({ id, name: id, kind: 'farm' as const, areaKm2: 5 });

describe('per-unit A-pan rows keep a prototype-key unit id as a plain entry', () => {
	it('resolveApanUnits', () => {
		const raw = JSON.parse(`{"dataset":"Atlas-Apan-2007","source":"test","units":{"A":${JSON.stringify(ROW)},"__proto__":${JSON.stringify(ROW.map((v) => v * 2))}}}`);
		const r = resolveApanUnits({ apanBasis: 'units', apanUnits: raw }, [unit('A'), unit('__proto__')], false, [])!;
		expect(r).not.toBeNull();
		const units = r.setting.units;
		expect(Object.getPrototypeOf(units)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(units, '__proto__')).toBe(true);
		expect(Object.getOwnPropertyDescriptor(units, '__proto__')!.value).toEqual(ROW.map((v) => v * 2));
		expect(units.A).toEqual(ROW);
	});

	it('scaleApanUnits', () => {
		const raw = JSON.parse(`{"dataset":"Atlas-Apan-2007","source":"test","units":{"A":${JSON.stringify(ROW)},"__proto__":${JSON.stringify(ROW)}}}`) as ApanUnitsSettings;
		const out = scaleApanUnits(raw, ROW, ROW.map((v) => v * 2));
		expect('setting' in out).toBe(true);
		const units = (out as { setting: ApanUnitsSettings }).setting.units;
		expect(Object.getPrototypeOf(units)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(units, '__proto__')!.value).toEqual(ROW.map((v) => v * 2));
		expect(units.A).toEqual(ROW.map((v) => v * 2));
	});
});

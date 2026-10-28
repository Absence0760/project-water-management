import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, WARNING_CODES, type ProjectSettings, type WarningCode } from '@water-management/engine';
import { CODE_FIXES, codeFix, uncodedFix } from './fixes';

/** Every .svelte file under src/lib/components, for the field ids the fixes land on. */
function componentSources(): string {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith('.svelte')) out.push(readFileSync(p, 'utf8'));
		}
	};
	walk(join(__dirname, '..'));
	return out.join('\n');
}

describe('CODE_FIXES: every run warning code has a fix', () => {
	const codes = Object.keys(WARNING_CODES) as WarningCode[];
	const sources = componentSources();

	it.each(codes)('%s: a plain line and an action', (code) => {
		const fix = CODE_FIXES[code];
		expect(fix, `${code} has no fix in warnings/fixes.ts`).toBeDefined();
		expect(fix.how.length).toBeGreaterThan(20);
		expect(fix.how).toMatch(/[.!]$/);
		expect(fix.action.label).not.toBe('');
		if (fix.action.kind === 'field') {
			// The exact field: its id is drawn by a component (a panel id only where the field is the panel).
			const m = /^\?tab=(settings|calibration)&field=([a-z0-9-]+)$/.exec(fix.action.href);
			expect(m, fix.action.href).not.toBeNull();
			expect(sources.includes(`id="${m![2]}"`), `no component draws id="${m![2]}"`).toBe(true);
		}
		if (fix.action.kind === 'filter') expect(fix.action.href).toMatch(/^\?tab=warnings&source=checks&status=open&check=[a-z]+$/);
		if (fix.action.kind === 'link') expect(fix.action.href).toMatch(/^\?tab=[a-z]+/);
	});

	it('has no entry for a code the engine doesn’t have', () => {
		expect(Object.keys(CODE_FIXES).sort()).toEqual([...codes].sort());
		expect(codeFix('not.a.code')).toBeNull();
	});

	it('a setting fix writes the setting it reads back as applied, and keeps the rest of the setting', () => {
		const base = defaultProjectSettings();
		const asRecorded = { ...base, zeroRainRuns: { ...base.zeroRainRuns, mode: 'asRecorded', accumulationMode: 'asRecorded', keepDry: [{ waterYear: 2020, reason: 'x' }] } } as ProjectSettings;
		for (const code of ['rain.zeroRun.asRecorded', 'rain.accumulation.asRecorded', 'rain.station.zeroRun.asRecorded', 'rain.unitGauge.accumulation.asRecorded'] as const) {
			const a = CODE_FIXES[code].action;
			expect(a.kind).toBe('setting');
			if (a.kind !== 'setting') continue;
			expect(a.applied(asRecorded, {})).toBe(false);
			const after = { ...asRecorded, ...a.patch(asRecorded, {}) } as ProjectSettings;
			expect(a.applied(after, {})).toBe(true);
			expect(after.zeroRainRuns.keepDry).toEqual([{ waterYear: 2020, reason: 'x' }]);
		}
		const bad = { ...base, rainStations: { unreliable: { s1: [['2020-02-01', '2020-01-01'], ['2020-03-01', '2020-03-05']] } } } as unknown as ProjectSettings;
		const drop = CODE_FIXES['rain.station.unreliableInvalid'].action;
		if (drop.kind !== 'setting') throw new Error('expected a setting fix');
		expect(drop.applied(bad, { station: 's1' })).toBe(false);
		const fixed = { ...bad, ...drop.patch(bad, { station: 's1' }) } as ProjectSettings;
		expect(fixed.rainStations?.unreliable).toEqual({ s1: [['2020-03-01', '2020-03-05']] });
		expect(drop.applied(fixed, { station: 's1' })).toBe(true);
	});
});

describe('uncodedFix', () => {
	it('maps an uncoded warning by its words, else to the guide', () => {
		expect(uncodedFix('2 dams have no full-supply area, so dam evaporation uses an estimate', '/help/x').action).toMatchObject({ href: '?tab=network' });
		expect(uncodedFix('Hydrological signatures (provisional limits): …', '/help/x').action).toMatchObject({ href: '?tab=calibration#res-plausibility' });
		expect(uncodedFix('Something nobody wrote a rule for', '/help/x').action).toEqual({ kind: 'link', label: 'How to read run warnings', href: '/help/x' });
	});
});

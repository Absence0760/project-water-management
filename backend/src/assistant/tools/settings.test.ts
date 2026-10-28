// get_settings's view (issue #610): model inputs only, picked by name, and no signer's name.
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../../projects/settings.js';
import { MODEL_INPUT, NOT_MODEL_INPUT, settingsView } from './settings.js';

describe('settingsView', () => {
	const stored = { gr4j: { x1: 300 }, responsibleAuthority: { name: 'Some CMA', kind: 'cma', office: 'An office' }, autoRun: { enabled: true }, calibrationStart: '2010-10-01' };

	it("merges the project's settings over the defaults and leaves out what is no model input", () => {
		const { settings } = settingsView(stored, undefined, true);
		expect(settings.gr4j).toMatchObject({ x1: 300 });
		expect(settings.apanMm).toHaveLength(12);
		for (const k of ['responsibleAuthority', 'autoRun', 'outcomes', 'outlook', 'ewrHeadline']) expect(settings[k]).toBeUndefined();
		expect(JSON.stringify(settings)).not.toContain('Some CMA');
	});

	it("a run's snapshot as it is, and only the keys asked for, naming the unknown ones", () => {
		expect(settingsView(stored, ['calibrationStart', 'noSuchKey'], false)).toEqual({ settings: { calibrationStart: '2010-10-01' }, unknownKeys: ['noSuchKey'] });
		expect(settingsView({ runoffModel: 'legacy' }, undefined, false).settings).toEqual({ runoffModel: 'legacy' });
	});

	it('sends whether the calibration rules are signed off, and when, never the name typed to sign them (both sources)', () => {
		const rules = { ...(mergeSettings({}) as unknown as { calibrationRules: object }).calibrationRules, signedOff: { by: 'Synthetic Signer', on: '2026-09-29' } };
		for (const merge of [true, false]) {
			const { settings } = settingsView({ calibrationRules: rules }, undefined, merge);
			expect(settings.calibrationRules).toMatchObject({ signedOff: { signed: true, on: '2026-09-29' } });
			expect(JSON.stringify(settings)).not.toContain('Synthetic Signer');
		}
		// Positive control on the shape: a draft says it isn't signed.
		expect(settingsView({}, ['calibrationRules'], true).settings.calibrationRules).toMatchObject({ signedOff: { signed: false } });
	});

	it('leaves out a stored key it doesn’t list, so a setting added later is sent only once it is listed', () => {
		const { settings } = settingsView({ someLaterSetting: { owner: 'A Person' }, gr4j: { x1: 1 } }, undefined, false);
		expect(settings).toEqual({ gr4j: expect.anything() });
		expect(settingsView({ someLaterSetting: 1 }, ['someLaterSetting'], false).unknownKeys).toEqual(['someLaterSetting']);
	});

	it('lists every key of the engine’s settings as a model input or not one', () => {
		const listed = new Set<string>([...MODEL_INPUT, ...NOT_MODEL_INPUT]);
		expect(Object.keys(mergeSettings({}) as object).filter((k) => !listed.has(k))).toEqual([]);
	});
});

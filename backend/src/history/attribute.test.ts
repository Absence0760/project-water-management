import type { InputChange } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { attributeChanges } from './attribute.js';

const line = (text: string, over: Partial<InputChange> = {}): InputChange => ({ area: 'network', kind: 'changed', subject: 'Rooikloof', text, ...over });

describe('attributeChanges', () => {
	it('credits the revision whose line is the diff line itself', () => {
		const added = line('Crop "Apples" added to Rooikloof (40 ha)', { area: 'crops', kind: 'added' });
		expect(attributeChanges([added], [{ id: '2', changes: [line('Rooikloof: dam capacity 1 m³ → 2 m³')] }, { id: '1', changes: [added] }])).toEqual(['1']);
	});

	it('credits the newest revision that set the final value when a field changed more than once', () => {
		const diff = line('Rooikloof: dam capacity 600\u202f000 m³ → 750\u202f000 m³');
		const revisions = [
			{ id: '3', changes: [line('Rooikloof: dam capacity 650\u202f000 m³ → 750\u202f000 m³')] },
			{ id: '2', changes: [line('Rooikloof: dam capacity 600\u202f000 m³ → 650\u202f000 m³')] }
		];
		expect(attributeChanges([diff], revisions)).toEqual(['3']);
	});

	it('does not credit a change of another field that ends on the same value', () => {
		const diff = line('Rooikloof: dam capacity 600\u202f000 m³ → 750\u202f000 m³');
		const other = line('Rooikloof: minimum level 500\u202f000 m³ → 750\u202f000 m³');
		expect(attributeChanges([diff], [{ id: '1', changes: [other] }])).toEqual([null]);
	});

	it('does not credit a change of the same field on another subject', () => {
		const diff = line('Rooikloof: dam capacity 600\u202f000 m³ → 750\u202f000 m³');
		const other = line('Bergwater: dam capacity 650\u202f000 m³ → 750\u202f000 m³', { subject: 'Bergwater' });
		expect(attributeChanges([diff], [{ id: '1', changes: [other] }])).toEqual([null]);
	});

	it('keeps the field when the subject has a digit in its name', () => {
		const f = (text: string) => line(text, { subject: 'Farm 2' });
		const diff = f('Farm 2: dam capacity 600\u202f000 m³ → 750\u202f000 m³');
		expect(attributeChanges([diff], [{ id: '1', changes: [f('Farm 2: minimum level 500\u202f000 m³ → 750\u202f000 m³')] }])).toEqual([null]);
		expect(attributeChanges([diff], [{ id: '2', changes: [f('Farm 2: dam capacity 650\u202f000 m³ → 750\u202f000 m³')] }])).toEqual(['2']);
	});

	it('matches a revision saved with comma groups (before D10, issue #76) against today’s figures', () => {
		const diff = line('Rooikloof: dam capacity 600\u202f000 m³ → 1\u202f750\u202f000 m³');
		expect(attributeChanges([diff], [{ id: '1', changes: [line('Rooikloof: dam capacity 650,000 m³ → 1,750,000 m³')] }])).toEqual(['1']);
		expect(attributeChanges([diff], [{ id: '2', changes: [line('Rooikloof: dam capacity 650,000 m³ → 1,750,001 m³')] }])).toEqual([null]);
	});

	it('credits a settings line changed twice', () => {
		const s = (text: string) => line(text, { area: 'settings', subject: 'Calibration rain threshold' });
		expect(attributeChanges([s('Calibration rain threshold: 2 mm → 4 mm')], [{ id: '9', changes: [s('Calibration rain threshold: 3 mm → 4 mm')] }])).toEqual(['9']);
	});

	it('leaves series lines and lines no revision describes unattributed', () => {
		const series = line('Rainfall (catchment) series extended to 2025-04-12 (was 2024-09-30)', { area: 'series', subject: 'Rainfall (catchment)' });
		const unexplained = line('Rooikloof: dam capacity 1 m³ → 2 m³');
		expect(attributeChanges([series, unexplained], [{ id: '1', changes: [series] }])).toEqual([null, null]);
		expect(attributeChanges([unexplained], [])).toEqual([null]);
	});
});

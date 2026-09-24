import { describe, expect, it } from 'vitest';
import { fitModelLabel, paramLabel } from './provenance';

describe('paramLabel', () => {
	it('names each model’s parameters, and falls back to the key', () => {
		expect(paramLabel('gr4j', 'x1')).toMatch(/X1$/);
		expect(paramLabel('legacy', 'a')).toBe('Peak-flow coefficient a');
		expect(paramLabel('gr4j', 'a')).toBe('a');
		expect(paramLabel('nope' as never, 'x1')).toBe('x1');
	});
});

describe('fitModelLabel', () => {
	it('marks a legacy fit as workbook comparison only (audit H1)', () => {
		expect(fitModelLabel('gr4j')).toBe('GR4J');
		expect(fitModelLabel('legacy')).toBe('Legacy (workbook comparison)');
	});
});

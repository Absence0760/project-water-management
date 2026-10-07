import { describe, expect, it } from 'vitest';
import { resolveEwrHeadline } from './ewrHeadlineSettings.js';

describe('resolveEwrHeadline', () => {
	it('is automatic when absent or not a valid choice, as every project was before the choice (issue #444)', () => {
		expect(resolveEwrHeadline({})).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline(null)).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable' } })).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline({ ewrHeadline: 'pragmatic' })).toEqual({ source: 'auto' });
	});
	it('keeps a stored choice', () => {
		const id = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890';
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'pragmatic' } })).toEqual({ source: 'pragmatic' });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable', siteNodeId: null } })).toEqual({ source: 'ruleTable', siteNodeId: null });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable', siteNodeId: id } })).toEqual({ source: 'ruleTable', siteNodeId: id });
	});
});

import { describe, expect, it } from 'vitest';
import { NAMESPACE_URL, projectIds, uuid5 } from './ids';

// Expected ids from Python's uuid.uuid5, as extract_project.py makes them.
describe('ids', () => {
	it('matches Python uuid5 under NAMESPACE_URL', () => {
		expect(uuid5(NAMESPACE_URL, 'https://water-management.local/wbt-import/Synthetic')).toBe('e559fc85-3870-57ea-a1fd-2daf673cb294');
	});

	it('derives node, crop and transfer ids from the project name', () => {
		const uid = projectIds('Synthetic');
		expect(uid('node:Farm A')).toBe('64a335f1-8f6f-5107-876e-cd98d01d2feb');
		expect(uid('crop:Maize')).toBe('3bc8b0d1-e03a-5aa1-9434-5853e011d580');
		expect(uid('transfer:Farm A>Farm B:O')).toBe('7f1a24fe-3e7e-5e35-90f2-7c010362409e');
		// Non-ASCII names hash as UTF-8.
		expect(uid('node:Ünïcödé farm')).toBe('d73cab05-690e-5ebc-8260-d3dea5e57bd0');
	});
});

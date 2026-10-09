import { describe, expect, it } from 'vitest';
import { exampleHref } from './formatHelp';

const decoded = (href: string) => decodeURIComponent(href.slice(href.indexOf(',') + 1));

describe('exampleHref (issue #456)', () => {
	it('is a UTF-8 data URL of the text, a CSV with a byte-order mark for Excel', () => {
		const href = exampleHref({ name: 'x.csv', text: 'date,value\n2025-04-01,1 m³' });
		expect(href.startsWith('data:text/csv;charset=utf-8,')).toBe(true);
		expect(decoded(href)).toBe('﻿date,value\n2025-04-01,1 m³');
	});

	it('leaves other types as they are, with no byte-order mark', () => {
		const href = exampleHref({ name: 'x.geojson', text: '{"type":"Point"}', type: 'application/geo+json' });
		expect(href.startsWith('data:application/geo+json;charset=utf-8,')).toBe(true);
		expect(decoded(href)).toBe('{"type":"Point"}');
	});
});

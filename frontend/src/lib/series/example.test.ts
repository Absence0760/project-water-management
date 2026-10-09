import { describe, expect, it } from 'vitest';
import { exampleHref } from '$lib/components/common/formatHelp';
import { SERIES_EXAMPLE, SERIES_EXAMPLE_FILE } from './example';
import { parseSeriesFile } from './file';

describe('the series upload example (issue #456)', () => {
	it('the lines the note shows are a file the upload takes', () => {
		const p = parseSeriesFile(SERIES_EXAMPLE);
		expect(p).toMatchObject({ startDate: '2025-04-01', endDate: '2025-04-03', rowCount: 2, missingCount: 1 });
		expect(p.values).toEqual([0, 12.4, null]);
	});

	it('the example file reads as a week with three gaps: blank, NA and a negative placeholder', () => {
		const p = parseSeriesFile(SERIES_EXAMPLE_FILE.text);
		expect(p).toMatchObject({ startDate: '2025-04-01', endDate: '2025-04-07', rowCount: 4, missingCount: 3, negativeGaps: 1 });
		expect(p.values).toEqual([0, 12.4, null, 3.6, null, null, 0.8]);
	});

	it('still reads with the byte-order mark the download adds', () => {
		const href = exampleHref(SERIES_EXAMPLE_FILE);
		const text = decodeURIComponent(href.slice(href.indexOf(',') + 1));
		expect(text.startsWith('﻿')).toBe(true);
		expect(parseSeriesFile(text).values).toHaveLength(7);
	});
});

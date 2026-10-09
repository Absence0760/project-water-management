import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertExtractFormat, EXPECTED_EXTRACT_FORMAT } from './client-catchment-fixture';

describe('client-catchment extract format', () => {
	it('accepts an extract stamped with the current format', () => {
		expect(() => assertExtractFormat({ extractFormat: EXPECTED_EXTRACT_FORMAT }, 'data/x')).not.toThrow();
	});

	it('refuses an unstamped (older) extract and says to re-extract', () => {
		expect(() => assertExtractFormat({}, 'data/x')).toThrow(/no extract-format stamp[\s\S]*Re-extract[\s\S]*scripts\/wbt-import\/README\.md/);
	});

	it('refuses an older stamp and a newer one', () => {
		expect(() => assertExtractFormat({ extractFormat: EXPECTED_EXTRACT_FORMAT - 1 }, 'data/x')).toThrow(/Re-extract/);
		expect(() => assertExtractFormat({ extractFormat: EXPECTED_EXTRACT_FORMAT + 1 }, 'data/x')).toThrow(/Re-extract/);
	});

	it("matches the stamp the importers write (the committed synthetic extract)", () => {
		const url = new URL('../../../../scripts/wbt-import/fixtures/synthetic_b023.project.json', import.meta.url);
		const synthetic = JSON.parse(readFileSync(url, 'utf8')) as { extractFormat?: number };
		expect(() => assertExtractFormat(synthetic, 'synthetic')).not.toThrow();
	});
});

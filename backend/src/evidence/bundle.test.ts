// The reproduction bundle's storage helpers (120_pack_bundle; storage.ts):
// its key is the one app_record_pack_bundle derives, its download name is the
// one its README names, and a stored checksum other than the one sent is
// refused before the hash is recorded. The end to end (issue, MinIO, download,
// reproduce) is evidence/packs.db.test.ts.
import { describe, expect, it } from 'vitest';
import { assertStoredChecksum, packBundleFileName, packBundleKey } from '../reports/storage.js';
import { bundleHash } from './bundle.js';

const P = '0000000A-0000-4000-8000-000000000001';
const K = '00000000-0000-4000-8000-0000000000B2';

describe('packBundleKey', () => {
	it('is packs/<project>/<pack>/<sha256>.zip, lower-cased, as the SQL setter builds it', () => {
		expect(packBundleKey(P, K, 'a'.repeat(64))).toBe(`packs/${P.toLowerCase()}/${K.toLowerCase()}/${'a'.repeat(64)}.zip`);
	});

	it('refuses ids that aren’t UUIDs and a hash that isn’t lower-case hex SHA-256', () => {
		expect(() => packBundleKey('../x', K, 'a'.repeat(64))).toThrow(/UUIDs/);
		expect(() => packBundleKey(P, K, 'A'.repeat(64))).toThrow(/SHA-256/);
		expect(() => packBundleKey(P, K, 'a'.repeat(63))).toThrow(/SHA-256/);
	});
});

describe('packBundleFileName', () => {
	it('is pack-<short code>.zip, the name the bundle’s README passes to reproduce:pack', () => {
		expect(packBundleFileName('abcd-ef01-2345')).toBe('pack-abcd-ef01-2345.zip');
		expect(packBundleFileName('ab"cd/../x')).toBe('pack-abcd.zip');
	});
});

describe('assertStoredChecksum', () => {
	const sent = Buffer.from(bundleHash('bundle'), 'hex').toString('base64');
	it('passes the checksum sent (positive control), and refuses another or none', () => {
		expect(() => assertStoredChecksum('k', sent, sent)).not.toThrow();
		expect(() => assertStoredChecksum('k', sent, Buffer.from(bundleHash('other'), 'hex').toString('base64'))).toThrow(/not recorded/);
		expect(() => assertStoredChecksum('k', sent, undefined)).toThrow(/\(none\)/);
	});
});

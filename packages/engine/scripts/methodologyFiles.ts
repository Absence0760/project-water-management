// Reads docs/methodology/v<N>.md and hashes each file's bytes: shared by
// gen-liability.ts and methodology.test.ts, so the test recomputes exactly
// what the generator wrote. Node only (it reads files and uses node:crypto);
// the engine itself never imports it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { methodologyVersionOf, sortMethodologyVersions, type MethodologyVersion } from '../src/liability/methodology';

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export function readMethodologyVersions(dir: string): { versions: MethodologyVersion[]; currentText: string } {
	const versions = sortMethodologyVersions(
		readdirSync(dir).flatMap((file) => {
			const version = methodologyVersionOf(file);
			return version ? [{ version, file, sha256: sha256Hex(readFileSync(join(dir, file))) }] : [];
		})
	);
	const current = versions[versions.length - 1];
	if (!current) throw new Error(`${dir} has no v<N>.md`);
	return { versions, currentText: readFileSync(join(dir, current.file), 'utf8') };
}

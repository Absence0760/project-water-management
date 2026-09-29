// CloudFront signed URLs with a canned policy (issue #126; docs/security.md §
// Reports). Production serves report PDFs through the site's own CloudFront
// distribution (/reports/*, an OAC-protected origin on the private reports
// bucket, behind the WAF; infra/reports.tf), and CloudFront serves a request
// there only when it carries a valid signature from a key in the
// distribution's trusted key group.
//
// The canned policy is the smallest form: one exact URL (query included, so
// the download file name can't be altered) and an expiry. It is signed with
// RSA-SHA256 and says so (Hash-Algorithm=SHA256); CloudFront defaults to
// SHA-1 without that parameter. The format is AWS's "Create a signed URL
// using a canned policy":
//
//   <url>?<query>&Expires=<epoch s>&Signature=<b64url>&Key-Pair-Id=<id>&Hash-Algorithm=SHA256
//
// node:crypto only: no SDK, nothing to bundle, and signing makes no request.
import { createPublicKey, createSign, createVerify } from 'node:crypto';

export const HASH_ALGORITHM = 'SHA256';

export interface CloudFrontSigner {
	/** The CloudFront public key's id (Key-Pair-Id), e.g. K2JCJMDEHXQW5F. */
	keyPairId: string;
	/** The matching RSA private key, PEM. */
	privateKey: string;
}

/**
 * Refuse a private key that isn't the other half of `publicKey`. The API's
 * private key comes from sops (its runtime secret) and the public key from
 * Terraform's input (CloudFront's trusted key group, and CLOUDFRONT_PUBLIC_KEY
 * in the API's environment); nothing at plan time can compare them without
 * holding the private key, so the API does at cold start. A mismatch would
 * sign every download link with a key CloudFront rejects (403).
 *
 * Compares the public halves and proves it by signing a probe the public key
 * must verify. Errors say what is wrong, never quote a key.
 */
export function assertKeyPair(privateKey: string, publicKey: string): void {
	let derived: Buffer, expected: Buffer;
	try {
		derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
	} catch {
		throw new Error('CLOUDFRONT_PRIVATE_KEY is not a readable private key');
	}
	try {
		expected = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
	} catch {
		throw new Error('CLOUDFRONT_PUBLIC_KEY is not a readable public key');
	}
	const probe = cannedPolicy('https://key-pair.check/', 1);
	const signature = createSign('RSA-SHA256').update(probe).sign(privateKey);
	if (!derived.equals(expected) || !createVerify('RSA-SHA256').update(probe).verify(publicKey, signature)) {
		throw new Error('CLOUDFRONT_PRIVATE_KEY is not the private half of CLOUDFRONT_PUBLIC_KEY: report_download_signing_key and cloudfront_private_key in sops disagree (docs/deployment.md § Rotating a secret)');
	}
}

/** The canned policy for `url` until `expires` (epoch seconds): exact JSON, no whitespace, as CloudFront rebuilds it. */
export function cannedPolicy(url: string, expires: number): string {
	return JSON.stringify({ Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] });
}

/** CloudFront's URL-safe base64: + → -, = → _, / → ~. */
export const cloudFrontBase64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

/**
 * `url` signed to be fetched through CloudFront until `expires` (epoch
 * seconds). `url` is the exact URL the browser will request: https, the
 * distribution's host, any query already on it. Its path must not hold `*`
 * or `?` (CloudFront reads them as wildcards), which a report key never does.
 */
export function signCloudFrontUrl(url: string, expires: number, signer: CloudFrontSigner): string {
	const parsed = URL.parse(url);
	if (!parsed || parsed.protocol !== 'https:') throw new Error('signCloudFrontUrl: the URL must be https');
	if (parsed.pathname.includes('*')) throw new Error('signCloudFrontUrl: the path must not contain a wildcard');
	for (const reserved of ['Expires', 'Signature', 'Key-Pair-Id', 'Hash-Algorithm', 'Policy']) {
		if (parsed.searchParams.has(reserved)) throw new Error(`signCloudFrontUrl: the URL already has CloudFront's ${reserved} parameter`);
	}
	if (!Number.isInteger(expires) || expires <= 0) throw new Error('signCloudFrontUrl: expires must be epoch seconds');
	if (!/^[A-Z0-9]{8,}$/.test(signer.keyPairId)) throw new Error('signCloudFrontUrl: not a CloudFront public key id');
	const signature = cloudFrontBase64(createSign('RSA-SHA256').update(cannedPolicy(url, expires)).sign(signer.privateKey));
	const sep = url.includes('?') ? '&' : '?';
	return `${url}${sep}Expires=${expires}&Signature=${signature}&Key-Pair-Id=${signer.keyPairId}&Hash-Algorithm=${HASH_ALGORITHM}`;
}

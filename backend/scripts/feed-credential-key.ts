// A new X25519 key pair for station API feeds' credentials (issue #784;
// src/feeds/credential.ts, docs/deployment.md § Station API feeds).
//
//   pnpm gen:feed-credential-key
//
// Prints both halves, base64url, and writes nothing: the operator runs it on
// their own machine, puts the private half in infra-secrets
// (water-management/prod.sops.yaml, key feed_credential_private_key: the
// fetcher's runtime secret) and the public half in prod.tfvars
// (feed_credential_public_key), then clears the terminal. Never run it where
// the output is recorded (a CI log, an agent's transcript): the private half
// opens every station key saved under its public half.
//
// No DB, no network, no AWS. Local dev needs none of this: backend/.env.development
// commits a dev-only pair, which production refuses (config/production.ts).
import { generateFeedCredentialKeys } from '../src/feeds/credential.js';

/** What the command prints for `keys`: each half on its own line, under the setting it goes into. */
export function feedCredentialKeyText(keys: { publicKey: string; privateKey: string }): string {
	return [
		'# Station API feeds: a new X25519 key pair (docs/deployment.md § Station API feeds).',
		'# Public half: prod.tfvars (not a secret).',
		`feed_credential_public_key = "${keys.publicKey}"`,
		'# Private half: infra-secrets water-management/prod.sops.yaml only. Never commit it, paste it in a chat or keep this output.',
		`feed_credential_private_key: "${keys.privateKey}"`,
		''
	].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(feedCredentialKeyText(generateFeedCredentialKeys()));

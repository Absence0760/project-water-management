// Read one Secrets Manager secret's string (docs/security.md § Runtime secrets).
//
// The AWS SDK v3 ships inside the nodejs24.x runtime; importing it through a
// variable keeps esbuild from bundling it and tsc from needing its types (no
// dependency in backend/package.json). Every Lambda that reads a secret uses
// this: the migrate Lambda for the RDS master credentials, and the API, worker
// and migrate Lambdas for their runtime secrets (config/runtimeSecrets.ts).
// It is its own module so tests can stand in for it without the SDK.

/** The secret's string: the version given, or the current one. The caller parses it. */
export async function getSecretString(secretId: string, versionId?: string): Promise<string> {
	const sdk = '@aws-sdk/client-secrets-manager';
	const { SecretsManagerClient, GetSecretValueCommand } = await import(sdk);
	const client = new SecretsManagerClient({});
	const out = await client.send(new GetSecretValueCommand({ SecretId: secretId, ...(versionId ? { VersionId: versionId } : {}) }));
	if (typeof out.SecretString !== 'string') throw new Error('the secret has no string value');
	return out.SecretString;
}

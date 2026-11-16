// The runtime-secret loader (config/runtimeSecrets.ts): reads each Lambda's
// secret once, fails closed, and never lets a value into an error or a log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES, SETTINGS } from './production.js';
import { loadRuntimeSecrets, RUNTIME_SECRETS, RuntimeSecretError, runtimeSecretKeys } from './runtimeSecrets.js';

const ARN = 'arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AbCdEf';
const VALUES = {
	AUTH_JWT_SECRET: 'jwt-value-that-must-never-be-printed-0000000',
	DATABASE_URL: 'postgresql://water_app:pw-that-must-never-be-printed@db.example.org:5432/water?sslmode=verify-full',
	CLOUDFRONT_SHARED_SECRET: 'edge-value-that-must-never-be-printed-00000',
	CLOUDFRONT_PRIVATE_KEY: 'signing-key-that-must-never-be-printed-000000',
	APP_ENCRYPTION_KEY: 'sealing-key-that-must-never-be-printed-00000'
};
const lambdaEnv = (patch: Record<string, string | undefined> = {}) => ({
	AWS_LAMBDA_FUNCTION_NAME: 'water-management-backend',
	RUNTIME_SECRET_ARN: ARN,
	RUNTIME_SECRET_VERSION: 'v-1',
	...patch
});
const serve = (body: unknown) => vi.fn(async (_id: string, _version?: string) => (typeof body === 'string' ? body : JSON.stringify(body)));

/** The error a load throws, checked to name no secret value. */
async function refusal(env: Record<string, string | undefined>, fetch: (id: string, version?: string) => Promise<string>): Promise<RuntimeSecretError> {
	const err = await loadRuntimeSecrets('api', env, fetch).then(
		() => null,
		(e: unknown) => e
	);
	expect(err).toBeInstanceOf(RuntimeSecretError);
	const text = `${(err as Error).message}\n${(err as Error).stack}`;
	for (const v of Object.values(VALUES)) expect(text).not.toContain(v);
	expect(text).not.toContain('must-never-be-printed');
	return err as RuntimeSecretError;
}

afterEach(() => vi.restoreAllMocks());

describe('loadRuntimeSecrets', () => {
	it('reads the pinned version once and puts exactly its keys in the environment (positive control)', async () => {
		const env: Record<string, string | undefined> = lambdaEnv();
		const fetch = serve(VALUES);
		await loadRuntimeSecrets('api', env, fetch);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(ARN, 'v-1');
		expect(env).toMatchObject(VALUES);
	});

	it('without a version it reads the current one', async () => {
		const fetch = serve(VALUES);
		await loadRuntimeSecrets('api', lambdaEnv({ RUNTIME_SECRET_VERSION: undefined }), fetch);
		expect(fetch).toHaveBeenCalledWith(ARN, undefined);
	});

	it('off Lambda (local dev, tests) it does nothing: .env.development supplies the values', async () => {
		const env: Record<string, string | undefined> = { RUNTIME_SECRET_ARN: ARN };
		const fetch = serve(VALUES);
		await loadRuntimeSecrets('api', env, fetch);
		expect(fetch).not.toHaveBeenCalled();
		expect(env.AUTH_JWT_SECRET).toBeUndefined();
	});

	it('a Lambda with no secrets reads nothing: the renderer, and the fetcher while station API feeds are off', async () => {
		const fetch = serve({});
		await loadRuntimeSecrets('renderer', lambdaEnv(), fetch);
		for (const v of [undefined, '', 'off']) await loadRuntimeSecrets('fetcher', lambdaEnv({ STATION_API_FEEDS: v, RUNTIME_SECRET_ARN: undefined }), fetch);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('the fetcher reads its private key only with STATION_API_FEEDS=on, and then fails closed like any role', async () => {
		const key = { FEED_CREDENTIAL_PRIVATE_KEY: 'feed-key-that-must-never-be-printed-000000' };
		const env: Record<string, string | undefined> = lambdaEnv({ STATION_API_FEEDS: 'on' });
		const fetch = serve(key);
		await loadRuntimeSecrets('fetcher', env, fetch);
		expect(fetch).toHaveBeenCalledWith(ARN, 'v-1');
		expect(env.FEED_CREDENTIAL_PRIVATE_KEY).toBe(key.FEED_CREDENTIAL_PRIVATE_KEY);
		// On, a missing secret refuses to start (never a fetcher that can't open a credential).
		const err = await loadRuntimeSecrets('fetcher', lambdaEnv({ STATION_API_FEEDS: 'on', RUNTIME_SECRET_ARN: undefined }), fetch).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RuntimeSecretError);
		expect((err as Error).message).toMatch(/refusing to start the fetcher Lambda: .*RUNTIME_SECRET_ARN/);
		expect((await loadRuntimeSecrets('fetcher', lambdaEnv({ STATION_API_FEEDS: 'on' }), serve({})).catch((e: unknown) => e)) as Error).toHaveProperty(
			'message',
			expect.stringMatching(/missing keys: FEED_CREDENTIAL_PRIVATE_KEY/)
		);
		expect(runtimeSecretKeys('fetcher', { STATION_API_FEEDS: 'on' })).toEqual(['FEED_CREDENTIAL_PRIVATE_KEY']);
		expect(runtimeSecretKeys('fetcher', {})).toEqual([]);
		expect(runtimeSecretKeys('api', {})).toEqual(RUNTIME_SECRETS.api); // positive control: no switch on the API's keys
	});

	it('refuses a missing key, naming it', async () => {
		const { AUTH_JWT_SECRET: _, ...rest } = VALUES;
		expect((await refusal(lambdaEnv(), serve(rest))).message).toMatch(/missing keys: AUTH_JWT_SECRET/);
		expect((await refusal(lambdaEnv(), serve({ ...VALUES, DATABASE_URL: ' ' }))).message).toMatch(/missing keys: DATABASE_URL/);
		expect((await refusal(lambdaEnv(), serve({ ...VALUES, DATABASE_URL: 42 }))).message).toMatch(/missing keys: DATABASE_URL/);
	});

	it('refuses a key this role must not hold (least privilege), naming the key only', async () => {
		const err = await refusal(lambdaEnv(), serve({ ...VALUES, ALERTS_TOKEN_SECRET: 'alerts-value-that-must-never-be-printed' }));
		expect(err.message).toMatch(/must not have: ALERTS_TOKEN_SECRET/);
		expect(err.message).not.toContain('alerts-value');
	});

	it('refuses text that is not a JSON object, without quoting it', async () => {
		expect((await refusal(lambdaEnv(), serve('pw-that-must-never-be-printed'))).message).toMatch(/is not JSON$/);
		expect((await refusal(lambdaEnv(), serve(['a']))).message).toMatch(/not a JSON object/);
		expect((await refusal(lambdaEnv(), serve('null'))).message).toMatch(/not a JSON object/);
	});

	it('refuses to start without a Secrets Manager ARN', async () => {
		expect((await refusal(lambdaEnv({ RUNTIME_SECRET_ARN: undefined }), serve(VALUES))).message).toMatch(/RUNTIME_SECRET_ARN/);
		expect((await refusal(lambdaEnv({ RUNTIME_SECRET_ARN: 'arn:aws:sqs:af-south-1:0:q' }), serve(VALUES))).message).toMatch(/RUNTIME_SECRET_ARN/);
	});

	it('refuses a secret that is also in the function environment (moved back by mistake)', async () => {
		const fetch = serve(VALUES);
		const err = await refusal(lambdaEnv({ AUTH_JWT_SECRET: VALUES.AUTH_JWT_SECRET }), fetch);
		expect(err.message).toMatch(/in the function's environment.*AUTH_JWT_SECRET/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('a failed read refuses to start, naming the error kind, and keeps the cause for the log', async () => {
		const denied = Object.assign(new Error('User is not authorized to perform: secretsmanager:GetSecretValue'), { name: 'AccessDeniedException' });
		const fetch = vi.fn(async () => {
			throw denied;
		});
		const err = await refusal(lambdaEnv(), fetch);
		expect(err.message).toMatch(/could not be read \(AccessDeniedException\)/);
		expect(err.cause).toBe(denied);
	});

	it('logs nothing, even when it refuses', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
		await loadRuntimeSecrets('api', lambdaEnv(), serve(VALUES));
		await loadRuntimeSecrets('api', lambdaEnv(), serve({ ...VALUES, EXTRA: 'x' })).catch(() => {});
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});
});

describe('RUNTIME_SECRETS', () => {
	it('each key is a classified setting that its role checks in production, so a missing one is also caught by the config check', () => {
		for (const role of ROLES) for (const key of RUNTIME_SECRETS[role]) expect(SETTINGS[key]?.checks?.[role], `${role} ${key}`).toBeDefined();
	});

	it('the edge secret stays with the API and the unsubscribe key with the worker', () => {
		expect(RUNTIME_SECRETS.api).toContain('CLOUDFRONT_SHARED_SECRET');
		expect(RUNTIME_SECRETS.worker).not.toContain('CLOUDFRONT_SHARED_SECRET');
		expect(RUNTIME_SECRETS.worker).toContain('ALERTS_TOKEN_SECRET');
		expect(RUNTIME_SECRETS.api).not.toContain('ALERTS_TOKEN_SECRET');
		expect(RUNTIME_SECRETS.migrate).toEqual(['WATER_APP_PASSWORD']);
	});

	it('only the fetcher holds the key that opens station API credentials: never the worker (it forwards them sealed) or the API (it only seals)', () => {
		expect(RUNTIME_SECRETS.fetcher).toEqual(['FEED_CREDENTIAL_PRIVATE_KEY']);
		for (const role of ROLES.filter((r) => r !== 'fetcher')) expect(RUNTIME_SECRETS[role], role).not.toContain('FEED_CREDENTIAL_PRIVATE_KEY');
	});
});

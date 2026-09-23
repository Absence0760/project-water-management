// Global test setup — populates all the env vars the backend expects,
// so tests run in a configured state without hitting real services.
// Individual tests can use vi.stubEnv() to override or unset specific
// vars for "what happens when X is missing" coverage.

process.env.ALLOWED_ORIGINS = 'http://localhost:7777';
process.env.SITE_URL = 'http://localhost:7777';
process.env.AUTH_JWT_SECRET = 'test-only-jwt-secret-0000000000000000000';
process.env.COOKIE_SECURE = 'false';
// Outgoing email collects in memory (src/mail/transport.ts `outbox`).
process.env.MAIL_TRANSPORT = 'memory';
// DB-backed tests (*.db.test.ts) use the dedicated water_test database; see
// db-global-setup.ts. DEV-ONLY docker credentials.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://water_app:water_app@127.0.0.1:5434/water_test';
process.env.TEST_MIGRATION_DATABASE_URL ??= 'postgresql://water:water@127.0.0.1:5434/water_test';
// Guard: DB tests must never run against a non-test database. Parallel
// checkouts (git worktrees) may use their own water_test_<name> via
// TEST_DATABASE_URL + TEST_MIGRATION_DATABASE_URL; db-global-setup creates it.
if (!/\/water_test(_[a-z0-9_]+)?$/.test(process.env.DATABASE_URL)) throw new Error(`refusing to run tests against ${process.env.DATABASE_URL}`);

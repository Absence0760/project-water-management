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
// DB-backed tests (*.db.test.ts) use a dedicated test database, water_test in
// the main checkout and water_test_w<n> in a git worktree (test-db.ts); see
// db-global-setup.ts. DEV-ONLY docker credentials.
import { APP_URL, OWNER_URL } from './test-db.js';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? APP_URL;
process.env.TEST_MIGRATION_DATABASE_URL ??= OWNER_URL;
// Guard: DB tests must never run against a non-test database.
if (!/\/water_test(_[a-z0-9_]+)?$/.test(process.env.DATABASE_URL)) throw new Error(`refusing to run tests against ${process.env.DATABASE_URL}`);

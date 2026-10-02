// `pnpm dev:db:psql`: psql as the schema owner on this checkout's dev
// database (`water`, or a worktree's water_w<n>; src/config/devEnv.ts).
import { spawnSync } from 'node:child_process';
import { loadDevEnv } from '../src/config/devEnv.js';

loadDevEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
const { status, error } = spawnSync('psql', [url, ...process.argv.slice(2)], { stdio: 'inherit' });
if (error) throw error;
process.exitCode = status ?? 1;

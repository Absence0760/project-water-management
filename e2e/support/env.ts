// Ports and database for the isolated e2e stack. Chosen so a run never
// collides with `pnpm dev` (frontend :7777, backend :3001, database `water`).
// DEV-ONLY docker-compose credentials (docker-compose.yml, dev/postgres).
export const API_PORT = 3101;
export const WEB_PORT = 7801;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

export const E2E_DB = 'water_e2e';
const PG = process.env.E2E_PG_HOST ?? '127.0.0.1:5434';
/** Schema owner: creates the database and runs migrations. */
export const OWNER_ADMIN_URL = `postgresql://water:water@${PG}/water`;
export const OWNER_E2E_URL = `postgresql://water:water@${PG}/${E2E_DB}`;
/** What the backend connects as: RLS-bound, like in dev and prod. */
export const APP_E2E_URL = `postgresql://water_app:water_app@${PG}/${E2E_DB}`;

-- DEV-ONLY. Runs once when the docker volume is first initialised.
--
-- `water` (POSTGRES_USER) owns the schema and runs migrations.
-- `water_app` is what the backend connects as: no superuser, no BYPASSRLS,
-- so every row-level-security policy actually applies to it. In production
-- the equivalent role is created out-of-band with a real secret; the
-- migrations only GRANT to it.
CREATE ROLE water_app LOGIN PASSWORD 'water_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- A second database for the backend's DB-backed test suite, so tests never
-- touch dev data.
CREATE DATABASE water_test OWNER water;

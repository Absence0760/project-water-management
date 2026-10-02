-- 159_erasure_log — a list of what was erased, kept long enough that a
-- database restore can re-apply every erasure made after its restore point
-- (POPIA s14(4)-(5), s24; provisional position, pre-counsel research,
-- 2026-10-01: docs/security.md § Personal information, docs/deployment.md
-- § Restoring the database, step 6a).
--
-- Backups are RDS automated backups, kept 7 to 35 days
-- (infra/variables.tf db_backup_retention_days). A point-in-time restore takes
-- the database back to before an erasure, so a deleted account, project or
-- team would come back into use. The restore runbook keeps the old instance
-- running beside the restored one until its last step, so a table on the
-- old instance is readable while the restore is checked: this one. It covers
-- both deletion paths for an account (the operator's SQL and DELETE /auth/me,
-- which logs no name or address) because a trigger writes it, not a route.
--
--  1. erasure_log (kind, subject_id, erased_at): the internal id only, never
--     a name, an email or anything else about what was deleted. No foreign
--     keys, so the row outlives what it names. RLS on, no policies, no grant
--     to water_app: only the schema owner reads it (the operator, during a
--     restore) and only the definer functions below write or purge it
--     (catalogue.db.test.ts OWNER_ONLY).
--  2. erasure_log_record(): AFTER DELETE on app_user, project and team, one
--     row each. Everything else an erasure removes goes by a cascade from one
--     of these three rows, so a restore re-applies it by deleting the same
--     row again. (Deleting a team leaves its projects, project.team_id being
--     SET NULL; each deleted project is logged on its own.)
--  3. app_purge_erasure_log(p_age): the job tick deletes entries older than
--     40 days (jobs/runner.ts ERASURE_LOG_RETENTION_DAYS), above the 35-day
--     maximum backup, so every backup a restore can use is covered; never
--     under 36 days (the function refuses), and from the worker's context
--     only (051's alert_worker_context). The id of a deleted account lasts
--     those 40 days here, like the random id the pseudonymised audit log
--     keeps (personal-data.security.db.test.ts RETAINED_AFTER_DELETION).
--
-- Revocations (a member removed, a farm unlinked, a share link or API key
-- revoked, an invite withdrawn) are already in the old instance's audit log
-- (audit_event), which the runbook reads the same way.

CREATE TABLE erasure_log (
	id         bigserial PRIMARY KEY,
	kind       text NOT NULL CHECK (kind IN ('account', 'project', 'team')),
	subject_id uuid NOT NULL,
	erased_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE erasure_log IS
	'What was erased (an account, project or team, by internal id only), so a restore can re-apply erasures made after its restore point (159). Owner-only; purged after 40 days, above the 35-day backup maximum.';
CREATE INDEX erasure_log_erased_at_idx ON erasure_log (erased_at);

ALTER TABLE erasure_log ENABLE ROW LEVEL SECURITY;
-- No policies and no grant: water_app can neither read nor write it.
REVOKE ALL ON erasure_log FROM PUBLIC, water_app;
REVOKE ALL ON SEQUENCE erasure_log_id_seq FROM PUBLIC, water_app;

CREATE FUNCTION erasure_log_record() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO erasure_log (kind, subject_id) VALUES (TG_ARGV[0], OLD.id);
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION erasure_log_record() FROM PUBLIC, water_app;

CREATE TRIGGER app_user_erasure_log AFTER DELETE ON app_user
	FOR EACH ROW EXECUTE FUNCTION erasure_log_record('account');
CREATE TRIGGER project_erasure_log AFTER DELETE ON project
	FOR EACH ROW EXECUTE FUNCTION erasure_log_record('project');
CREATE TRIGGER team_erasure_log AFTER DELETE ON team
	FOR EACH ROW EXECUTE FUNCTION erasure_log_record('team');

CREATE FUNCTION app_purge_erasure_log(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_count integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges the erasure log' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Above the longest backup (35 days): an entry must outlive every backup a restore can start from.
		IF p_age IS NULL OR p_age < interval '36 days' THEN
			RAISE EXCEPTION 'keep erasures at least 36 days, longer than any backup' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM erasure_log WHERE erased_at < now() - p_age;
		GET DIAGNOSTICS v_count = ROW_COUNT;
		RETURN v_count;
	END
	$$;
REVOKE ALL ON FUNCTION app_purge_erasure_log(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_erasure_log(interval) TO water_app;

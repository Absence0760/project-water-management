-- 148_job_purge_clears_links — the 30-day job clean-up (app_purge_jobs,
-- 016_jobs.sql, run by every tick) failed once any sweep's or outlook's job
-- was older than 30 days. job_id on scenario_sweep (062) and
-- seasonal_outlook (063) is ON DELETE SET NULL, and the foreign key's update
-- went through the complete-once guard: on a complete row it refused any
-- update at all ("completed once and never changed"), and on a pending row
-- (its job dead) it refused an update not by whoever asked (the purge runs
-- with no user). So the whole DELETE rolled back, and from then on no job of
-- any project was ever cleaned up.
--
-- Both guards, from their latest definitions (066_account_fk_clears.sql), now
-- let through an update that only clears links: who asked (an account going,
-- 066) and the job (the purge), each either unchanged or going to NULL, and
-- every other column unchanged. auto_calibration_update (108) already did
-- this for its job_id. water_app can't write created_by or job_id on either
-- table (its grants are the outcome columns only, catalogue.db.test.ts), so
-- only a foreign key (or the schema owner) makes such an update; a real
-- change to the outcome still meets the guard.
--
-- report and yield_result also hold an ON DELETE SET NULL job_id, but have no
-- UPDATE trigger. catalogue.db.test.ts JOB_REFERENCES lists every foreign key
-- to job with the test that proves the purge clears it.

CREATE OR REPLACE FUNCTION scenario_sweep_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- A foreign key clearing a link: an account going clears who asked, the job purge the job. Nothing else changes.
		IF to_jsonb(NEW) - '{created_by,job_id}'::text[] = to_jsonb(OLD) - '{created_by,job_id}'::text[]
			AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
			AND (NEW.job_id IS NULL OR NEW.job_id = OLD.job_id)
			AND (NEW.created_by, NEW.job_id) IS DISTINCT FROM (OLD.created_by, OLD.job_id) THEN
			RETURN NEW;
		END IF;
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'a sweep is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for a sweep can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending sweep can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM scenario_sweep_member m WHERE m.sweep_id = OLD.id AND m.status = 'pending') THEN
			RAISE EXCEPTION 'every member of a sweep needs an outcome before it is complete' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION seasonal_outlook_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- A foreign key clearing a link: an account going clears who asked, the job purge the job. Nothing else changes.
		IF to_jsonb(NEW) - '{created_by,job_id}'::text[] = to_jsonb(OLD) - '{created_by,job_id}'::text[]
			AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
			AND (NEW.job_id IS NULL OR NEW.job_id = OLD.job_id)
			AND (NEW.created_by, NEW.job_id) IS DISTINCT FROM (OLD.created_by, OLD.job_id) THEN
			RETURN NEW;
		END IF;
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an outlook is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an outlook can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending outlook can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- 069_cross_project_refs — the two references between project-scoped
-- tables that had no same-project check, found by
-- db/cross-project-refs.security.db.test.ts (a sweep of every foreign key
-- onto a table with a project_id, from pg_constraint; docs/security.md §
-- Authorization, "Same-project references").
--
--   1. model_revision.restored_from (030) is a bigint foreign key to another
--      revision, and nothing held it to the row's project. A foreign key is
--      checked without RLS, and revision ids are sequential, so any editor of
--      any project could record a "restore" of another project's revision by
--      guessing its id: a false history line, and, because the key is NO
--      ACTION, that project could then no longer be deleted (its revisions
--      cascade, and the planted row still points at one). restored_from_run
--      (no foreign key on purpose: the run may be trimmed later) now must
--      also name a run of the row's project when it is written; the history
--      routes only ever write both from rows they found in the project.
--      model_revision is append-only (water_app has no UPDATE), so the check
--      runs on INSERT.
--
--   2. alert_event.run_id (051): alert_event_guard checked the rule on
--      INSERT but not the run the event cites, so an editor of two projects
--      could file an alert of one citing a run of the other. From its only
--      definition (051), with that check added; an UPDATE may still only
--      clear run_id (the foreign key's ON DELETE SET NULL), never set it.

CREATE FUNCTION model_revision_same_project() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.restored_from IS NOT NULL
			AND (SELECT project_id FROM model_revision WHERE id = NEW.restored_from) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'revision % belongs to a different project', NEW.restored_from USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.restored_from_run IS NOT NULL
			AND (SELECT project_id FROM model_run WHERE id = NEW.restored_from_run) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.restored_from_run USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER model_revision_same_project BEFORE INSERT ON model_revision
	FOR EACH ROW EXECUTE FUNCTION model_revision_same_project();

CREATE OR REPLACE FUNCTION alert_event_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		r alert_rule;
	BEGIN
		IF TG_OP = 'INSERT' THEN
			SELECT * INTO r FROM alert_rule WHERE id = NEW.rule_id;
			IF r.id IS NULL OR r.project_id IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'rule % belongs to a different project', NEW.rule_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF NEW.run_id IS NOT NULL AND (SELECT project_id FROM model_run WHERE id = NEW.run_id) IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			NEW.kind := r.kind;
			NEW.node_id := r.node_id;
			NEW.opened_at := now();
			NEW.cleared_at := CASE WHEN NEW.state = 'cleared' THEN now() END;
			RETURN NEW;
		END IF;
		IF NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id
			OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL THEN
			RAISE EXCEPTION 'only an alert event''s state, value and detail change' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.state = 'cleared' AND NEW.state = 'firing' THEN
			RAISE EXCEPTION 'a cleared alert event never fires again' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.state = 'firing' AND NEW.state = 'cleared' THEN
			NEW.cleared_at := now();
		ELSIF NEW.state = OLD.state THEN
			NEW.cleared_at := OLD.cleared_at;
		END IF;
		RETURN NEW;
	END
	$$;

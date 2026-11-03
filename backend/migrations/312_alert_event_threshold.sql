-- 312_alert_event_threshold — the level an alert event crossed (issue #670).
--
-- An alert mail and the alert pages quoted the rule's level as it is now,
-- read from alert_rule when the mail was built or the page drawn. A WUA that
-- edited the level between the event firing and the mail going out (the
-- send runs on the next tick, a digest at 06:00) got a mail that contradicts
-- itself: "your dam is about 28 %, below the alert level of 20 %", when the
-- dam crossed 30 %. The same on the event list for as long as the event is
-- kept.
--
-- alert_event.threshold now records the level the event crossed. The guard
-- copies it from the rule on INSERT, beside the kind and the farm (the
-- evaluator inserts in the same transaction that read the rule, so it is the
-- level the crossing was judged against), and an UPDATE may never change it.
-- The kind fixes the rest of the crossing's description: which way it
-- crosses and its unit (alerts/rules.ts fires(); a dam fraction, days,
-- failures, jobs or farms).
--
-- Expand only: the events opened before this migration keep NULL, and the
-- readers fall back to the rule's level for them (COALESCE(e.threshold,
-- r.threshold)), which is what they showed before. Nothing is backfilled:
-- the rule's level now is no better a guess for an old event than the
-- fallback already gives.
--
-- Grants: water_app's INSERT on alert_event is table-wide (051), and the
-- guard overwrites whatever it sends; its UPDATE is a column grant
-- (state, cleared_at, value, detail), which this column stays out of, so the
-- catalogue test's list is unchanged. The policies are row policies and
-- cover the new column as they are. From the latest alert_event_guard (069),
-- with the threshold copied on INSERT and held on UPDATE.

ALTER TABLE alert_event ADD COLUMN threshold double precision;

COMMENT ON COLUMN alert_event.threshold IS
	'The rule''s level when the event opened (312, issue #670): what the mail and the pages quote. NULL for an event opened before 312; readers fall back to alert_rule.threshold.';

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
			NEW.threshold := r.threshold;
			NEW.opened_at := now();
			NEW.cleared_at := CASE WHEN NEW.state = 'cleared' THEN now() END;
			RETURN NEW;
		END IF;
		IF NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id
			OR NEW.threshold IS DISTINCT FROM OLD.threshold
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

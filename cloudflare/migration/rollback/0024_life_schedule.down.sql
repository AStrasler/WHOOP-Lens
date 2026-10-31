-- Disable LIFE_SCHEDULE_ENABLED and release compatible code before rollback.
-- Deletes only this explicitly selected preference; fallback remains unpredictable.
DROP TABLE IF EXISTS member_life_schedule;

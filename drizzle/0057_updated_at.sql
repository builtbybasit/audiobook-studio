ALTER TABLE `characters` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `voices` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A speaker's real change of anything a script file carries stamps it, so an import between two installs
-- can tell whose is newer. A write that sets updated_at itself (an import carrying the file's) keeps it.
CREATE TRIGGER `characters_touch` AFTER UPDATE OF `aliases`, `gender`, `age`, `voice_type`, `description`, `profile`, `voice`, `style`, `speed`, `effect`, `thoughts`, `persona_of`, `masked`, `wiki`, `edited` ON `characters`
WHEN NEW.`updated_at` IS OLD.`updated_at` AND (
  NEW.`aliases` IS NOT OLD.`aliases`
  OR NEW.`gender` IS NOT OLD.`gender`
  OR NEW.`age` IS NOT OLD.`age`
  OR NEW.`voice_type` IS NOT OLD.`voice_type`
  OR NEW.`description` IS NOT OLD.`description`
  OR NEW.`profile` IS NOT OLD.`profile`
  OR NEW.`voice` IS NOT OLD.`voice`
  OR NEW.`style` IS NOT OLD.`style`
  OR NEW.`speed` IS NOT OLD.`speed`
  OR NEW.`effect` IS NOT OLD.`effect`
  OR NEW.`thoughts` IS NOT OLD.`thoughts`
  OR NEW.`persona_of` IS NOT OLD.`persona_of`
  OR NEW.`masked` IS NOT OLD.`masked`
  OR NEW.`wiki` IS NOT OLD.`wiki`
  OR NEW.`edited` IS NOT OLD.`edited`
)
BEGIN
  UPDATE `characters` SET `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE `book_id` = NEW.`book_id` AND `name` = NEW.`name`;
END;

ALTER TABLE `chapters` ADD `script_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `active_key` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_key` ON `jobs` (`active_key`);
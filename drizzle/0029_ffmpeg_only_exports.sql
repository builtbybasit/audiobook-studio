ALTER TABLE `export_chapters` DROP COLUMN `byte_start`;--> statement-breakpoint
ALTER TABLE `export_chapters` DROP COLUMN `byte_length`;--> statement-breakpoint
ALTER TABLE `exports` DROP COLUMN `rebuilt`;--> statement-breakpoint
ALTER TABLE `exports` DROP COLUMN `reused`;--> statement-breakpoint
ALTER TABLE `exports` DROP COLUMN `encoder`;
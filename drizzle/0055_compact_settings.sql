ALTER TABLE `books` ADD `compact_off` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `compact_at` integer;--> statement-breakpoint
ALTER TABLE `characters` ADD `compacted_at` integer DEFAULT 0 NOT NULL;
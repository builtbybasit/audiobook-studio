ALTER TABLE `export_chapters` ADD `byte_start` integer;--> statement-breakpoint
ALTER TABLE `export_chapters` ADD `byte_length` integer;--> statement-breakpoint
ALTER TABLE `export_files` ADD `path` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `encoder` text;
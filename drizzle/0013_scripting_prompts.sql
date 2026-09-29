ALTER TABLE `books` ADD `prompt_notes` text;--> statement-breakpoint
ALTER TABLE `books` ADD `prompt_replace` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `prompt_system` text;--> statement-breakpoint
ALTER TABLE `books` ADD `prompt_user` text;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `reasoning_effort` text;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `prompt_mode` text;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `prompt_system` text;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `prompt_user` text;
CREATE TABLE `character_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` text NOT NULL,
	`speaker` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`book_id`,`speaker`) REFERENCES `characters`(`book_id`,`name`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `character_facts_speaker` ON `character_facts` (`book_id`,`speaker`);--> statement-breakpoint
CREATE INDEX `character_facts_chapter` ON `character_facts` (`book_id`,`chapter_id`);--> statement-breakpoint
ALTER TABLE `characters` ADD `profile` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `profile_up_to` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `profile_rebuild` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `edited` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `characters` SET `profile` = json_object('who', `description`, 'personality', '', 'voice', ''), `description` = '' WHERE trim(`description`) != '' AND `name` != 'Narrator';

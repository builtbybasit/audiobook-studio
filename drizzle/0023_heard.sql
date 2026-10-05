CREATE TABLE `heard` (
	`book_id` text NOT NULL,
	`file` text NOT NULL,
	`text` text NOT NULL,
	`heard` text NOT NULL,
	`words` text,
	`score` real NOT NULL,
	`mismatch` integer NOT NULL,
	`endpoint` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`book_id`, `file`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `books` ADD `check_by_ear` integer;
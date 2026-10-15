-- Clips whose old sound was kept on purpose, by file.
CREATE TABLE `kept_sounds` (
	`book_id` text NOT NULL,
	`url` text NOT NULL,
	`want` text,
	PRIMARY KEY(`book_id`, `url`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);

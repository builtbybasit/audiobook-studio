-- A scripting request now ends at a paragraph end where one fits. Cut at a sentence end, a request
-- could open mid-paragraph — inside a "[Silver Bell: … ]" item — and the model scripted the context
-- sent before it as well. Every scripting endpoint still on the old default moves over; one set to
-- a clause, a word or a hard cut was chosen and stays.
UPDATE `endpoints` SET `split_at` = 'paragraph' WHERE `kind` = 'scripting' AND `split_at` = 'sentence';

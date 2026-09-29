-- A book's cover is kept as the url it is served at, as a clip's is, rather than as the file name a
-- url was built from on every read: which library serves it, `/api` or the demo's `/demo/api`, is
-- part of the url. Every cover kept before this was the real library's.
UPDATE `books` SET `cover_image` = '/api/books/' || `id` || '/covers/' || `cover_image` WHERE `cover_image` IS NOT NULL;

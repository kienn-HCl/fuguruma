package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A database from v1.0 (highlights, several notes per book) opens and migrates.
func TestMigrateFromV1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		migrations[0],
		`PRAGMA user_version = 1`,
		`INSERT INTO books (id, path, format, title, fingerprint, size, mtime, added_at, updated_at) VALUES ('b', 'a.pdf', 'pdf', 'A', 'f', 1, 1, 1, 1)`,
		`INSERT INTO highlights (id, book_id, locator, text, color, comment, created_at, updated_at) VALUES ('h', 'b', '{"type":"pdf","page":1}', 'q', 'green', 'c', 5, 5)`,
		`INSERT INTO notes (id, book_id, title, body, created_at, updated_at) VALUES ('n1', 'b', 'one', '', 1, 1), ('n2', 'b', 'two', '', 2, 2)`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	m, err := s.GetMemo("h")
	if err != nil || m.Body != "c" || m.Kind != MemoHighlight || m.Sort != 5 || m.Color != "green" {
		t.Errorf("highlight should become a memo: %+v %v", m, err)
	}
	n, err := s.BookNote("b")
	if err != nil || n.ID != "n1" {
		t.Errorf("the first note should stay the book's note: %+v %v", n, err)
	}
	if n2, _ := s.GetNote("n2"); n2 == nil || n2.BookID != nil {
		t.Errorf("other notes of the book should be kept as free notes: %+v", n2)
	}
}

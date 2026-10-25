package library

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

func TestScanMarksMissingAndRelinks(t *testing.T) {
	lib := newTestLibrary(t)
	os.WriteFile(filepath.Join(lib.Root, "a.pdf"), pdfBytes("a"), 0o644)
	os.WriteFile(filepath.Join(lib.Root, "b.pdf"), pdfBytes("b"), 0o644)
	if res, err := lib.Scan(); err != nil || res.Added != 2 {
		t.Fatalf("initial scan: %+v %v", res, err)
	}

	os.Rename(filepath.Join(lib.Root, "a.pdf"), filepath.Join(lib.Root, "a-moved.pdf"))
	os.Remove(filepath.Join(lib.Root, "b.pdf"))
	res, err := lib.Scan()
	if err != nil || res.Moved != 1 || res.Missing != 1 {
		t.Fatalf("rescan: %+v %v", res, err)
	}
}

func TestScanRefusesUnavailableLibrary(t *testing.T) {
	lib := newTestLibrary(t)
	os.WriteFile(filepath.Join(lib.Root, "a.pdf"), pdfBytes("a"), 0o644)
	if _, err := lib.Scan(); err != nil {
		t.Fatal(err)
	}
	countMissing := func() int {
		books, _ := lib.Store.AllBookFiles()
		n := 0
		for _, b := range books {
			if b.Missing {
				n++
			}
		}
		return n
	}

	// An empty mount point (share not mounted) must not mark everything missing.
	os.Remove(filepath.Join(lib.Root, "a.pdf"))
	if _, err := lib.Scan(); !errors.Is(err, ErrLibraryUnavailable) {
		t.Errorf("empty library: expected ErrLibraryUnavailable, got %v", err)
	}
	if n := countMissing(); n != 0 {
		t.Errorf("empty library marked %d books missing", n)
	}

	// Neither must a books directory that does not exist at all.
	os.RemoveAll(lib.Root)
	if _, err := lib.Scan(); !errors.Is(err, ErrLibraryUnavailable) {
		t.Errorf("missing root: expected ErrLibraryUnavailable, got %v", err)
	}
	if n := countMissing(); n != 0 {
		t.Errorf("missing root marked %d books missing", n)
	}
}

func TestUnderAny(t *testing.T) {
	dirs := []string{"locked/", "a/b/"}
	for path, want := range map[string]bool{
		"locked/x.pdf": true, "a/b/c/d.epub": true, "lockedx/y.pdf": false, "a/bc.pdf": false, "x.pdf": false,
	} {
		if got := underAny(path, dirs); got != want {
			t.Errorf("underAny(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestRemoveMissing(t *testing.T) {
	lib := newTestLibrary(t)
	keep, _ := lib.Import("keep.pdf", bytes.NewReader(pdfBytes("keep")), "", 1<<20)
	gone, err := lib.Import("gone.pdf", bytes.NewReader(pdfBytes("gone")), "", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(lib.CoverPath(gone.ID), []byte("cover"), 0o644)
	if err := lib.Store.CreateHighlight(&db.Highlight{BookID: gone.ID, Locator: []byte(`{"type":"pdf","page":1}`), Text: "x"}); err != nil {
		t.Fatal(err)
	}
	note := &db.Note{BookID: &gone.ID, Title: "memo", Body: "keep me"}
	if err := lib.Store.CreateNote(note); err != nil {
		t.Fatal(err)
	}

	if err := lib.RemoveMissing(keep.ID); !errors.Is(err, ErrNotMissing) {
		t.Errorf("removing a present book: expected ErrNotMissing, got %v", err)
	}

	os.Remove(filepath.Join(lib.Root, "gone.pdf"))
	if _, err := lib.Scan(); err != nil {
		t.Fatal(err)
	}
	if err := lib.RemoveMissing(gone.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := lib.Store.GetBook(gone.ID); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("book still present: %v", err)
	}
	if hs, _ := lib.Store.ListHighlights(gone.ID); len(hs) != 0 {
		t.Errorf("highlights not deleted: %v", hs)
	}
	if n, err := lib.Store.GetNote(note.ID); err != nil || n.BookID != nil || n.Body != "keep me" {
		t.Errorf("note should be kept and detached: %+v %v", n, err)
	}
	if _, err := os.Stat(lib.CoverPath(gone.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("cached cover not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(lib.Root, "keep.pdf")); err != nil {
		t.Errorf("other book file affected: %v", err)
	}
	if err := lib.RemoveMissing(gone.ID); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("removing twice: expected ErrNotFound, got %v", err)
	}
}

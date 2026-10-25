package library

import (
	"errors"
	"os"
)

// ErrNotMissing is returned when removing a book whose file is still present.
var ErrNotMissing = errors.New("the book's file still exists")

// RemoveMissing deletes the record of a book whose file has gone missing.
// It never touches files in the books directory; only the database record
// and the cached cover are removed. Notes are kept (detached from the book).
func (l *Library) RemoveMissing(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, err := l.Store.GetBook(id)
	if err != nil {
		return err
	}
	if !b.Missing {
		return ErrNotMissing
	}
	if err := l.Store.DeleteBook(id); err != nil {
		return err
	}
	if err := os.Remove(l.CoverPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

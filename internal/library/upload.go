package library

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

// Uploads only ever create new files under the upload directory. Existing
// files are never overwritten, modified or deleted.

var (
	ErrUnsupportedFormat = errors.New("unsupported file type (only .epub and .pdf)")
	ErrInvalidFile       = errors.New("file content does not match its type")
	ErrTooLarge          = errors.New("file is too large")
)

// NotWritableError means the upload directory could not be created or written.
type NotWritableError struct{ Err error }

func (e *NotWritableError) Error() string {
	return "upload directory is not writable: " + e.Err.Error()
}
func (e *NotWritableError) Unwrap() error { return e.Err }

// DuplicateError means a book with identical content already exists.
type DuplicateError struct{ Book *db.Book }

func (e *DuplicateError) Error() string { return "the same book already exists: " + e.Book.Path }

// Import stores an uploaded file as a new book under dir (relative to the
// library root) and registers it. name is the client-supplied file name.
func (l *Library) Import(name string, r io.Reader, dir string, maxBytes int64) (*db.Book, error) {
	name = SanitizeFileName(name)
	format, ok := formats[strings.ToLower(filepath.Ext(name))]
	if !ok {
		return nil, ErrUnsupportedFormat
	}
	targetDir, ok := l.AbsPath(filepath.ToSlash(filepath.Clean(dir)))
	if !ok {
		return nil, &NotWritableError{fmt.Errorf("%q is outside the library", dir)}
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return nil, &NotWritableError{err}
	}

	// Write to a hidden temp file first; the scanner ignores dot files, so a
	// partially uploaded book is never indexed.
	tmp, err := os.CreateTemp(targetDir, ".fuguruma-upload-*.part")
	if err != nil {
		return nil, &NotWritableError{err}
	}
	tmpPath := tmp.Name()
	keep := false
	defer func() {
		if !keep {
			os.Remove(tmpPath)
		}
	}()
	n, err := io.Copy(tmp, io.LimitReader(r, maxBytes+1))
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if n > maxBytes {
		return nil, ErrTooLarge
	}
	if err := validate(tmpPath, format); err != nil {
		return nil, err
	}
	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return nil, err
	}
	fp, err := fingerprint(tmpPath, n)
	if err != nil {
		return nil, err
	}

	// Serialize with Scan so the new file is registered exactly once.
	l.mu.Lock()
	defer l.mu.Unlock()
	existing, err := l.Store.FindByFingerprint(fp)
	switch {
	case err == nil && !existing.Missing:
		return nil, &DuplicateError{existing}
	case err != nil && !errors.Is(err, db.ErrNotFound):
		return nil, err
	}
	final, err := placeUnique(tmpPath, targetDir, name)
	if err != nil {
		return nil, err
	}
	keep = true // the temp file has been moved into place
	info, err := os.Stat(final)
	if err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(l.Root, final)
	rel = filepath.ToSlash(rel)
	if existing != nil {
		// Same content as a book whose file went missing: re-attach it so its
		// notes, highlights and progress come back.
		if err := l.Store.UpdateBookFile(existing.ID, rel, fp, info.Size(), info.ModTime().UnixMilli()); err != nil {
			return nil, err
		}
		return l.Store.GetBook(existing.ID)
	}
	return l.addBook(rel, final, format, info, fp)
}

func validate(path, format string) error {
	switch format {
	case "pdf":
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		head := make([]byte, 1024)
		n, _ := io.ReadFull(f, head)
		// The header may be preceded by a few junk bytes; readers accept that within 1 KiB.
		if !bytes.Contains(head[:n], []byte("%PDF-")) {
			return ErrInvalidFile
		}
	case "epub":
		if _, err := ReadEpubMeta(path); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidFile, err)
		}
	}
	return nil
}

// placeUnique moves tmp to dir/name without ever replacing an existing file,
// adding " (2)", " (3)", ... to the name as needed. It returns the final path.
func placeUnique(tmp, dir, name string) (string, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; i <= 1000; i++ {
		candidate := name
		if i > 1 {
			candidate = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		final := filepath.Join(dir, candidate)
		// A hard link fails if the target exists, so this cannot overwrite.
		err := os.Link(tmp, final)
		if err == nil {
			os.Remove(tmp)
			return final, nil
		}
		if errors.Is(err, os.ErrExist) {
			continue
		}
		// Some filesystems (e.g. SMB mounts) do not support hard links: fall
		// back to checking for the name and renaming.
		if _, statErr := os.Lstat(final); statErr == nil {
			continue
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		if err := os.Rename(tmp, final); err != nil {
			return "", err
		}
		return final, nil
	}
	return "", errors.New("could not find a free file name")
}

// SanitizeFileName turns a client-supplied name into a safe single path
// element that also works on Windows/SMB shares.
func SanitizeFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = name[strings.LastIndex(name, "/")+1:]
	name = strings.Map(func(r rune) rune {
		switch {
		case unicode.IsControl(r), strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	name = strings.TrimRight(name, ". ")
	ext := filepath.Ext(name)
	base := strings.TrimSpace(strings.TrimSuffix(name, ext))
	if base == "" {
		base = "book"
	}
	// Keep names well under the common 255-byte limit, cutting on a rune boundary.
	const maxBase = 200
	if len(base) > maxBase {
		cut := maxBase
		for cut > 0 && !utf8.RuneStart(base[cut]) {
			cut--
		}
		base = base[:cut]
	}
	return base + strings.ToLower(ext)
}

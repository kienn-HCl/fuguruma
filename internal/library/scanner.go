// Package library keeps the database in sync with the book files on disk.
package library

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

type Library struct {
	Root     string
	CoverDir string
	Store    *db.Store
	mu       sync.Mutex
}

func New(root, dataDir string, store *db.Store) (*Library, error) {
	cd := filepath.Join(dataDir, "covers")
	if err := os.MkdirAll(cd, 0o755); err != nil {
		return nil, err
	}
	return &Library{Root: root, CoverDir: cd, Store: store}, nil
}

var formats = map[string]string{".epub": "epub", ".pdf": "pdf"}

type ScanResult struct {
	Added   int `json:"added"`
	Moved   int `json:"moved"`
	Updated int `json:"updated"`
	Missing int `json:"missing"`
	Total   int `json:"total"`
}

func (l *Library) CoverPath(id string) string { return filepath.Join(l.CoverDir, id) }

// AbsPath resolves a stored relative path, refusing anything outside Root.
func (l *Library) AbsPath(rel string) (string, bool) {
	p := filepath.Join(l.Root, filepath.FromSlash(rel))
	r, err := filepath.Rel(l.Root, p)
	if err != nil || strings.HasPrefix(r, "..") {
		return "", false
	}
	return p, true
}

// ErrLibraryUnavailable means the books directory could not be read or looks
// unmounted. Scan then leaves every book as it was instead of marking them
// all missing.
var ErrLibraryUnavailable = errors.New("books directory is unavailable")

func (l *Library) Scan() (*ScanResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if st, err := os.Stat(l.Root); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLibraryUnavailable, err)
	} else if !st.IsDir() {
		return nil, fmt.Errorf("%w: %s is not a directory", ErrLibraryUnavailable, l.Root)
	}

	existing, err := l.Store.AllBookFiles()
	if err != nil {
		return nil, err
	}
	byPath := map[string]*db.Book{}
	byFP := map[string][]*db.Book{}
	for _, b := range existing {
		byPath[b.Path] = b
		byFP[b.Fingerprint] = append(byFP[b.Fingerprint], b)
	}
	seen := map[string]bool{} // book IDs found on disk
	res := &ScanResult{}

	type found struct {
		rel, abs, format string
		info             fs.FileInfo
	}
	var newFiles []found
	var unreadable []string // directories (relative, slash-separated) that could not be listed

	err = filepath.WalkDir(l.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == l.Root {
				return fmt.Errorf("%w: %v", ErrLibraryUnavailable, err)
			}
			log.Printf("scan: %s: %v", p, err)
			if rel, rerr := filepath.Rel(l.Root, p); rerr == nil {
				unreadable = append(unreadable, filepath.ToSlash(rel)+"/")
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			// Skip hidden dirs and storage metadata dirs (e.g. Synology @eaDir, #recycle).
			if p != l.Root && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "@") || strings.HasPrefix(name, "#")) {
				return filepath.SkipDir
			}
			return nil
		}
		format, ok := formats[strings.ToLower(filepath.Ext(name))]
		if !ok || strings.HasPrefix(name, ".") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(l.Root, p)
		rel = filepath.ToSlash(rel)
		res.Total++
		if b, ok := byPath[rel]; ok {
			seen[b.ID] = true
			if b.Size != info.Size() || b.Mtime != info.ModTime().UnixMilli() || b.Missing {
				fp, err := fingerprint(p, info.Size())
				if err == nil {
					l.Store.UpdateBookFile(b.ID, rel, fp, info.Size(), info.ModTime().UnixMilli())
					res.Updated++
				}
			}
			return nil
		}
		newFiles = append(newFiles, found{rel, p, format, info})
		return nil
	})
	if err != nil {
		return nil, err
	}

	for _, f := range newFiles {
		fp, err := fingerprint(f.abs, f.info.Size())
		if err != nil {
			log.Printf("scan: fingerprint %s: %v", f.rel, err)
			continue
		}
		// A known fingerprint at an unseen path means the file was moved/renamed.
		var moved *db.Book
		for _, b := range byFP[fp] {
			if !seen[b.ID] {
				moved = b
				break
			}
		}
		if moved != nil {
			seen[moved.ID] = true
			if err := l.Store.UpdateBookFile(moved.ID, f.rel, fp, f.info.Size(), f.info.ModTime().UnixMilli()); err != nil {
				log.Printf("scan: relink %s: %v", f.rel, err)
			}
			res.Moved++
			continue
		}
		b, err := l.addBook(f.rel, f.abs, f.format, f.info, fp)
		if err != nil {
			log.Printf("scan: insert %s: %v", f.rel, err)
			continue
		}
		seen[b.ID] = true
		byFP[fp] = append(byFP[fp], b)
		res.Added++
	}

	var gone []*db.Book
	present := 0
	for _, b := range existing {
		if b.Missing {
			continue
		}
		present++
		if !seen[b.ID] && !underAny(b.Path, unreadable) {
			gone = append(gone, b)
		}
	}
	// An empty directory where books used to be is almost always an unmounted
	// network share or drive (the mount point exists but is empty), not a
	// library whose every book was deleted.
	if res.Total == 0 && present > 0 {
		return nil, fmt.Errorf("%w: no books found in %s (not mounted?)", ErrLibraryUnavailable, l.Root)
	}
	for _, b := range gone {
		l.Store.SetMissing(b.ID, true)
		res.Missing++
	}
	return res, nil
}

// underAny reports whether rel lies inside one of the directory prefixes.
func underAny(rel string, dirs []string) bool {
	for _, d := range dirs {
		if strings.HasPrefix(rel, d) {
			return true
		}
	}
	return false
}

// addBook registers a file that is not in the database yet, reading EPUB
// metadata and cover when available.
func (l *Library) addBook(rel, abs, format string, info fs.FileInfo, fp string) (*db.Book, error) {
	b := &db.Book{
		ID:          db.NewID(),
		Path:        rel,
		Format:      format,
		Title:       strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel)),
		Fingerprint: fp,
		Size:        info.Size(),
		Mtime:       info.ModTime().UnixMilli(),
		AddedAt:     db.Now(),
		UpdatedAt:   db.Now(),
	}
	if format == "epub" {
		if m, err := ReadEpubMeta(abs); err == nil {
			if m.Title != "" {
				b.Title = m.Title
			}
			b.Author, b.Description = m.Author, m.Description
			if len(m.Cover) > 0 && os.WriteFile(l.CoverPath(b.ID), m.Cover, 0o644) == nil {
				b.HasCover = true
			}
		} else {
			log.Printf("library: epub meta %s: %v", rel, err)
		}
	}
	if err := l.Store.InsertBook(b); err != nil {
		return nil, err
	}
	return b, nil
}

// fingerprint identifies file content cheaply: size + first 1MiB + last 64KiB.
func fingerprint(p string, size int64) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	binary.Write(h, binary.LittleEndian, size)
	if _, err := io.CopyN(h, f, 1<<20); err != nil && err != io.EOF {
		return "", err
	}
	if size > 1<<20 {
		tail := int64(64 << 10)
		if size-tail < 1<<20 {
			tail = size - 1<<20
		}
		if _, err := f.Seek(-tail, io.SeekEnd); err == nil {
			io.Copy(h, f)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:32], nil
}

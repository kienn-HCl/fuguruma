// Package library keeps the database in sync with the book files on disk.
package library

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/you/fuguruma/internal/db"
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

func (l *Library) Scan() (*ScanResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

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

	err = filepath.WalkDir(l.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			log.Printf("scan: %s: %v", p, err)
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
		b := &db.Book{
			ID:          db.NewID(),
			Path:        f.rel,
			Format:      f.format,
			Title:       strings.TrimSuffix(filepath.Base(f.rel), filepath.Ext(f.rel)),
			Fingerprint: fp,
			Size:        f.info.Size(),
			Mtime:       f.info.ModTime().UnixMilli(),
			AddedAt:     db.Now(),
			UpdatedAt:   db.Now(),
		}
		if f.format == "epub" {
			if m, err := ReadEpubMeta(f.abs); err == nil {
				if m.Title != "" {
					b.Title = m.Title
				}
				b.Author, b.Description = m.Author, m.Description
				if len(m.Cover) > 0 && os.WriteFile(l.CoverPath(b.ID), m.Cover, 0o644) == nil {
					b.HasCover = true
				}
			} else {
				log.Printf("scan: epub meta %s: %v", f.rel, err)
			}
		}
		if err := l.Store.InsertBook(b); err != nil {
			log.Printf("scan: insert %s: %v", f.rel, err)
			continue
		}
		seen[b.ID] = true
		byFP[fp] = append(byFP[fp], b)
		res.Added++
	}

	for _, b := range existing {
		if !seen[b.ID] && !b.Missing {
			l.Store.SetMissing(b.ID, true)
			res.Missing++
		}
	}
	return res, nil
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

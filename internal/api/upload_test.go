package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/kienn-HCl/fuguruma/internal/ai"
	"github.com/kienn-HCl/fuguruma/internal/auth"
	"github.com/kienn-HCl/fuguruma/internal/config"
	"github.com/kienn-HCl/fuguruma/internal/db"
	"github.com/kienn-HCl/fuguruma/internal/library"
)

func newTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	conf, err := config.Load(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	books := filepath.Join(dir, "books")
	os.MkdirAll(books, 0o755)
	store, err := db.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	lib, err := library.New(books, dir, store)
	if err != nil {
		t.Fatal(err)
	}
	a, err := auth.New(func() (string, string) { return "", "" }, dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: store, Lib: lib, Auth: a, AI: ai.NewManager(conf.Get().AI, dir), Conf: conf,
		Web: fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}}
	return s, s.Handler()
}

func uploadReq(t *testing.T, name string, content []byte, tagIDs string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if tagIDs != "" {
		mw.WriteField("tagIds", tagIDs)
	}
	fw, _ := mw.CreateFormFile("file", name)
	fw.Write(content)
	mw.Close()
	r := httptest.NewRequest("POST", "/api/library/upload", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}

func TestUploadHandler(t *testing.T) {
	s, h := newTestServer(t)
	tag, err := s.Store.CreateTag("新着", "")
	if err != nil {
		t.Fatal(err)
	}
	pdf := []byte("%PDF-1.4\nhello\n%%EOF\n")

	w := httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "本.pdf", pdf, "1"))
	if w.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	var b db.Book
	json.Unmarshal(w.Body.Bytes(), &b)
	if b.Path != "Uploads/本.pdf" || len(b.Tags) != 1 || b.Tags[0].ID != tag.ID {
		t.Errorf("unexpected book: %+v", b)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "copy.pdf", pdf, ""))
	var dup map[string]string
	json.Unmarshal(w.Body.Bytes(), &dup)
	if w.Code != http.StatusConflict || dup["bookId"] != b.ID {
		t.Errorf("duplicate: %d %s", w.Code, w.Body)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "note.txt", []byte("hi"), ""))
	if w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("unsupported type: %d %s", w.Code, w.Body)
	}

	s.Conf.Update(func(c *config.Config) { c.Library.UploadMaxMB = 1 })
	w = httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "big.pdf", append([]byte("%PDF-1.4\n"), make([]byte, 3<<20)...), ""))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("too large: %d %s", w.Code, w.Body)
	}

	s.Conf.Update(func(c *config.Config) { c.Library.UploadEnabled = false })
	w = httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "other.pdf", []byte("%PDF-1.4\nother\n"), ""))
	if w.Code != http.StatusForbidden {
		t.Errorf("disabled: %d %s", w.Code, w.Body)
	}

	// Cross-site upload attempts are rejected by the CSRF protection (uploads enabled again
	// so the 403 cannot come from the disabled setting).
	s.Conf.Update(func(c *config.Config) { c.Library.UploadEnabled = true })
	r := uploadReq(t, "csrf.pdf", []byte("%PDF-1.4\ncsrf\n"), "")
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("cross-site upload: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(s.Lib.Root, "Uploads", "csrf.pdf")); err == nil {
		t.Error("cross-site upload was stored")
	}
}

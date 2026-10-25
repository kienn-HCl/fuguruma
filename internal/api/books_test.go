package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

func do(h http.Handler, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestDeleteMissingBook(t *testing.T) {
	s, h := newTestServer(t)
	var books []db.Book
	for _, name := range []string{"keep.pdf", "gone.pdf"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, uploadReq(t, name, []byte("%PDF-1.4\n"+name+"\n"), ""))
		var b db.Book
		json.Unmarshal(w.Body.Bytes(), &b)
		books = append(books, b)
	}
	gone := books[1]

	if w := do(h, "DELETE", "/api/books/"+gone.ID); w.Code != http.StatusConflict {
		t.Errorf("deleting a book whose file exists: %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.Lib.Root, gone.Path)); err != nil {
		t.Fatalf("file must not be touched: %v", err)
	}

	os.Remove(filepath.Join(s.Lib.Root, gone.Path))
	if w := do(h, "POST", "/api/library/scan"); w.Code != http.StatusOK {
		t.Fatalf("scan: %d %s", w.Code, w.Body)
	}
	if w := do(h, "DELETE", "/api/books/"+gone.ID); w.Code != http.StatusOK {
		t.Errorf("deleting a missing book: %d %s", w.Code, w.Body)
	}
	if w := do(h, "GET", "/api/books/"+gone.ID); w.Code != http.StatusNotFound {
		t.Errorf("deleted book still served: %d", w.Code)
	}
	if w := do(h, "DELETE", "/api/books/nonexistent"); w.Code != http.StatusNotFound {
		t.Errorf("unknown book: %d", w.Code)
	}
}

func TestScanUnavailableLibrary(t *testing.T) {
	s, h := newTestServer(t)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "a.pdf", []byte("%PDF-1.4\na\n"), ""))
	var b db.Book
	json.Unmarshal(w.Body.Bytes(), &b)

	// Simulate an unmounted share: the directory is there but empty.
	os.RemoveAll(filepath.Join(s.Lib.Root, "Uploads"))
	if w := do(h, "POST", "/api/library/scan"); w.Code != http.StatusServiceUnavailable {
		t.Errorf("scan of an empty library: %d %s", w.Code, w.Body)
	}
	got, err := s.Store.GetBook(b.ID)
	if err != nil || got.Missing {
		t.Errorf("book must not be marked missing: %+v %v", got, err)
	}
}

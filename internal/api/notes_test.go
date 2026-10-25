package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

func doJSON(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)
	return w
}

func TestPinnedNotes(t *testing.T) {
	_, h := newTestServer(t)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, "book.pdf", []byte("%PDF-1.4\nbook\n"), ""))
	var b db.Book
	json.Unmarshal(w.Body.Bytes(), &b)

	// A note pinned to a position.
	w = doJSON(h, "POST", "/api/notes", `{"bookId":"`+b.ID+`","title":"付箋","body":"> 引用","locator":{"type":"pdf","page":12},"locatorLabel":"12 / 40・30%"}`)
	var n db.Note
	json.Unmarshal(w.Body.Bytes(), &n)
	if w.Code != http.StatusOK || string(n.Locator) != `{"type":"pdf","page":12}` || n.LocatorLabel != "12 / 40・30%" {
		t.Fatalf("create pinned note: %d %s", w.Code, w.Body)
	}

	// A plain note has a null locator.
	w = doJSON(h, "POST", "/api/notes", `{"bookId":"`+b.ID+`","title":"plain","body":""}`)
	var plain db.Note
	json.Unmarshal(w.Body.Bytes(), &plain)
	if string(plain.Locator) != "null" {
		t.Errorf("plain note locator: %s", plain.Locator)
	}

	// Editing the body keeps the pin.
	w = doJSON(h, "PATCH", "/api/notes/"+n.ID, `{"body":"edited"}`)
	json.Unmarshal(w.Body.Bytes(), &n)
	if string(n.Locator) != `{"type":"pdf","page":12}` || n.Body != "edited" {
		t.Errorf("pin lost on edit: %s", w.Body)
	}

	// Move the pin, then remove it with null.
	w = doJSON(h, "PATCH", "/api/notes/"+n.ID, `{"locator":{"type":"pdf","page":3},"locatorLabel":"3 / 40・8%"}`)
	json.Unmarshal(w.Body.Bytes(), &n)
	if string(n.Locator) != `{"type":"pdf","page":3}` || n.LocatorLabel != "3 / 40・8%" {
		t.Errorf("move pin: %s", w.Body)
	}
	w = doJSON(h, "PATCH", "/api/notes/"+n.ID, `{"locator":null,"locatorLabel":""}`)
	json.Unmarshal(w.Body.Bytes(), &n)
	if string(n.Locator) != "null" || n.LocatorLabel != "" {
		t.Errorf("unpin: %s", w.Body)
	}
}

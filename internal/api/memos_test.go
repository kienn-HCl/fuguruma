package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

func doJSON(t *testing.T, h http.Handler, method, path string, body any, out any) int {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, &buf)
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)
	if out != nil && w.Code < 300 {
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, w.Body)
		}
	}
	return w.Code
}

func uploadBook(t *testing.T, h http.Handler, name string) db.Book {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, uploadReq(t, name, []byte("%PDF-1.4\n"+name+"\n"), ""))
	var b db.Book
	json.Unmarshal(w.Body.Bytes(), &b)
	if b.ID == "" {
		t.Fatalf("upload %s: %d %s", name, w.Code, w.Body)
	}
	return b
}

func TestMemosAndBookNote(t *testing.T) {
	s, h := newTestServer(t)
	book := uploadBook(t, h, "a.pdf")
	other := uploadBook(t, h, "b.pdf")

	var hl, text db.Memo
	if c := doJSON(t, h, "POST", "/api/books/"+book.ID+"/memos", map[string]any{
		"locator": map[string]any{"type": "pdf", "page": 3}, "label": "p.3", "text": "a passage", "body": "first thought",
	}, &hl); c != http.StatusOK {
		t.Fatalf("create memo: %d", c)
	}
	if hl.Kind != db.MemoHighlight || hl.Color != "yellow" || hl.Sort == 0 {
		t.Errorf("memo defaults: %+v", hl)
	}
	doJSON(t, h, "POST", "/api/books/"+book.ID+"/memos", map[string]any{
		"kind": "text", "locator": hl.Locator, "body": "between the memos", "sort": hl.Sort + 1,
	}, &text)
	if c := doJSON(t, h, "POST", "/api/books/"+book.ID+"/memos", map[string]any{"text": "no position"}, nil); c != http.StatusBadRequest {
		t.Errorf("memo without locator: %d", c)
	}

	var memos []db.Memo
	doJSON(t, h, "GET", "/api/books/"+book.ID+"/memos", nil, &memos)
	if len(memos) != 2 || memos[0].ID != hl.ID || memos[1].ID != text.ID {
		t.Errorf("memos in sort order: %+v", memos)
	}

	var upd db.Memo
	doJSON(t, h, "PATCH", "/api/memos/"+hl.ID, map[string]any{"color": "blue"}, &upd)
	if upd.Color != "blue" || upd.Body != "first thought" {
		t.Errorf("patch changes only the given fields: %+v", upd)
	}

	// Creating memos gave the book its note, which shows up in the list and in searches of memo bodies.
	var note db.Note
	doJSON(t, h, "GET", "/api/books/"+book.ID+"/note", nil, &note)
	if note.BookID == nil || *note.BookID != book.ID || note.MemoCount != 2 {
		t.Errorf("book note: %+v", note)
	}
	var again db.Note
	doJSON(t, h, "GET", "/api/books/"+book.ID+"/note", nil, &again)
	if again.ID != note.ID {
		t.Errorf("a book has one note: %s != %s", again.ID, note.ID)
	}
	doJSON(t, h, "GET", "/api/books/"+other.ID+"/note", nil, nil) // empty book notes stay out of the list
	var list []db.Note
	doJSON(t, h, "GET", "/api/notes", nil, &list)
	if len(list) != 1 || list[0].ID != note.ID {
		t.Errorf("note list: %+v", list)
	}
	doJSON(t, h, "GET", "/api/notes?q=between", nil, &list)
	if len(list) != 1 {
		t.Errorf("search should match memo bodies: %+v", list)
	}
	if c := doJSON(t, h, "DELETE", "/api/notes/"+note.ID, nil, nil); c != http.StatusConflict {
		t.Errorf("deleting a book note: %d", c)
	}

	// POST /api/notes only makes free-standing notes.
	var free db.Note
	doJSON(t, h, "POST", "/api/notes", map[string]any{"bookId": book.ID, "title": "free"}, &free)
	if free.BookID != nil {
		t.Errorf("free note bound to a book: %+v", free)
	}
	if c := doJSON(t, h, "DELETE", "/api/notes/"+free.ID, nil, nil); c != http.StatusOK {
		t.Errorf("deleting a free note: %d", c)
	}

	if c := doJSON(t, h, "DELETE", "/api/memos/"+text.ID, nil, nil); c != http.StatusOK {
		t.Errorf("delete memo: %d", c)
	}
	if _, err := s.Store.GetMemo(text.ID); err == nil {
		t.Error("memo still there")
	}
}

func TestConversationExportToMemo(t *testing.T) {
	s, h := newTestServer(t)
	book := uploadBook(t, h, "a.pdf")
	other := uploadBook(t, h, "b.pdf")
	var memo db.Memo
	doJSON(t, h, "POST", "/api/books/"+book.ID+"/memos", map[string]any{
		"locator": map[string]any{"type": "pdf", "page": 1}, "text": "a passage", "body": "mine",
	}, &memo)

	if c := doJSON(t, h, "POST", "/api/books/"+other.ID+"/conversations", map[string]any{"passage": "x", "memoId": memo.ID}, nil); c != http.StatusBadRequest {
		t.Errorf("conversation with another book's memo: %d", c)
	}
	var conv db.Conversation
	doJSON(t, h, "POST", "/api/books/"+book.ID+"/conversations", map[string]any{"passage": "a passage", "memoId": memo.ID}, &conv)
	if conv.MemoID == nil || *conv.MemoID != memo.ID {
		t.Fatalf("conversation memo: %+v", conv)
	}
	s.Store.AddMessage(conv.ID, "user", "what does it mean?")
	s.Store.AddMessage(conv.ID, "assistant", "It means this.")

	var out saved
	doJSON(t, h, "POST", "/api/conversations/"+conv.ID+"/export", map[string]any{}, &out)
	if out.Memo == nil || out.Note != nil {
		t.Fatalf("export should go to the memo: %+v", out)
	}
	if want := "mine\n\n**Q.** what does it mean?\n\nIt means this."; out.Memo.Body != want {
		t.Errorf("memo body:\n%q\nwant\n%q", out.Memo.Body, want)
	}

	// Without its memo, the conversation is exported to the book's note, with the passage.
	doJSON(t, h, "DELETE", "/api/memos/"+memo.ID, nil, nil)
	out = saved{}
	doJSON(t, h, "POST", "/api/conversations/"+conv.ID+"/export", map[string]any{}, &out)
	if out.Note == nil || !strings.HasPrefix(out.Note.Body, "> a passage\n\n**Q.**") {
		t.Errorf("export to the book note: %+v", out.Note)
	}
}

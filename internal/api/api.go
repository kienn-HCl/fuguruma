// Package api exposes the REST/SSE API consumed by the web frontend.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/kienn-HCl/fuguruma/internal/ai"
	"github.com/kienn-HCl/fuguruma/internal/auth"
	"github.com/kienn-HCl/fuguruma/internal/config"
	"github.com/kienn-HCl/fuguruma/internal/db"
	"github.com/kienn-HCl/fuguruma/internal/library"
)

type Server struct {
	Store *db.Store
	Lib   *library.Library
	Auth  *auth.Auth
	AI    *ai.Manager
	Conf  *config.Manager
	Web   fs.FS // built frontend (index.html + assets)

	logins     *loginLimiter
	loginsOnce sync.Once
}

func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()

	m.HandleFunc("GET /api/status", s.status)
	m.HandleFunc("POST /api/login", s.login)
	m.HandleFunc("POST /api/logout", s.logout)

	m.HandleFunc("GET /api/books", s.listBooks)
	m.HandleFunc("GET /api/books/{id}", s.getBook)
	m.HandleFunc("PATCH /api/books/{id}", s.patchBook)
	m.HandleFunc("GET /api/books/{id}/file", s.bookFile)
	m.HandleFunc("GET /api/books/{id}/cover", s.getCover)
	m.HandleFunc("PUT /api/books/{id}/cover", s.putCover)
	m.HandleFunc("PUT /api/books/{id}/tags", s.putBookTags)
	m.HandleFunc("GET /api/books/{id}/progress", s.getProgress)
	m.HandleFunc("PUT /api/books/{id}/progress", s.putProgress)
	m.HandleFunc("POST /api/library/scan", s.scan)
	m.HandleFunc("POST /api/library/upload", s.upload)

	m.HandleFunc("GET /api/tags", s.listTags)
	m.HandleFunc("POST /api/tags", s.createTag)
	m.HandleFunc("PATCH /api/tags/{id}", s.patchTag)
	m.HandleFunc("DELETE /api/tags/{id}", s.deleteTag)

	m.HandleFunc("GET /api/books/{id}/highlights", s.listHighlights)
	m.HandleFunc("POST /api/books/{id}/highlights", s.createHighlight)
	m.HandleFunc("PATCH /api/highlights/{id}", s.patchHighlight)
	m.HandleFunc("DELETE /api/highlights/{id}", s.deleteHighlight)

	m.HandleFunc("GET /api/notes", s.listNotes)
	m.HandleFunc("POST /api/notes", s.createNote)
	m.HandleFunc("GET /api/notes/{id}", s.getNote)
	m.HandleFunc("PATCH /api/notes/{id}", s.patchNote)
	m.HandleFunc("DELETE /api/notes/{id}", s.deleteNote)

	m.HandleFunc("GET /api/books/{id}/conversations", s.listConversations)
	m.HandleFunc("POST /api/books/{id}/conversations", s.createConversation)
	m.HandleFunc("GET /api/conversations/{id}", s.getConversation)
	m.HandleFunc("PATCH /api/conversations/{id}", s.patchConversation)
	m.HandleFunc("DELETE /api/conversations/{id}", s.deleteConversation)
	m.HandleFunc("POST /api/conversations/{id}/messages", s.postMessage)
	m.HandleFunc("DELETE /api/messages/{id}", s.deleteMessage)
	m.HandleFunc("POST /api/conversations/{id}/summarize", s.summarize)
	m.HandleFunc("POST /api/conversations/{id}/export", s.export)

	m.HandleFunc("GET /api/settings", s.getSettings)
	m.HandleFunc("PUT /api/settings", s.putSettings)
	m.HandleFunc("POST /api/settings/password", s.changePassword)
	m.HandleFunc("POST /api/settings/ai/test", s.testAI)

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not found")
	})
	m.Handle("/", s.spa())

	public := func(r *http.Request) bool {
		p := r.URL.Path
		return !strings.HasPrefix(p, "/api/") || p == "/api/status" || p == "/api/login"
	}
	// Reject cross-site state-changing requests (CSRF), e.g. a malicious page
	// POSTing to a Fuguruma instance on the local network.
	csrf := http.NewCrossOriginProtection()
	return logRequests(csrf.Handler(s.Auth.Middleware(m, public)))
}

// spa serves the embedded frontend, falling back to index.html for client routes.
func (s *Server) spa() http.Handler {
	files := http.FileServerFS(s.Web)
	if _, err := fs.Stat(s.Web, "index.html"); err != nil {
		// Binary compiled without `make web`: explain instead of serving a blank page.
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, "The web UI is not included in this build.\nBuild it with `make build` (or run `npm ci && npm run build` in web/ before `go build`).\n")
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(s.Web, p); err != nil {
			r.URL.Path = "/"
			p = "index.html"
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		h.ServeHTTP(w, r)
	})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return false
	}
	return true
}

func handleErr(w http.ResponseWriter, err error) {
	if errors.Is(err, db.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	log.Printf("error: %v", err)
	writeErr(w, http.StatusInternalServerError, err.Error())
}

// ---- auth ----

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	p, name, _ := s.AI.Get()
	lib := s.Conf.Get().Library
	writeJSON(w, map[string]any{
		"authRequired":  s.Auth.Enabled(),
		"loggedIn":      s.Auth.LoggedIn(r),
		"aiEnabled":     p != nil,
		"aiProvider":    name,
		"uploadEnabled": lib.UploadEnabled,
		"uploadMaxMb":   lib.UploadMaxMB,
	})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	s.loginsOnce.Do(func() { s.logins = newLoginLimiter() })
	key := clientKey(r)
	if ok, wait := s.logins.Allowed(key); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("ログインの失敗が続いたため、%d 分後に再試行してください", int(wait.Minutes())+1))
		return
	}
	var body struct{ Password string }
	if !readJSON(w, r, &body) {
		return
	}
	if !s.Auth.CheckPassword(body.Password) {
		s.logins.Fail(key)
		writeErr(w, http.StatusUnauthorized, "パスワードが違います")
		return
	}
	s.logins.Succeed(key)
	s.Auth.SetSession(w, r)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.Auth.ClearSession(w)
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- books ----

func (s *Server) listBooks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tagID, _ := strconv.ParseInt(q.Get("tag"), 10, 64)
	books, err := s.Store.ListBooks(db.BookQuery{Q: q.Get("q"), TagID: tagID, Sort: q.Get("sort")})
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, books)
}

func (s *Server) getBook(w http.ResponseWriter, r *http.Request) {
	b, err := s.Store.GetBook(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, b)
}

func (s *Server) patchBook(w http.ResponseWriter, r *http.Request) {
	var body struct{ Title, Author *string }
	if !readJSON(w, r, &body) {
		return
	}
	id := r.PathValue("id")
	if err := s.Store.UpdateBookMeta(id, body.Title, body.Author); err != nil {
		handleErr(w, err)
		return
	}
	s.getBook(w, r)
}

func (s *Server) bookFile(w http.ResponseWriter, r *http.Request) {
	b, err := s.Store.GetBook(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	p, ok := s.Lib.AbsPath(b.Path)
	if !ok {
		writeErr(w, http.StatusForbidden, "invalid path")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		handleErr(w, err)
		return
	}
	if r.Header.Get("Range") == "" {
		s.Store.TouchOpened(b.ID)
	}
	ct := "application/epub+zip"
	if b.Format == "pdf" {
		ct = "application/pdf"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *Server) getCover(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(s.Lib.CoverPath(r.PathValue("id")))
	if err != nil {
		writeErr(w, http.StatusNotFound, "no cover")
		return
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	f.Seek(0, io.SeekStart)
	st, _ := f.Stat()
	w.Header().Set("Content-Type", http.DetectContentType(head[:n]))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *Server) putCover(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.Store.GetBook(id); err != nil {
		handleErr(w, err)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 5<<20))
	if err != nil || !strings.HasPrefix(http.DetectContentType(data), "image/") {
		writeErr(w, http.StatusBadRequest, "image required")
		return
	}
	if err := os.WriteFile(s.Lib.CoverPath(id), data, 0o644); err != nil {
		handleErr(w, err)
		return
	}
	s.Store.SetHasCover(id, true)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) putBookTags(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TagIDs []int64 `json:"tagIds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.Store.SetBookTags(r.PathValue("id"), body.TagIDs); err != nil {
		handleErr(w, err)
		return
	}
	s.getBook(w, r)
}

func (s *Server) getProgress(w http.ResponseWriter, r *http.Request) {
	p, err := s.Store.GetProgress(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, p)
}

func (s *Server) putProgress(w http.ResponseWriter, r *http.Request) {
	var p db.Progress
	if !readJSON(w, r, &p) {
		return
	}
	saved, err := s.Store.SaveProgress(r.PathValue("id"), p)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, saved)
}

func (s *Server) scan(w http.ResponseWriter, r *http.Request) {
	res, err := s.Lib.Scan()
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, res)
}

// ---- tags ----

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	t, err := s.Store.ListTags()
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, t)
}

func (s *Server) createTag(w http.ResponseWriter, r *http.Request) {
	var body struct{ Name, Color string }
	if !readJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	t, err := s.Store.CreateTag(body.Name, body.Color)
	if err != nil {
		writeErr(w, http.StatusConflict, "同名のタグがあります")
		return
	}
	writeJSON(w, t)
}

func (s *Server) patchTag(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var body struct{ Name, Color *string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.Store.UpdateTag(id, body.Name, body.Color); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err := s.Store.DeleteTag(id); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- highlights ----

func (s *Server) listHighlights(w http.ResponseWriter, r *http.Request) {
	h, err := s.Store.ListHighlights(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, h)
}

func (s *Server) createHighlight(w http.ResponseWriter, r *http.Request) {
	var h db.Highlight
	if !readJSON(w, r, &h) {
		return
	}
	h.BookID = r.PathValue("id")
	if len(h.Locator) == 0 {
		writeErr(w, http.StatusBadRequest, "locator required")
		return
	}
	if err := s.Store.CreateHighlight(&h); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, h)
}

func (s *Server) patchHighlight(w http.ResponseWriter, r *http.Request) {
	var body struct{ Color, Comment *string }
	if !readJSON(w, r, &body) {
		return
	}
	id := r.PathValue("id")
	if err := s.Store.UpdateHighlight(id, body.Color, body.Comment); err != nil {
		handleErr(w, err)
		return
	}
	h, err := s.Store.GetHighlight(id)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, h)
}

func (s *Server) deleteHighlight(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteHighlight(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- notes ----

func (s *Server) listNotes(w http.ResponseWriter, r *http.Request) {
	n, err := s.Store.ListNotes(r.URL.Query().Get("bookId"), r.URL.Query().Get("q"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, n)
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var n db.Note
	if !readJSON(w, r, &n) {
		return
	}
	if n.BookID != nil && *n.BookID == "" {
		n.BookID = nil
	}
	if err := s.Store.CreateNote(&n); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, n)
}

func (s *Server) getNote(w http.ResponseWriter, r *http.Request) {
	n, err := s.Store.GetNote(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, n)
}

func (s *Server) patchNote(w http.ResponseWriter, r *http.Request) {
	var body struct{ Title, Body *string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.Store.UpdateNote(r.PathValue("id"), body.Title, body.Body); err != nil {
		handleErr(w, err)
		return
	}
	s.getNote(w, r)
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteNote(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

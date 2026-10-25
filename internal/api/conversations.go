package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/kienn-HCl/fuguruma/internal/ai"
	"github.com/kienn-HCl/fuguruma/internal/db"
)

func (s *Server) listConversations(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.ListConversations(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, c)
}

func (s *Server) createConversation(w http.ResponseWriter, r *http.Request) {
	var c db.Conversation
	if !readJSON(w, r, &c) {
		return
	}
	c.BookID = r.PathValue("id")
	if _, err := s.Store.GetBook(c.BookID); err != nil {
		handleErr(w, err)
		return
	}
	if c.MemoID != nil {
		if m, err := s.Store.GetMemo(*c.MemoID); err != nil || m.BookID != c.BookID {
			writeErr(w, http.StatusBadRequest, "memo not found in this book")
			return
		}
	}
	if r := []rune(c.Context); len(r) > 6000 {
		c.Context = string(r[:6000])
	}
	if err := s.Store.CreateConversation(&c); err != nil {
		handleErr(w, err)
		return
	}
	c.Messages = []db.Message{}
	writeJSON(w, c)
}

func (s *Server) getConversation(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.GetConversation(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, c)
}

func (s *Server) patchConversation(w http.ResponseWriter, r *http.Request) {
	var body struct{ Title string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.Store.RenameConversation(r.PathValue("id"), body.Title); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) deleteConversation(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteConversation(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteMessage(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// provider returns the active AI provider, or writes an error response.
func (s *Server) provider(w http.ResponseWriter) (ai.Provider, bool) {
	p, _, err := s.AI.Get()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "AI の設定に問題があります: "+err.Error())
		return nil, false
	}
	if p == nil {
		writeErr(w, http.StatusServiceUnavailable, "AI が設定されていません（設定画面から有効にしてください）")
		return nil, false
	}
	return p, true
}

func (s *Server) bookContext(c *db.Conversation) (ai.BookContext, error) {
	b, err := s.Store.GetBook(c.BookID)
	if err != nil {
		return ai.BookContext{}, err
	}
	return ai.BookContext{Title: b.Title, Author: b.Author, Passage: c.Passage, Context: c.Context}, nil
}

func turnsOf(msgs []db.Message) []ai.Turn {
	t := make([]ai.Turn, 0, len(msgs))
	for _, m := range msgs {
		t = append(t, ai.Turn{Role: m.Role, Content: m.Content})
	}
	return t
}

// postMessage stores the user's message and streams Claude's reply as SSE.
func (s *Server) postMessage(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.provider(w)
	if !ok {
		return
	}
	var body struct{ Content string }
	if !readJSON(w, r, &body) {
		return
	}
	body.Content = strings.TrimSpace(body.Content)
	if body.Content == "" {
		writeErr(w, http.StatusBadRequest, "content required")
		return
	}
	conv, err := s.Store.GetConversation(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	book, err := s.bookContext(conv)
	if err != nil {
		handleErr(w, err)
		return
	}
	userMsg, err := s.Store.AddMessage(conv.ID, "user", body.Content)
	if err != nil {
		handleErr(w, err)
		return
	}
	if conv.Title == "" {
		s.Store.RenameConversation(conv.ID, truncate(body.Content, 40))
	}

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering
	send := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		if flusher != nil {
			flusher.Flush()
		}
	}
	send(map[string]any{"type": "user", "message": userMsg})

	turns := append(turnsOf(conv.Messages), ai.Turn{Role: "user", Content: body.Content})
	reply, err := ai.Chat(r.Context(), provider, book, turns, func(d string) {
		send(map[string]any{"type": "delta", "text": d})
	})
	if err != nil {
		// Drop the unanswered user message so the history stays user/assistant alternating.
		s.Store.DeleteMessage(userMsg.ID)
		msg := err.Error()
		if errors.Is(err, ai.ErrRefused) {
			msg = "この内容には回答できませんでした（モデルが応答を拒否しました）"
		}
		send(map[string]any{"type": "error", "error": msg, "removedMessageId": userMsg.ID})
		return
	}
	am, err := s.Store.AddMessage(conv.ID, "assistant", reply)
	if err != nil {
		send(map[string]any{"type": "error", "error": err.Error()})
		return
	}
	send(map[string]any{"type": "done", "message": am})
}

// saved tells the client where an exported conversation went.
type saved struct {
	Memo *db.Memo `json:"memo,omitempty"`
	Note *db.Note `json:"note,omitempty"`
}

// saveConversation appends md to the conversation's memo, or to the book's
// note when the conversation has no memo (e.g. the memo was deleted).
func (s *Server) saveConversation(conv *db.Conversation, md string) (*saved, error) {
	if conv.MemoID != nil {
		if err := s.Store.AppendToMemo(*conv.MemoID, md); err != nil {
			return nil, err
		}
		m, err := s.Store.GetMemo(*conv.MemoID)
		return &saved{Memo: m}, err
	}
	n, err := s.Store.BookNote(conv.BookID)
	if err != nil {
		return nil, err
	}
	body := strings.TrimRight(n.Body, "\n")
	if body != "" {
		body += "\n\n"
	}
	body += md
	if err := s.Store.UpdateNote(n.ID, nil, &body); err != nil {
		return nil, err
	}
	n, err = s.Store.GetNote(n.ID)
	return &saved{Note: n}, err
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MessageIDs []string `json:"messageIds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	conv, err := s.Store.GetConversation(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	pick := map[string]bool{}
	for _, id := range body.MessageIDs {
		pick[id] = true
	}
	var sb strings.Builder
	if conv.Passage != "" && conv.MemoID == nil { // a memo already shows its passage
		sb.WriteString(quote(conv.Passage) + "\n\n")
	}
	for _, m := range conv.Messages {
		if len(pick) > 0 && !pick[m.ID] {
			continue
		}
		if m.Role == "user" {
			sb.WriteString("**Q.** " + m.Content + "\n\n")
		} else {
			sb.WriteString(m.Content + "\n\n")
		}
	}
	out, err := s.saveConversation(conv, strings.TrimSpace(sb.String()))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, out)
}

func (s *Server) summarize(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.provider(w)
	if !ok {
		return
	}
	conv, err := s.Store.GetConversation(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if len(conv.Messages) == 0 {
		writeErr(w, http.StatusBadRequest, "会話がまだありません")
		return
	}
	book, err := s.bookContext(conv)
	if err != nil {
		handleErr(w, err)
		return
	}
	md, err := ai.Summarize(r.Context(), provider, book, turnsOf(conv.Messages), conv.MemoID != nil)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	out, err := s.saveConversation(conv, strings.TrimSpace(md))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, out)
}

func quote(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

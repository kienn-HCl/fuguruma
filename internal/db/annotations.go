package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// ---- memos ----

// Memo kinds. A highlight memo marks a passage in the book (its body may be
// empty); a text memo is free text placed among the memos in the book's note,
// ordered by a locator copied from the memo it follows.
const (
	MemoHighlight = "highlight"
	MemoText      = "text"
)

type Memo struct {
	ID      string          `json:"id"`
	BookID  string          `json:"bookId"`
	Kind    string          `json:"kind"`
	Locator json.RawMessage `json:"locator"`
	// Label is a human-readable position, e.g. "第三章・42%" or "p.12".
	Label string `json:"label"`
	Text  string `json:"text"` // the quoted passage
	Color string `json:"color"`
	Body  string `json:"body"` // Markdown
	// Sort orders memos that share a position (text memos after the memo they follow).
	Sort      float64 `json:"sort"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

const memoCols = `id, book_id, kind, locator, label, text, color, body, sort, created_at, updated_at`

func scanMemo(r scanner) (*Memo, error) {
	var m Memo
	var loc string
	if err := r.Scan(&m.ID, &m.BookID, &m.Kind, &loc, &m.Label, &m.Text, &m.Color, &m.Body, &m.Sort, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return nil, err
	}
	m.Locator = json.RawMessage(loc)
	return &m, nil
}

func (s *Store) ListMemos(bookID string) ([]*Memo, error) {
	rows, err := s.DB.Query(`SELECT `+memoCols+` FROM memos WHERE book_id = ? ORDER BY sort`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Memo{}
	for rows.Next() {
		m, err := scanMemo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetMemo(id string) (*Memo, error) {
	m, err := scanMemo(s.DB.QueryRow(`SELECT `+memoCols+` FROM memos WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

func (s *Store) CreateMemo(m *Memo) error {
	m.ID = NewID()
	m.CreatedAt = Now()
	m.UpdatedAt = m.CreatedAt
	if m.Kind != MemoText {
		m.Kind = MemoHighlight
	}
	if m.Color == "" {
		m.Color = "yellow"
	}
	if m.Sort == 0 {
		m.Sort = float64(m.CreatedAt)
	}
	if _, err := s.DB.Exec(`INSERT INTO memos (`+memoCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.BookID, m.Kind, string(m.Locator), m.Label, m.Text, m.Color, m.Body, m.Sort, m.CreatedAt, m.UpdatedAt); err != nil {
		return err
	}
	return s.touchBookNote(m.BookID)
}

type MemoUpdate struct {
	Color, Body *string
}

func (s *Store) UpdateMemo(id string, u MemoUpdate) error {
	m, err := s.GetMemo(id)
	if err != nil {
		return err
	}
	if u.Color != nil {
		m.Color = *u.Color
	}
	if u.Body != nil {
		m.Body = *u.Body
	}
	if _, err := s.DB.Exec(`UPDATE memos SET color = ?, body = ?, updated_at = ? WHERE id = ?`, m.Color, m.Body, Now(), id); err != nil {
		return err
	}
	return s.touchBookNote(m.BookID)
}

// AppendToMemo adds Markdown to the end of a memo's body.
func (s *Store) AppendToMemo(id, md string) error {
	m, err := s.GetMemo(id)
	if err != nil {
		return err
	}
	body := strings.TrimRight(m.Body, "\n")
	if body != "" {
		body += "\n\n"
	}
	body += md
	return s.UpdateMemo(id, MemoUpdate{Body: &body})
}

func (s *Store) DeleteMemo(id string) error {
	m, err := s.GetMemo(id)
	if err != nil {
		return err
	}
	if _, err := s.DB.Exec(`DELETE FROM memos WHERE id = ?`, id); err != nil {
		return err
	}
	return s.touchBookNote(m.BookID)
}

// ---- notes ----

// A note is either the note of a book (one per book: a Markdown introduction
// shown above the book's memos) or a free-standing Markdown document.
type Note struct {
	ID        string  `json:"id"`
	BookID    *string `json:"bookId"`
	BookTitle string  `json:"bookTitle,omitempty"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	MemoCount int     `json:"memoCount"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

const noteCols = `n.id, n.book_id, COALESCE(b.title, ''), n.title, n.body,
	(SELECT COUNT(*) FROM memos m WHERE m.book_id = n.book_id), n.created_at, n.updated_at`

func scanNote(r scanner) (*Note, error) {
	var n Note
	var bid sql.NullString
	if err := r.Scan(&n.ID, &bid, &n.BookTitle, &n.Title, &n.Body, &n.MemoCount, &n.CreatedAt, &n.UpdatedAt); err != nil {
		return nil, err
	}
	if bid.Valid {
		n.BookID = &bid.String
	}
	return &n, nil
}

// ListNotes lists free notes and the notes of books that have something in
// them. q matches note titles and bodies, and the memos of a book's note.
func (s *Store) ListNotes(bookID, q string) ([]*Note, error) {
	sqlStr := `SELECT ` + noteCols + ` FROM notes n LEFT JOIN books b ON b.id = n.book_id
		WHERE (n.book_id IS NULL OR n.body != '' OR EXISTS (SELECT 1 FROM memos m WHERE m.book_id = n.book_id))`
	var args []any
	if bookID != "" {
		sqlStr += ` AND n.book_id = ?`
		args = append(args, bookID)
	}
	if q != "" {
		like := "%" + q + "%"
		sqlStr += ` AND (n.title LIKE ? OR n.body LIKE ? OR b.title LIKE ? OR EXISTS
			(SELECT 1 FROM memos m WHERE m.book_id = n.book_id AND (m.body LIKE ? OR m.text LIKE ?)))`
		args = append(args, like, like, like, like, like)
	}
	sqlStr += ` ORDER BY n.updated_at DESC`
	rows, err := s.DB.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Note{}
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) GetNote(id string) (*Note, error) {
	n, err := scanNote(s.DB.QueryRow(`SELECT `+noteCols+` FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return n, err
}

// BookNote returns the note of a book, creating an empty one if needed.
func (s *Store) BookNote(bookID string) (*Note, error) {
	if err := s.ensureBookNote(bookID); err != nil {
		return nil, err
	}
	n, err := scanNote(s.DB.QueryRow(`SELECT `+noteCols+` FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return n, err
}

func (s *Store) ensureBookNote(bookID string) error {
	now := Now()
	_, err := s.DB.Exec(`INSERT INTO notes (id, book_id, title, body, created_at, updated_at)
		SELECT ?, id, '', '', ?, ? FROM books WHERE id = ? AND NOT EXISTS (SELECT 1 FROM notes WHERE book_id = ?)`,
		NewID(), now, now, bookID, bookID)
	return err
}

// touchBookNote marks a book's note as updated when its memos change.
func (s *Store) touchBookNote(bookID string) error {
	if err := s.ensureBookNote(bookID); err != nil {
		return err
	}
	_, err := s.DB.Exec(`UPDATE notes SET updated_at = ? WHERE book_id = ?`, Now(), bookID)
	return err
}

// CreateNote creates a free-standing note (book notes come from BookNote).
func (s *Store) CreateNote(n *Note) error {
	n.ID = NewID()
	n.BookID = nil
	n.CreatedAt = Now()
	n.UpdatedAt = n.CreatedAt
	_, err := s.DB.Exec(`INSERT INTO notes (id, book_id, title, body, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)`,
		n.ID, n.Title, n.Body, n.CreatedAt, n.UpdatedAt)
	return err
}

func (s *Store) UpdateNote(id string, title, body *string) error {
	if title != nil {
		if _, err := s.DB.Exec(`UPDATE notes SET title = ?, updated_at = ? WHERE id = ?`, *title, Now(), id); err != nil {
			return err
		}
	}
	if body != nil {
		if _, err := s.DB.Exec(`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`, *body, Now(), id); err != nil {
			return err
		}
	}
	return nil
}

// ErrBookNote is returned when deleting the note of a book.
var ErrBookNote = errors.New("the note of a book cannot be deleted")

func (s *Store) DeleteNote(id string) error {
	n, err := s.GetNote(id)
	if err != nil {
		return err
	}
	if n.BookID != nil {
		return ErrBookNote
	}
	_, err = s.DB.Exec(`DELETE FROM notes WHERE id = ?`, id)
	return err
}

// ---- AI conversations ----

type Conversation struct {
	ID        string          `json:"id"`
	BookID    string          `json:"bookId"`
	Title     string          `json:"title"`
	Passage   string          `json:"passage"`
	Context   string          `json:"context,omitempty"`
	Locator   json.RawMessage `json:"locator"`
	MemoID    *string         `json:"memoId"` // the memo the conversation belongs to
	CreatedAt int64           `json:"createdAt"`
	UpdatedAt int64           `json:"updatedAt"`
	Messages  []Message       `json:"messages,omitempty"`
}

type Message struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	CreatedAt      int64  `json:"createdAt"`
}

func scanConv(r scanner) (*Conversation, error) {
	var c Conversation
	var loc string
	var memo sql.NullString
	if err := r.Scan(&c.ID, &c.BookID, &c.Title, &c.Passage, &c.Context, &loc, &memo, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, err
	}
	if memo.Valid {
		c.MemoID = &memo.String
	}
	if loc == "" {
		loc = "null"
	}
	c.Locator = json.RawMessage(loc)
	return &c, nil
}

const convCols = `id, book_id, title, passage, context, locator, memo_id, created_at, updated_at`

func (s *Store) ListConversations(bookID string) ([]*Conversation, error) {
	rows, err := s.DB.Query(`SELECT `+convCols+` FROM conversations WHERE book_id = ? ORDER BY updated_at DESC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Conversation{}
	for rows.Next() {
		c, err := scanConv(rows)
		if err != nil {
			return nil, err
		}
		c.Context = "" // not needed in listings
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetConversation(id string) (*Conversation, error) {
	c, err := scanConv(s.DB.QueryRow(`SELECT `+convCols+` FROM conversations WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(`SELECT id, conversation_id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	c.Messages = []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.CreatedAt); err != nil {
			return nil, err
		}
		c.Messages = append(c.Messages, m)
	}
	return c, rows.Err()
}

func (s *Store) CreateConversation(c *Conversation) error {
	c.ID = NewID()
	c.CreatedAt = Now()
	c.UpdatedAt = c.CreatedAt
	if len(c.Locator) == 0 {
		c.Locator = json.RawMessage("null")
	}
	_, err := s.DB.Exec(`INSERT INTO conversations (`+convCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.BookID, c.Title, c.Passage, c.Context, string(c.Locator), c.MemoID, c.CreatedAt, c.UpdatedAt)
	return err
}

func (s *Store) RenameConversation(id, title string) error {
	_, err := s.DB.Exec(`UPDATE conversations SET title = ? WHERE id = ?`, title, id)
	return err
}

func (s *Store) DeleteConversation(id string) error {
	_, err := s.DB.Exec(`DELETE FROM conversations WHERE id = ?`, id)
	return err
}

func (s *Store) AddMessage(convID, role, content string) (*Message, error) {
	m := &Message{ID: NewID(), ConversationID: convID, Role: role, Content: content, CreatedAt: Now()}
	if _, err := s.DB.Exec(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		m.ID, m.ConversationID, m.Role, m.Content, m.CreatedAt); err != nil {
		return nil, err
	}
	_, err := s.DB.Exec(`UPDATE conversations SET updated_at = ? WHERE id = ?`, m.CreatedAt, convID)
	return m, err
}

func (s *Store) DeleteMessage(id string) error {
	_, err := s.DB.Exec(`DELETE FROM messages WHERE id = ?`, id)
	return err
}

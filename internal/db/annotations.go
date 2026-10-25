package db

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// ---- highlights ----

type Highlight struct {
	ID        string          `json:"id"`
	BookID    string          `json:"bookId"`
	Locator   json.RawMessage `json:"locator"`
	Text      string          `json:"text"`
	Color     string          `json:"color"`
	Comment   string          `json:"comment"`
	CreatedAt int64           `json:"createdAt"`
	UpdatedAt int64           `json:"updatedAt"`
}

func (s *Store) ListHighlights(bookID string) ([]Highlight, error) {
	rows, err := s.DB.Query(`SELECT id, book_id, locator, text, color, comment, created_at, updated_at FROM highlights WHERE book_id = ? ORDER BY created_at`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Highlight{}
	for rows.Next() {
		var h Highlight
		var loc string
		if err := rows.Scan(&h.ID, &h.BookID, &loc, &h.Text, &h.Color, &h.Comment, &h.CreatedAt, &h.UpdatedAt); err != nil {
			return nil, err
		}
		h.Locator = json.RawMessage(loc)
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) CreateHighlight(h *Highlight) error {
	h.ID = NewID()
	h.CreatedAt = Now()
	h.UpdatedAt = h.CreatedAt
	if h.Color == "" {
		h.Color = "yellow"
	}
	_, err := s.DB.Exec(`INSERT INTO highlights (id, book_id, locator, text, color, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		h.ID, h.BookID, string(h.Locator), h.Text, h.Color, h.Comment, h.CreatedAt, h.UpdatedAt)
	return err
}

func (s *Store) GetHighlight(id string) (*Highlight, error) {
	var h Highlight
	var loc string
	err := s.DB.QueryRow(`SELECT id, book_id, locator, text, color, comment, created_at, updated_at FROM highlights WHERE id = ?`, id).
		Scan(&h.ID, &h.BookID, &loc, &h.Text, &h.Color, &h.Comment, &h.CreatedAt, &h.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	h.Locator = json.RawMessage(loc)
	return &h, err
}

func (s *Store) UpdateHighlight(id string, color, comment *string) error {
	if color != nil {
		if _, err := s.DB.Exec(`UPDATE highlights SET color = ?, updated_at = ? WHERE id = ?`, *color, Now(), id); err != nil {
			return err
		}
	}
	if comment != nil {
		if _, err := s.DB.Exec(`UPDATE highlights SET comment = ?, updated_at = ? WHERE id = ?`, *comment, Now(), id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteHighlight(id string) error {
	_, err := s.DB.Exec(`DELETE FROM highlights WHERE id = ?`, id)
	return err
}

// ---- notes ----

type Note struct {
	ID        string  `json:"id"`
	BookID    *string `json:"bookId"`
	BookTitle string  `json:"bookTitle,omitempty"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	// Locator pins the note to a position in its book (null when not pinned);
	// LocatorLabel is a human-readable description such as "第三章・42%".
	Locator      json.RawMessage `json:"locator"`
	LocatorLabel string          `json:"locatorLabel"`
	CreatedAt    int64           `json:"createdAt"`
	UpdatedAt    int64           `json:"updatedAt"`
}

const noteCols = `n.id, n.book_id, COALESCE(b.title, ''), n.title, n.body, n.locator, n.locator_label, n.created_at, n.updated_at`

func scanNote(r scanner) (*Note, error) {
	var n Note
	var bid sql.NullString
	var loc string
	if err := r.Scan(&n.ID, &bid, &n.BookTitle, &n.Title, &n.Body, &loc, &n.LocatorLabel, &n.CreatedAt, &n.UpdatedAt); err != nil {
		return nil, err
	}
	if bid.Valid {
		n.BookID = &bid.String
	}
	if loc == "" {
		loc = "null"
	}
	n.Locator = json.RawMessage(loc)
	return &n, nil
}

func (s *Store) ListNotes(bookID, q string) ([]*Note, error) {
	sqlStr := `SELECT ` + noteCols + ` FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE 1=1`
	var args []any
	if bookID != "" {
		sqlStr += ` AND n.book_id = ?`
		args = append(args, bookID)
	}
	if q != "" {
		sqlStr += ` AND (n.title LIKE ? OR n.body LIKE ?)`
		args = append(args, "%"+q+"%", "%"+q+"%")
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

func (s *Store) CreateNote(n *Note) error {
	n.ID = NewID()
	n.CreatedAt = Now()
	n.UpdatedAt = n.CreatedAt
	if string(n.Locator) == "null" {
		n.Locator = nil
	}
	_, err := s.DB.Exec(`INSERT INTO notes (id, book_id, title, body, locator, locator_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.BookID, n.Title, n.Body, string(n.Locator), n.LocatorLabel, n.CreatedAt, n.UpdatedAt)
	if len(n.Locator) == 0 {
		n.Locator = json.RawMessage("null")
	}
	return err
}

// NoteUpdate holds the fields to change; nil fields are left as they are.
// A Locator of JSON null unpins the note.
type NoteUpdate struct {
	Title        *string
	Body         *string
	Locator      *json.RawMessage
	LocatorLabel *string
}

func (s *Store) UpdateNote(id string, u NoteUpdate) error {
	set := func(col string, v any) error {
		_, err := s.DB.Exec(`UPDATE notes SET `+col+` = ?, updated_at = ? WHERE id = ?`, v, Now(), id)
		return err
	}
	if u.Title != nil {
		if err := set("title", *u.Title); err != nil {
			return err
		}
	}
	if u.Body != nil {
		if err := set("body", *u.Body); err != nil {
			return err
		}
	}
	if u.Locator != nil {
		loc := string(*u.Locator)
		if loc == "null" {
			loc = ""
		}
		if err := set("locator", loc); err != nil {
			return err
		}
	}
	if u.LocatorLabel != nil {
		if err := set("locator_label", *u.LocatorLabel); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteNote(id string) error {
	_, err := s.DB.Exec(`DELETE FROM notes WHERE id = ?`, id)
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
	if err := r.Scan(&c.ID, &c.BookID, &c.Title, &c.Passage, &c.Context, &loc, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, err
	}
	if loc == "" {
		loc = "null"
	}
	c.Locator = json.RawMessage(loc)
	return &c, nil
}

const convCols = `id, book_id, title, passage, context, locator, created_at, updated_at`

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
	_, err := s.DB.Exec(`INSERT INTO conversations (`+convCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.BookID, c.Title, c.Passage, c.Context, string(c.Locator), c.CreatedAt, c.UpdatedAt)
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

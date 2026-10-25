package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

var ErrNotFound = errors.New("not found")

type Book struct {
	ID           string    `json:"id"`
	Path         string    `json:"path"`
	Format       string    `json:"format"`
	Title        string    `json:"title"`
	Author       string    `json:"author"`
	Description  string    `json:"description"`
	Fingerprint  string    `json:"-"`
	Size         int64     `json:"size"`
	Mtime        int64     `json:"-"`
	HasCover     bool      `json:"hasCover"`
	Missing      bool      `json:"missing"`
	AddedAt      int64     `json:"addedAt"`
	UpdatedAt    int64     `json:"updatedAt"`
	LastOpenedAt int64     `json:"lastOpenedAt"`
	Tags         []Tag     `json:"tags"`
	Progress     *Progress `json:"progress"`
}

type Tag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	Count int    `json:"count,omitempty"`
}

type Progress struct {
	Locator   json.RawMessage `json:"locator"`
	Percent   float64         `json:"percent"`
	UpdatedAt int64           `json:"updatedAt"`
}

const bookCols = `b.id, b.path, b.format, b.title, b.author, b.description, b.fingerprint,
	b.size, b.mtime, b.has_cover, b.missing, b.added_at, b.updated_at, b.last_opened_at,
	p.locator, p.percent, p.updated_at`

type scanner interface{ Scan(...any) error }

func scanBook(r scanner) (*Book, error) {
	var b Book
	var hasCover, missing int
	var loc sql.NullString
	var pct sql.NullFloat64
	var pUpd sql.NullInt64
	err := r.Scan(&b.ID, &b.Path, &b.Format, &b.Title, &b.Author, &b.Description, &b.Fingerprint,
		&b.Size, &b.Mtime, &hasCover, &missing, &b.AddedAt, &b.UpdatedAt, &b.LastOpenedAt,
		&loc, &pct, &pUpd)
	if err != nil {
		return nil, err
	}
	b.HasCover, b.Missing = hasCover == 1, missing == 1
	if loc.Valid {
		b.Progress = &Progress{Locator: json.RawMessage(loc.String), Percent: pct.Float64, UpdatedAt: pUpd.Int64}
	}
	b.Tags = []Tag{}
	return &b, nil
}

type BookQuery struct {
	Q     string
	TagID int64
	Sort  string // recent | added | title
}

func (s *Store) ListBooks(q BookQuery) ([]*Book, error) {
	var where []string
	var args []any
	if q.Q != "" {
		where = append(where, `(b.title LIKE ? OR b.author LIKE ? OR b.path LIKE ?)`)
		like := "%" + q.Q + "%"
		args = append(args, like, like, like)
	}
	if q.TagID > 0 {
		where = append(where, `b.id IN (SELECT book_id FROM book_tags WHERE tag_id = ?)`)
		args = append(args, q.TagID)
	}
	sqlStr := `SELECT ` + bookCols + ` FROM books b LEFT JOIN progress p ON p.book_id = b.id`
	if len(where) > 0 {
		sqlStr += ` WHERE ` + strings.Join(where, " AND ")
	}
	switch q.Sort {
	case "title":
		sqlStr += ` ORDER BY b.title COLLATE NOCASE`
	case "added":
		sqlStr += ` ORDER BY b.added_at DESC`
	default:
		sqlStr += ` ORDER BY MAX(b.last_opened_at, COALESCE(p.updated_at, 0)) DESC, b.added_at DESC`
	}
	rows, err := s.DB.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var books []*Book
	byID := map[string]*Book{}
	for rows.Next() {
		b, err := scanBook(rows)
		if err != nil {
			return nil, err
		}
		books = append(books, b)
		byID[b.ID] = b
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	trows, err := s.DB.Query(`SELECT bt.book_id, t.id, t.name, t.color FROM book_tags bt JOIN tags t ON t.id = bt.tag_id ORDER BY t.name`)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var bid string
		var t Tag
		if err := trows.Scan(&bid, &t.ID, &t.Name, &t.Color); err != nil {
			return nil, err
		}
		if b := byID[bid]; b != nil {
			b.Tags = append(b.Tags, t)
		}
	}
	if books == nil {
		books = []*Book{}
	}
	return books, trows.Err()
}

func (s *Store) GetBook(id string) (*Book, error) {
	b, err := scanBook(s.DB.QueryRow(`SELECT `+bookCols+` FROM books b LEFT JOIN progress p ON p.book_id = b.id WHERE b.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(`SELECT t.id, t.name, t.color FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = ? ORDER BY t.name`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Name, &t.Color); err != nil {
			return nil, err
		}
		b.Tags = append(b.Tags, t)
	}
	return b, rows.Err()
}

// AllBookFiles returns path/fingerprint data used by the scanner.
func (s *Store) AllBookFiles() ([]*Book, error) {
	rows, err := s.DB.Query(`SELECT ` + bookCols + ` FROM books b LEFT JOIN progress p ON p.book_id = b.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Book
	for rows.Next() {
		b, err := scanBook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) InsertBook(b *Book) error {
	_, err := s.DB.Exec(`INSERT INTO books (id, path, format, title, author, description, fingerprint, size, mtime, has_cover, missing, added_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		b.ID, b.Path, b.Format, b.Title, b.Author, b.Description, b.Fingerprint, b.Size, b.Mtime, boolInt(b.HasCover), b.AddedAt, b.UpdatedAt)
	return err
}

// UpdateBookFile records a (possibly moved) file location for an existing book.
func (s *Store) UpdateBookFile(id, path, fingerprint string, size, mtime int64) error {
	_, err := s.DB.Exec(`UPDATE books SET path = ?, fingerprint = ?, size = ?, mtime = ?, missing = 0, updated_at = ? WHERE id = ?`,
		path, fingerprint, size, mtime, Now(), id)
	return err
}

func (s *Store) SetMissing(id string, missing bool) error {
	_, err := s.DB.Exec(`UPDATE books SET missing = ? WHERE id = ?`, boolInt(missing), id)
	return err
}

func (s *Store) SetHasCover(id string, v bool) error {
	_, err := s.DB.Exec(`UPDATE books SET has_cover = ?, updated_at = ? WHERE id = ?`, boolInt(v), Now(), id)
	return err
}

func (s *Store) UpdateBookMeta(id string, title, author *string) error {
	if title != nil {
		if _, err := s.DB.Exec(`UPDATE books SET title = ?, updated_at = ? WHERE id = ?`, *title, Now(), id); err != nil {
			return err
		}
	}
	if author != nil {
		if _, err := s.DB.Exec(`UPDATE books SET author = ?, updated_at = ? WHERE id = ?`, *author, Now(), id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) TouchOpened(id string) error {
	_, err := s.DB.Exec(`UPDATE books SET last_opened_at = ? WHERE id = ?`, Now(), id)
	return err
}

func (s *Store) GetProgress(bookID string) (*Progress, error) {
	var p Progress
	var loc string
	err := s.DB.QueryRow(`SELECT locator, percent, updated_at FROM progress WHERE book_id = ?`, bookID).Scan(&loc, &p.Percent, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	p.Locator = json.RawMessage(loc)
	return &p, err
}

// SaveProgress is last-write-wins by the client-supplied timestamp, so a stale
// tab cannot rewind a position saved later from another device.
func (s *Store) SaveProgress(bookID string, p Progress) (*Progress, error) {
	if p.UpdatedAt == 0 {
		p.UpdatedAt = Now()
	}
	_, err := s.DB.Exec(`INSERT INTO progress (book_id, locator, percent, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(book_id) DO UPDATE SET locator = excluded.locator, percent = excluded.percent, updated_at = excluded.updated_at
		WHERE excluded.updated_at >= progress.updated_at`,
		bookID, string(p.Locator), p.Percent, p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return s.GetProgress(bookID)
}

// ---- tags ----

func (s *Store) ListTags() ([]Tag, error) {
	rows, err := s.DB.Query(`SELECT t.id, t.name, t.color, COUNT(bt.book_id) FROM tags t LEFT JOIN book_tags bt ON bt.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tag{}
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Name, &t.Color, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) CreateTag(name, color string) (*Tag, error) {
	if color == "" {
		color = "#8a8a8a"
	}
	res, err := s.DB.Exec(`INSERT INTO tags (name, color) VALUES (?, ?)`, name, color)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Tag{ID: id, Name: name, Color: color}, nil
}

func (s *Store) UpdateTag(id int64, name, color *string) error {
	if name != nil {
		if _, err := s.DB.Exec(`UPDATE tags SET name = ? WHERE id = ?`, *name, id); err != nil {
			return err
		}
	}
	if color != nil {
		if _, err := s.DB.Exec(`UPDATE tags SET color = ? WHERE id = ?`, *color, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteTag(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM tags WHERE id = ?`, id)
	return err
}

func (s *Store) SetBookTags(bookID string, tagIDs []int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM book_tags WHERE book_id = ?`, bookID); err != nil {
		return err
	}
	for _, t := range tagIDs {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)`, bookID, t); err != nil {
			return err
		}
	}
	return tx.Commit()
}

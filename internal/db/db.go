// Package db wraps the SQLite database that stores everything except the book
// files themselves.
package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", path)
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite allows a single writer; one connection avoids SQLITE_BUSY churn.
	d.SetMaxOpenConns(1)
	s := &Store{DB: d}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

var migrations = []string{
	`CREATE TABLE books (
		id TEXT PRIMARY KEY,
		path TEXT NOT NULL UNIQUE,
		format TEXT NOT NULL,
		title TEXT NOT NULL,
		author TEXT NOT NULL DEFAULT '',
		description TEXT NOT NULL DEFAULT '',
		fingerprint TEXT NOT NULL,
		size INTEGER NOT NULL,
		mtime INTEGER NOT NULL,
		has_cover INTEGER NOT NULL DEFAULT 0,
		missing INTEGER NOT NULL DEFAULT 0,
		added_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		last_opened_at INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX books_fingerprint ON books(fingerprint);
	CREATE TABLE tags (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		color TEXT NOT NULL DEFAULT '#8a8a8a'
	);
	CREATE TABLE book_tags (
		book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (book_id, tag_id)
	);
	CREATE TABLE progress (
		book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
		locator TEXT NOT NULL,
		percent REAL NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE highlights (
		id TEXT PRIMARY KEY,
		book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		locator TEXT NOT NULL,
		text TEXT NOT NULL,
		color TEXT NOT NULL DEFAULT 'yellow',
		comment TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX highlights_book ON highlights(book_id);
	CREATE TABLE notes (
		id TEXT PRIMARY KEY,
		book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
		title TEXT NOT NULL DEFAULT '',
		body TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX notes_book ON notes(book_id);
	CREATE TABLE conversations (
		id TEXT PRIMARY KEY,
		book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		title TEXT NOT NULL DEFAULT '',
		passage TEXT NOT NULL DEFAULT '',
		context TEXT NOT NULL DEFAULT '',
		locator TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX conversations_book ON conversations(book_id);
	CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		role TEXT NOT NULL,
		content TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX messages_conv ON messages(conversation_id, created_at);`,
}

func (s *Store) migrate() error {
	var v int
	if err := s.DB.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i := v; i < len(migrations); i++ {
		tx, err := s.DB.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func NewID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func Now() int64 { return time.Now().UnixMilli() }

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

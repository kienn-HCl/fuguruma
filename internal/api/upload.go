package api

import (
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/kienn-HCl/fuguruma/internal/library"
)

// upload stores one book sent as multipart/form-data:
//
//	tagIds: optional, comma-separated tag IDs to apply
//	file:   the .epub / .pdf file (must come after tagIds)
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	cfg := s.Conf.Get().Library
	if !cfg.UploadEnabled {
		writeErr(w, http.StatusForbidden, "アップロードは無効に設定されています")
		return
	}
	maxBytes := int64(cfg.UploadMaxMB) << 20
	// Allow some room for the multipart envelope; Import enforces the file limit itself.
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "multipart/form-data で送信してください")
		return
	}
	var tagIDs []int64
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			writeErr(w, http.StatusBadRequest, "file がありません")
			return
		}
		if err != nil {
			uploadErr(w, err, cfg.UploadMaxMB)
			return
		}
		switch part.FormName() {
		case "tagIds":
			tagIDs, err = readTagIDs(part)
			if err != nil {
				writeErr(w, http.StatusBadRequest, "tagIds が不正です")
				return
			}
		case "file":
			book, err := s.Lib.Import(part.FileName(), part, cfg.UploadDir, maxBytes)
			if err != nil {
				uploadErr(w, err, cfg.UploadMaxMB)
				return
			}
			log.Printf("upload: %s", book.Path)
			if len(tagIDs) > 0 {
				if err := s.Store.SetBookTags(book.ID, tagIDs); err != nil {
					log.Printf("upload: tags for %s: %v", book.Path, err)
				}
			}
			b, err := s.Store.GetBook(book.ID)
			if err != nil {
				handleErr(w, err)
				return
			}
			w.WriteHeader(http.StatusCreated)
			writeJSON(w, b)
			return
		}
	}
}

func readTagIDs(part *multipart.Part) ([]int64, error) {
	raw, err := io.ReadAll(io.LimitReader(part, 4096))
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, f := range strings.Split(string(raw), ",") {
		if f = strings.TrimSpace(f); f == "" {
			continue
		}
		id, err := strconv.ParseInt(f, 10, 64)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func uploadErr(w http.ResponseWriter, err error, maxMB int) {
	var dup *library.DuplicateError
	var nw *library.NotWritableError
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &dup):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		writeJSON(w, map[string]string{"error": "同じ内容の本がすでにあります: " + dup.Book.Title, "bookId": dup.Book.ID})
	case errors.Is(err, library.ErrTooLarge), errors.As(err, &tooBig):
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("ファイルが大きすぎます（上限 %d MB）", maxMB))
	case errors.Is(err, library.ErrUnsupportedFormat):
		writeErr(w, http.StatusUnsupportedMediaType, "対応していない形式です（.epub / .pdf のみ）")
	case errors.Is(err, library.ErrInvalidFile):
		writeErr(w, http.StatusBadRequest, "ファイルの中身が拡張子と一致しないか、壊れています")
	case errors.As(err, &nw):
		log.Printf("upload: %v", err)
		writeErr(w, http.StatusInternalServerError, "本のディレクトリに書き込めません（読み取り専用でマウントされているか、権限がありません）")
	default:
		handleErr(w, err)
	}
}

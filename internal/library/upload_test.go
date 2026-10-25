package library

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kienn-HCl/fuguruma/internal/db"
)

func newTestLibrary(t *testing.T) *Library {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "books")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store, err := db.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	lib, err := New(root, dir, store)
	if err != nil {
		t.Fatal(err)
	}
	return lib
}

func pdfBytes(body string) []byte {
	return []byte("%PDF-1.4\n" + body + "\n%%EOF\n")
}

func epubBytes(t *testing.T, title string) []byte {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	write := func(name, content string) {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	write("mimetype", "application/epub+zip")
	write("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
	write("content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>`+title+`</dc:title><dc:creator>Author</dc:creator></metadata><manifest/></package>`)
	z.Close()
	return buf.Bytes()
}

func TestSanitizeFileName(t *testing.T) {
	for in, want := range map[string]string{
		"book.PDF":                 "book.pdf",
		"../../etc/passwd.pdf":     "passwd.pdf",
		`C:\Users\me\本.epub`:       "本.epub",
		".hidden.pdf":              "hidden.pdf",
		"a<b>c:d|e?f*.pdf":         "a_b_c_d_e_f_.pdf",
		"tab\there.pdf":            "tab_here.pdf",
		"  spaced name . pdf.pdf ": "spaced name . pdf.pdf",
		".pdf":                     "pdf", // no extension left: rejected as unsupported
		"...":                      "book",
	} {
		if got := SanitizeFileName(in); got != want {
			t.Errorf("SanitizeFileName(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("あ", 100) + ".epub" // 300 bytes of base name
	got := SanitizeFileName(long)
	if len(got) > 210 || !strings.HasSuffix(got, ".epub") || !strings.HasPrefix(got, "あ") {
		t.Errorf("long name not truncated on a rune boundary: %q (%d bytes)", got, len(got))
	}
}

func TestImportPDFAndEPUB(t *testing.T) {
	lib := newTestLibrary(t)
	b, err := lib.Import("My Book.pdf", bytes.NewReader(pdfBytes("one")), "Uploads", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if b.Path != "Uploads/My Book.pdf" || b.Format != "pdf" || b.Title != "My Book" {
		t.Errorf("unexpected book: %+v", b)
	}
	if st, err := os.Stat(filepath.Join(lib.Root, "Uploads", "My Book.pdf")); err != nil || st.Mode().Perm() != 0o644 {
		t.Errorf("file not stored with 0644: %v %v", st, err)
	}

	e, err := lib.Import("x.epub", bytes.NewReader(epubBytes(t, "吾輩は猫である")), "Uploads", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if e.Title != "吾輩は猫である" || e.Author != "Author" {
		t.Errorf("EPUB metadata not read: %+v", e)
	}

	// No temp files left behind.
	entries, _ := os.ReadDir(filepath.Join(lib.Root, "Uploads"))
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), ".") {
			t.Errorf("leftover temp file %s", en.Name())
		}
	}
}

func TestImportNeverOverwrites(t *testing.T) {
	lib := newTestLibrary(t)
	dir := filepath.Join(lib.Root, "Uploads")
	os.MkdirAll(dir, 0o755)
	original := []byte("existing file, must stay untouched")
	os.WriteFile(filepath.Join(dir, "same.pdf"), original, 0o644)

	b, err := lib.Import("same.pdf", bytes.NewReader(pdfBytes("new")), "Uploads", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if b.Path != "Uploads/same (2).pdf" {
		t.Errorf("expected a new name, got %s", b.Path)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "same.pdf")); !bytes.Equal(got, original) {
		t.Error("existing file was modified")
	}
}

func TestImportRejects(t *testing.T) {
	lib := newTestLibrary(t)
	if _, err := lib.Import("a.pdf", bytes.NewReader(pdfBytes("dup")), "", 1<<20); err != nil {
		t.Fatal(err)
	}
	var dup *DuplicateError
	if _, err := lib.Import("b.pdf", bytes.NewReader(pdfBytes("dup")), "", 1<<20); !errors.As(err, &dup) || dup.Book.Path != "a.pdf" {
		t.Errorf("duplicate not detected: %v", err)
	}
	if _, err := lib.Import("a.txt", strings.NewReader("hello"), "", 1<<20); !errors.Is(err, ErrUnsupportedFormat) {
		t.Errorf("unsupported type accepted: %v", err)
	}
	if _, err := lib.Import("fake.pdf", strings.NewReader("<html>not a pdf</html>"), "", 1<<20); !errors.Is(err, ErrInvalidFile) {
		t.Errorf("fake PDF accepted: %v", err)
	}
	if _, err := lib.Import("fake.epub", bytes.NewReader(pdfBytes("x")), "", 1<<20); !errors.Is(err, ErrInvalidFile) {
		t.Errorf("fake EPUB accepted: %v", err)
	}
	if _, err := lib.Import("big.pdf", bytes.NewReader(pdfBytes(strings.Repeat("x", 2000))), "", 1000); !errors.Is(err, ErrTooLarge) {
		t.Errorf("size limit not enforced: %v", err)
	}
	var nw *NotWritableError
	if _, err := lib.Import("c.pdf", bytes.NewReader(pdfBytes("c")), "../outside", 1<<20); !errors.As(err, &nw) {
		t.Errorf("upload outside the library accepted: %v", err)
	}
	entries, _ := os.ReadDir(lib.Root)
	if len(entries) != 1 {
		t.Errorf("rejected uploads left files behind: %v", entries)
	}
}

func TestImportReattachesMissingBook(t *testing.T) {
	lib := newTestLibrary(t)
	b, err := lib.Import("orig.pdf", bytes.NewReader(pdfBytes("same content")), "", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	// Another book keeps the library non-empty, so Scan does not treat it as unmounted.
	if _, err := lib.Import("other.pdf", bytes.NewReader(pdfBytes("other")), "", 1<<20); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(lib.Root, "orig.pdf"))
	if _, err := lib.Scan(); err != nil {
		t.Fatal(err)
	}
	again, err := lib.Import("again.pdf", bytes.NewReader(pdfBytes("same content")), "Uploads", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != b.ID || again.Missing || again.Path != "Uploads/again.pdf" {
		t.Errorf("missing book not re-attached: %+v", again)
	}
}

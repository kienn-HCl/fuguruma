package library

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"strings"
)

type EpubMeta struct {
	Title       string
	Author      string
	Description string
	Cover       []byte
}

type container struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type opf struct {
	Metadata struct {
		Titles       []string `xml:"title"`
		Creators     []string `xml:"creator"`
		Descriptions []string `xml:"description"`
		Metas        []struct {
			Name    string `xml:"name,attr"`
			Content string `xml:"content,attr"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest []struct {
		ID         string `xml:"id,attr"`
		Href       string `xml:"href,attr"`
		MediaType  string `xml:"media-type,attr"`
		Properties string `xml:"properties,attr"`
	} `xml:"manifest>item"`
}

// ReadEpubMeta extracts title/author/description and the cover image bytes.
func ReadEpubMeta(file string) (*EpubMeta, error) {
	zr, err := zip.OpenReader(file)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	read := func(name string) ([]byte, error) {
		f, ok := files[name]
		if !ok {
			return nil, errors.New("missing " + name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(io.LimitReader(rc, 20<<20))
	}

	cb, err := read("META-INF/container.xml")
	if err != nil {
		return nil, err
	}
	var c container
	if err := xml.Unmarshal(cb, &c); err != nil || len(c.Rootfiles) == 0 {
		return nil, errors.New("invalid container.xml")
	}
	opfPath := c.Rootfiles[0].FullPath
	ob, err := read(opfPath)
	if err != nil {
		return nil, err
	}
	var o opf
	if err := xml.Unmarshal(ob, &o); err != nil {
		return nil, err
	}
	m := &EpubMeta{}
	if len(o.Metadata.Titles) > 0 {
		m.Title = strings.TrimSpace(o.Metadata.Titles[0])
	}
	if len(o.Metadata.Creators) > 0 {
		m.Author = strings.TrimSpace(strings.Join(o.Metadata.Creators, ", "))
	}
	if len(o.Metadata.Descriptions) > 0 {
		m.Description = stripTags(o.Metadata.Descriptions[0])
	}

	// Cover lookup order: EPUB3 properties, EPUB2 <meta name="cover">, then heuristics.
	var coverHref string
	for _, it := range o.Manifest {
		if strings.Contains(it.Properties, "cover-image") {
			coverHref = it.Href
			break
		}
	}
	if coverHref == "" {
		for _, mt := range o.Metadata.Metas {
			if mt.Name == "cover" {
				for _, it := range o.Manifest {
					if it.ID == mt.Content {
						coverHref = it.Href
					}
				}
			}
		}
	}
	if coverHref == "" {
		for _, it := range o.Manifest {
			if strings.HasPrefix(it.MediaType, "image/") && strings.Contains(strings.ToLower(it.ID+it.Href), "cover") {
				coverHref = it.Href
				break
			}
		}
	}
	if coverHref != "" {
		p := path.Join(path.Dir(opfPath), unescapeHref(coverHref))
		if b, err := read(p); err == nil {
			m.Cover = b
		}
	}
	return m, nil
}

func unescapeHref(h string) string {
	h = strings.SplitN(h, "#", 2)[0]
	return strings.ReplaceAll(h, "%20", " ")
}

func stripTags(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		switch {
		case r == '<':
			in = true
		case r == '>':
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

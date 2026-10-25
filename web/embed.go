// Package web embeds the built frontend (web/dist) into the binary.
package web

import (
	"embed"
	"io/fs"
)

// dist holds the Vite build output. In a fresh checkout it only contains
// .gitkeep until `make web` (or `npm run build`) has run.
//
//go:embed all:dist
var dist embed.FS

func Dist() fs.FS {
	f, _ := fs.Sub(dist, "dist")
	return f
}

// Built reports whether the frontend was built before compiling the binary.
func Built() bool {
	_, err := fs.Stat(Dist(), "index.html")
	return err == nil
}

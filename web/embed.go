// Package web embeds the built frontend (web/dist) into the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

func Dist() fs.FS {
	f, _ := fs.Sub(dist, "dist")
	return f
}

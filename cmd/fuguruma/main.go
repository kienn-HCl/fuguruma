package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/kienn-HCl/fuguruma/internal/ai"
	"github.com/kienn-HCl/fuguruma/internal/api"
	"github.com/kienn-HCl/fuguruma/internal/auth"
	"github.com/kienn-HCl/fuguruma/internal/config"
	"github.com/kienn-HCl/fuguruma/internal/db"
	"github.com/kienn-HCl/fuguruma/internal/library"
	"github.com/kienn-HCl/fuguruma/web"
)

// version is set at build time: -ldflags "-X main.version=v1.2.3".
var version = "dev"

const usage = `Usage: fuguruma [-config FILE] [command]

Commands:
  serve    start the server (default)
  passwd   set or clear the login password in the config file
  version  print the version

The config file is created with defaults if it does not exist.
Default path: $FUGURUMA_CONFIG, or ./config.toml
`

func main() {
	def := os.Getenv("FUGURUMA_CONFIG")
	if def == "" {
		def = "config.toml"
	}
	cfgPath := flag.String("config", def, "path to config file")
	flag.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	flag.Parse()
	if flag.Arg(0) == "version" {
		fmt.Println("fuguruma", version)
		return
	}

	conf, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatal(err)
	}
	switch flag.Arg(0) {
	case "", "serve":
		serve(conf)
	case "passwd":
		passwd(conf)
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func passwd(conf *config.Manager) {
	fmt.Fprint(os.Stderr, "New password (empty to disable login): ")
	var p string
	if term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			log.Fatal(err)
		}
		p = string(b)
	} else {
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		p = strings.TrimRight(line, "\r\n")
	}
	hash := ""
	if p != "" {
		var err error
		if hash, err = auth.HashPassword(p); err != nil {
			log.Fatal(err)
		}
	}
	if err := conf.Update(func(c *config.Config) { c.Auth.PasswordHash = hash }); err != nil {
		log.Fatal(err)
	}
	if hash == "" {
		fmt.Fprintln(os.Stderr, "Login disabled.")
	} else {
		fmt.Fprintf(os.Stderr, "Password saved to %s\n", conf.Path())
	}
}

func serve(conf *config.Manager) {
	cfg := conf.Get()
	dataDir, _ := filepath.Abs(cfg.Server.DataDir)
	booksDir, _ := filepath.Abs(cfg.Server.BooksDir)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	store, err := db.Open(filepath.Join(dataDir, "fuguruma.db"))
	if err != nil {
		log.Fatal(err)
	}
	lib, err := library.New(booksDir, dataDir, store)
	if err != nil {
		log.Fatal(err)
	}
	a, err := auth.New(func() (string, string) {
		c := conf.Get()
		return c.Auth.PasswordHash, c.Auth.PasswordPlain
	}, dataDir)
	if err != nil {
		log.Fatal(err)
	}
	aiMgr := ai.NewManager(cfg.AI, dataDir)
	if _, name, err := aiMgr.Get(); err != nil {
		log.Printf("ai: provider %q not usable: %v", name, err)
	}

	rescan := make(chan struct{}, 1)
	conf.OnChange(func(c config.Config) {
		aiMgr.Configure(c.AI)
		select {
		case rescan <- struct{}{}: // re-arm the scan timer with the new interval
		default:
		}
	})
	go scanLoop(lib, conf, rescan)

	srv := &http.Server{
		Addr:              cfg.Server.Addr,
		Handler:           (&api.Server{Store: store, Lib: lib, Auth: a, AI: aiMgr, Conf: conf, Web: web.Dist()}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if !web.Built() {
		log.Print("warning: this binary was built without the web UI; run `make build`")
	}
	if !a.Enabled() && !loopbackOnly(cfg.Server.Addr) {
		log.Printf("warning: no login password is set and %s is reachable from other machines; "+
			"anyone who can reach it can read your notes and change settings. Set one with `fuguruma -config %s passwd`.",
			cfg.Server.Addr, conf.Path())
	}
	go func() {
		_, provider, _ := aiMgr.Get()
		log.Printf("fuguruma %s listening on %s (config=%s books=%s data=%s login=%v ai=%s)",
			version, cfg.Server.Addr, conf.Path(), booksDir, dataDir, a.Enabled(), provider)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	log.Print("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
	store.DB.Close()
}

// loopbackOnly reports whether addr only listens on the local machine.
func loopbackOnly(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// scanLoop scans at startup and then every library.scan_interval (0 = never).
// A value on wake re-reads the interval after a settings change.
func scanLoop(lib *library.Library, conf *config.Manager, wake <-chan struct{}) {
	scan := func() {
		if res, err := lib.Scan(); err != nil {
			log.Printf("scan failed: %v", err)
		} else {
			log.Printf("scan: %d files (+%d new, %d moved, %d updated, %d missing)", res.Total, res.Added, res.Moved, res.Updated, res.Missing)
		}
	}
	scan()
	for {
		var tick <-chan time.Time
		if d := conf.Get().Library.ScanInterval.Duration; d > 0 {
			tick = time.After(d)
		}
		select {
		case <-tick:
			scan()
		case <-wake:
		}
	}
}

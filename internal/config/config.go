// Package config loads, validates and persists the TOML configuration file.
//
// Settings live in the config file; user data (books, notes, conversations)
// lives in the SQLite database under server.data_dir. Some settings can be
// edited from the web UI, which rewrites the file through Manager.Update.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
)

type Config struct {
	Server  Server  `toml:"server"`
	Library Library `toml:"library"`
	Auth    Auth    `toml:"auth"`
	AI      AI      `toml:"ai"`
}

type Server struct {
	Addr     string `toml:"addr"`
	DataDir  string `toml:"data_dir"`
	BooksDir string `toml:"books_dir"`
}

type Library struct {
	ScanInterval Duration `toml:"scan_interval"`
}

type Auth struct {
	// bcrypt hash; set with `fuguruma passwd` or from the web UI. Empty = no login.
	PasswordHash string `toml:"password_hash"`
	// Plain password from FUGURUMA_PASSWORD. Never written to the file.
	PasswordPlain string `toml:"-"`
}

type AI struct {
	// "none" | "anthropic" | "openai" | "claude-cli"
	Provider  string    `toml:"provider"`
	Anthropic Anthropic `toml:"anthropic"`
	OpenAI    OpenAI    `toml:"openai"`
	ClaudeCLI ClaudeCLI `toml:"claude_cli"`
}

type Anthropic struct {
	APIKey string `toml:"api_key"`
	Model  string `toml:"model"`
	Effort string `toml:"effort"`
}

// OpenAI covers any OpenAI-compatible Chat Completions endpoint
// (OpenAI, Ollama, LM Studio, OpenRouter, Gemini, vLLM, ...).
type OpenAI struct {
	BaseURL string `toml:"base_url"`
	APIKey  string `toml:"api_key"`
	Model   string `toml:"model"`
}

// ClaudeCLI runs `claude -p` (Claude Code) on the server.
type ClaudeCLI struct {
	// Executable path. Only settable in the file, never from the web UI.
	Command string `toml:"command"`
	Model   string `toml:"model"`
}

// Duration is a time.Duration that (un)marshals as "30m"-style text.
type Duration struct{ time.Duration }

func (d *Duration) UnmarshalText(b []byte) error {
	if string(b) == "0" || len(b) == 0 {
		d.Duration = 0
		return nil
	}
	v, err := time.ParseDuration(string(b))
	d.Duration = v
	return err
}

func (d Duration) MarshalText() ([]byte, error) {
	if d.Duration == 0 {
		return []byte("0"), nil
	}
	// time.Duration prints "30m0s"; trim zero units for readability.
	s := d.Duration.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return []byte(s), nil
}

func Default() Config {
	return Config{
		Server:  Server{Addr: ":8080", DataDir: "./data", BooksDir: "./books"},
		Library: Library{ScanInterval: Duration{30 * time.Minute}},
		AI: AI{
			Provider:  "none",
			Anthropic: Anthropic{Model: "claude-opus-5-5", Effort: "medium"},
			OpenAI:    OpenAI{BaseURL: "https://api.openai.com/v1"},
			ClaudeCLI: ClaudeCLI{Command: "claude"},
		},
	}
}

var Providers = []string{"none", "anthropic", "openai", "claude-cli"}

func (c *Config) Validate() error {
	if c.Server.Addr == "" || c.Server.DataDir == "" || c.Server.BooksDir == "" {
		return errors.New("server.addr, server.data_dir and server.books_dir are required")
	}
	ok := false
	for _, p := range Providers {
		ok = ok || p == c.AI.Provider
	}
	if !ok {
		return fmt.Errorf("ai.provider must be one of %v", Providers)
	}
	switch c.AI.Anthropic.Effort {
	case "", "low", "medium", "high", "xhigh", "max":
	default:
		return fmt.Errorf("ai.anthropic.effort: invalid value %q", c.AI.Anthropic.Effort)
	}
	if c.Library.ScanInterval.Duration < 0 {
		return errors.New("library.scan_interval must not be negative")
	}
	return nil
}

// envOverrides applies environment variables on top of the file. They are
// convenient for containers and are never written back to the file.
var envOverrides = []struct {
	Env, Key string
	Apply    func(*Config, string)
}{
	{"FUGURUMA_ADDR", "server.addr", func(c *Config, v string) { c.Server.Addr = v }},
	{"FUGURUMA_DATA_DIR", "server.data_dir", func(c *Config, v string) { c.Server.DataDir = v }},
	{"FUGURUMA_BOOKS_DIR", "server.books_dir", func(c *Config, v string) { c.Server.BooksDir = v }},
	{"FUGURUMA_PASSWORD", "auth.password", func(c *Config, v string) { c.Auth.PasswordPlain = v }},
	{"ANTHROPIC_API_KEY", "ai.anthropic.api_key", func(c *Config, v string) { c.AI.Anthropic.APIKey = v }},
	{"OPENAI_API_KEY", "ai.openai.api_key", func(c *Config, v string) { c.AI.OpenAI.APIKey = v }},
}

// Manager owns the live configuration and the file it came from.
type Manager struct {
	path    string
	mu      sync.RWMutex
	file    Config   // as stored in the file
	eff     Config   // file + environment overrides
	envKeys []string // config keys currently overridden by the environment
	subs    []func(Config)
}

// Load reads path, creating it with defaults if it does not exist.
func Load(path string) (*Manager, error) {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	m := &Manager{path: path}
	c := Default()
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if _, err := toml.Decode(string(b), &c); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
		if err := write(path, c); err != nil {
			return nil, fmt.Errorf("create %s: %w", path, err)
		}
	default:
		return nil, err
	}
	m.set(c)
	if err := m.eff.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return m, nil
}

func (m *Manager) set(file Config) {
	eff := file
	var keys []string
	for _, o := range envOverrides {
		if v := os.Getenv(o.Env); v != "" {
			o.Apply(&eff, v)
			keys = append(keys, o.Key)
		}
	}
	m.file, m.eff, m.envKeys = file, eff, keys
}

func (m *Manager) Path() string { return m.path }

// Get returns the effective configuration (file + environment).
func (m *Manager) Get() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.eff
}

// EnvOverridden lists config keys whose values come from the environment.
func (m *Manager) EnvOverridden() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string(nil), m.envKeys...)
}

// OnChange registers a callback run after every successful Update.
func (m *Manager) OnChange(f func(Config)) {
	m.mu.Lock()
	m.subs = append(m.subs, f)
	m.mu.Unlock()
}

// Update applies fn to a copy of the file config, validates, saves and notifies.
func (m *Manager) Update(fn func(*Config)) error {
	m.mu.Lock()
	c := m.file
	fn(&c)
	if err := c.Validate(); err != nil {
		m.mu.Unlock()
		return err
	}
	if err := write(m.path, c); err != nil {
		m.mu.Unlock()
		return err
	}
	m.set(c)
	eff, subs := m.eff, append([]func(Config){}, m.subs...)
	m.mu.Unlock()
	for _, f := range subs {
		f(eff)
	}
	return nil
}

const header = `# Fuguruma configuration.
# Settings under [library], [auth] and [ai] can also be changed from the web UI
# (that rewrites this file and drops comments). Changes to [server] need a restart.
# Environment variables (FUGURUMA_*, ANTHROPIC_API_KEY, OPENAI_API_KEY) override
# values here without being written back.

`

// write saves atomically with 0600 permissions, since the file holds API keys.
func write(path string, c Config) error {
	var buf bytes.Buffer
	buf.WriteString(header)
	if err := toml.NewEncoder(&buf).Encode(c); err != nil {
		return err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

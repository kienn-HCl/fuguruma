package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDurationText(t *testing.T) {
	for d, want := range map[time.Duration]string{
		0: "0", 30 * time.Minute: "30m", 2 * time.Hour: "2h", 90 * time.Minute: "1h30m", 45 * time.Second: "45s",
	} {
		b, _ := Duration{d}.MarshalText()
		if string(b) != want {
			t.Errorf("%v: got %q want %q", d, b, want)
		}
		var back Duration
		if err := back.UnmarshalText(b); err != nil || back.Duration != d {
			t.Errorf("%q: round trip got %v, %v", b, back.Duration, err)
		}
	}
}

func TestLoadUpdateAndEnv(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "config.toml")
	m, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(p); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("config file not created with 0600: %v %v", st, err)
	}
	t.Setenv("ANTHROPIC_API_KEY", "from-env")
	var got Config
	m.OnChange(func(c Config) { got = c })
	if err := m.Update(func(c *Config) { c.AI.Provider = "anthropic"; c.AI.Anthropic.APIKey = "from-file" }); err != nil {
		t.Fatal(err)
	}
	if got.AI.Anthropic.APIKey != "from-env" {
		t.Errorf("env should override file, got %q", got.AI.Anthropic.APIKey)
	}
	m2, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if m2.file.AI.Anthropic.APIKey != "from-file" || m2.file.AI.Provider != "anthropic" {
		t.Errorf("file not persisted: %+v", m2.file.AI)
	}
	if err := m.Update(func(c *Config) { c.AI.Provider = "bogus" }); err == nil {
		t.Error("invalid provider accepted")
	}
	for _, d := range []string{"/etc", "..", "../x", "a/../../x"} {
		if err := m.Update(func(c *Config) { c.Library.UploadDir = d }); err == nil {
			t.Errorf("upload_dir %q outside books_dir accepted", d)
		}
	}
	for _, d := range []string{"", "Uploads", "a/b", "./x"} {
		if err := m.Update(func(c *Config) { c.Library.UploadDir = d }); err != nil {
			t.Errorf("upload_dir %q rejected: %v", d, err)
		}
	}
}

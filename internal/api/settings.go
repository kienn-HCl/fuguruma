package api

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/kienn-HCl/fuguruma/internal/ai"
	"github.com/kienn-HCl/fuguruma/internal/auth"
	"github.com/kienn-HCl/fuguruma/internal/config"
)

// Settings editable from the web UI. [server] and ai.claude_cli.command are
// deliberately file-only: changing them from a browser would let anyone with
// access point the server at arbitrary paths or executables.

type keyInfo struct {
	APIKeySet  bool   `json:"apiKeySet"`
	APIKeyHint string `json:"apiKeyHint"`
}

func hint(k string) keyInfo {
	if k == "" {
		return keyInfo{}
	}
	if len(k) <= 8 {
		return keyInfo{true, "••••"}
	}
	return keyInfo{true, "••••" + k[len(k)-4:]}
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	c := s.Conf.Get()
	_, _, aiErr := s.AI.Get()
	errStr := ""
	if aiErr != nil {
		errStr = aiErr.Error()
	}
	writeJSON(w, map[string]any{
		"configPath":   s.Conf.Path(),
		"envOverrides": s.Conf.EnvOverridden(),
		"server":       map[string]string{"addr": c.Server.Addr, "dataDir": c.Server.DataDir, "booksDir": c.Server.BooksDir},
		"library":      map[string]string{"scanInterval": durationText(c.Library.ScanInterval)},
		"auth":         map[string]bool{"passwordSet": s.Auth.Enabled()},
		"ai": map[string]any{
			"provider":  c.AI.Provider,
			"error":     errStr,
			"providers": config.Providers,
			"anthropic": struct {
				Model  string `json:"model"`
				Effort string `json:"effort"`
				keyInfo
			}{c.AI.Anthropic.Model, c.AI.Anthropic.Effort, hint(c.AI.Anthropic.APIKey)},
			"openai": struct {
				BaseURL string `json:"baseUrl"`
				Model   string `json:"model"`
				keyInfo
			}{c.AI.OpenAI.BaseURL, c.AI.OpenAI.Model, hint(c.AI.OpenAI.APIKey)},
			"claudeCli": map[string]string{"command": c.AI.ClaudeCLI.Command, "model": c.AI.ClaudeCLI.Model},
		},
	})
}

func durationText(d config.Duration) string {
	b, _ := d.MarshalText()
	return string(b)
}

type aiPatch struct {
	Provider  *string `json:"provider"`
	Anthropic *struct {
		Model  *string `json:"model"`
		Effort *string `json:"effort"`
		APIKey *string `json:"apiKey"` // nil = keep, "" = clear
	} `json:"anthropic"`
	OpenAI *struct {
		BaseURL *string `json:"baseUrl"`
		Model   *string `json:"model"`
		APIKey  *string `json:"apiKey"`
	} `json:"openai"`
	ClaudeCLI *struct {
		Model *string `json:"model"`
	} `json:"claudeCli"`
}

func set(dst *string, v *string) {
	if v != nil {
		*dst = strings.TrimSpace(*v)
	}
}

func (p *aiPatch) apply(c *config.AI) {
	if p == nil {
		return
	}
	set(&c.Provider, p.Provider)
	if a := p.Anthropic; a != nil {
		set(&c.Anthropic.Model, a.Model)
		set(&c.Anthropic.Effort, a.Effort)
		set(&c.Anthropic.APIKey, a.APIKey)
	}
	if o := p.OpenAI; o != nil {
		set(&c.OpenAI.BaseURL, o.BaseURL)
		set(&c.OpenAI.Model, o.Model)
		set(&c.OpenAI.APIKey, o.APIKey)
	}
	if cc := p.ClaudeCLI; cc != nil {
		set(&c.ClaudeCLI.Model, cc.Model)
	}
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Library *struct {
			ScanInterval *string `json:"scanInterval"`
		} `json:"library"`
		AI *aiPatch `json:"ai"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var parseErr error
	err := s.Conf.Update(func(c *config.Config) {
		if body.Library != nil && body.Library.ScanInterval != nil {
			parseErr = c.Library.ScanInterval.UnmarshalText([]byte(strings.TrimSpace(*body.Library.ScanInterval)))
		}
		body.AI.apply(&c.AI)
	})
	if parseErr != nil {
		writeErr(w, http.StatusBadRequest, "スキャン間隔の形式が不正です（例: 30m, 2h, 0）")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.getSettings(w, r)
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct{ Current, New string }
	if !readJSON(w, r, &body) {
		return
	}
	if slices.Contains(s.Conf.EnvOverridden(), "auth.password") {
		writeErr(w, http.StatusConflict, "パスワードは環境変数 FUGURUMA_PASSWORD で設定されているため変更できません")
		return
	}
	if s.Auth.Enabled() && !s.Auth.CheckPassword(body.Current) {
		writeErr(w, http.StatusForbidden, "現在のパスワードが違います")
		return
	}
	hash := ""
	if body.New != "" {
		if len(body.New) < 8 {
			writeErr(w, http.StatusBadRequest, "パスワードは 8 文字以上にしてください")
			return
		}
		var err error
		if hash, err = auth.HashPassword(body.New); err != nil {
			handleErr(w, err)
			return
		}
	}
	if err := s.Conf.Update(func(c *config.Config) { c.Auth.PasswordHash = hash }); err != nil {
		handleErr(w, err)
		return
	}
	// The session signature depends on the password; re-issue it for this device.
	if hash != "" {
		s.Auth.SetSession(w, r)
	}
	writeJSON(w, map[string]bool{"ok": true, "passwordSet": hash != ""})
}

// testAI checks a (possibly unsaved) AI configuration with a tiny request.
func (s *Server) testAI(w http.ResponseWriter, r *http.Request) {
	var patch aiPatch
	if !readJSON(w, r, &patch) {
		return
	}
	c := s.Conf.Get().AI
	patch.apply(&c)
	p, err := ai.New(c, s.AI.DataDir())
	if err == nil && p == nil {
		writeJSON(w, map[string]any{"ok": true, "reply": "AI は無効に設定されています"})
		return
	}
	if err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		var reply string
		if reply, err = ai.Test(ctx, p); err == nil {
			writeJSON(w, map[string]any{"ok": true, "reply": strings.TrimSpace(reply)})
			return
		}
	}
	writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
}

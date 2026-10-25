package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/you/fuguruma/internal/config"
)

// openaiProvider speaks the OpenAI Chat Completions streaming protocol, which
// OpenAI, Ollama, LM Studio, OpenRouter, Gemini (OpenAI compat) and vLLM share.
type openaiProvider struct {
	cfg config.OpenAI
}

func newOpenAI(cfg config.OpenAI) *openaiProvider { return &openaiProvider{cfg: cfg} }

type oaMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (p *openaiProvider) Stream(ctx context.Context, system string, turns []Turn, onDelta func(string)) (string, error) {
	msgs := []oaMessage{{Role: "system", Content: system}}
	for _, t := range turns {
		msgs = append(msgs, oaMessage{Role: t.Role, Content: t.Content})
	}
	body, _ := json.Marshal(map[string]any{"model": p.cfg.Model, "messages": msgs, "stream": true})
	url := strings.TrimRight(p.cfg.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if p.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", fmt.Errorf("%s: %s", res.Status, strings.TrimSpace(string(b)))
	}

	var sb strings.Builder
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil {
			return sb.String(), fmt.Errorf("%s", chunk.Error.Message)
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				sb.WriteString(c.Delta.Content)
				if onDelta != nil {
					onDelta(c.Delta.Content)
				}
			}
		}
	}
	return sb.String(), sc.Err()
}

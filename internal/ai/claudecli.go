package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kienn-HCl/fuguruma/internal/config"
)

// claudeCLIProvider runs Claude Code headless (`claude -p`) on the server and
// uses whatever authentication that CLI has (subscription login or API key).
type claudeCLIProvider struct {
	command string
	model   string
	workDir string
}

func newClaudeCLI(cfg config.ClaudeCLI, dataDir string) (*claudeCLIProvider, error) {
	cmd := cfg.Command
	if cmd == "" {
		cmd = "claude"
	}
	path, err := exec.LookPath(cmd)
	if err != nil {
		return nil, fmt.Errorf("Claude Code CLI (%s) が見つかりません: %w", cmd, err)
	}
	// Run in an empty directory so no project CLAUDE.md or settings are picked up.
	wd := filepath.Join(dataDir, "claude-cli")
	if err := os.MkdirAll(wd, 0o755); err != nil {
		return nil, err
	}
	return &claudeCLIProvider{command: path, model: cfg.Model, workDir: wd}, nil
}

func (p *claudeCLIProvider) Stream(ctx context.Context, system string, turns []Turn, onDelta func(string)) (string, error) {
	args := []string{
		"-p",
		"--output-format", "stream-json", "--verbose", "--include-partial-messages",
		// No tools: book text could contain prompt injection, and this runs on the server.
		"--tools", "",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--system-prompt", system,
	}
	if p.model != "" {
		args = append(args, "--model", p.model)
	}
	cmd := exec.CommandContext(ctx, p.command, args...)
	cmd.Dir = p.workDir
	cmd.Stdin = strings.NewReader(transcript(turns))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}

	var sb strings.Builder
	var result string
	var resultErr error
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var ev struct {
			Type    string `json:"type"`
			IsError bool   `json:"is_error"`
			Result  string `json:"result"`
			Event   struct {
				Type  string `json:"type"`
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
			} `json:"event"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "stream_event":
			if ev.Event.Type == "content_block_delta" && ev.Event.Delta.Type == "text_delta" {
				sb.WriteString(ev.Event.Delta.Text)
				if onDelta != nil {
					onDelta(ev.Event.Delta.Text)
				}
			}
		case "result":
			result = ev.Result
			if ev.IsError {
				resultErr = errors.New(strings.TrimSpace(ev.Result))
			}
		}
	}
	waitErr := cmd.Wait()
	if resultErr != nil {
		return sb.String(), resultErr
	}
	if waitErr != nil {
		if ctx.Err() != nil {
			return sb.String(), ctx.Err()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return sb.String(), fmt.Errorf("claude: %s", msg)
	}
	if sb.Len() == 0 {
		return result, nil
	}
	return sb.String(), nil
}

// transcript flattens the conversation into one prompt, since `claude -p`
// is invoked statelessly for every turn.
func transcript(turns []Turn) string {
	if len(turns) == 1 {
		return turns[0].Content
	}
	var b strings.Builder
	b.WriteString("これまでの会話:\n<conversation>\n")
	for _, t := range turns[:len(turns)-1] {
		fmt.Fprintf(&b, "<%s>\n%s\n</%s>\n", t.Role, t.Content, t.Role)
	}
	b.WriteString("</conversation>\n\n上の会話の続きとして、次のユーザーの発言に答えてください。\n\n")
	b.WriteString(turns[len(turns)-1].Content)
	return b.String()
}

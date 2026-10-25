// Package ai talks to an LLM for passage-based conversations. The backend is
// pluggable: the Claude API, any OpenAI-compatible API, or the local Claude
// Code CLI (`claude -p`).
package ai

import (
	"context"
	"errors"
	"fmt"

	"github.com/kienn-HCl/fuguruma/internal/config"
)

type Turn struct {
	Role    string // "user" | "assistant"
	Content string
}

// Provider streams one assistant reply for a conversation.
type Provider interface {
	// Stream calls onDelta (if non-nil) with text chunks and returns the full reply.
	Stream(ctx context.Context, system string, turns []Turn, onDelta func(string)) (string, error)
}

var ErrRefused = errors.New("the model declined to answer this request")

// New builds the provider selected in cfg. It returns (nil, nil) when AI is disabled.
func New(cfg config.AI, dataDir string) (Provider, error) {
	switch cfg.Provider {
	case "", "none":
		return nil, nil
	case "anthropic":
		if cfg.Anthropic.APIKey == "" {
			return nil, errors.New("Claude API: API キーが設定されていません")
		}
		return newAnthropic(cfg.Anthropic), nil
	case "openai":
		if cfg.OpenAI.BaseURL == "" || cfg.OpenAI.Model == "" {
			return nil, errors.New("OpenAI 互換 API: base_url と model が必要です")
		}
		return newOpenAI(cfg.OpenAI), nil
	case "claude-cli":
		return newClaudeCLI(cfg.ClaudeCLI, dataDir)
	}
	return nil, fmt.Errorf("unknown provider %q", cfg.Provider)
}

type BookContext struct {
	Title   string
	Author  string
	Passage string // the text the user selected
	Context string // surrounding text from the book
}

const systemTemplate = `あなたは読書のパートナーです。ユーザーは電子書籍を読んでおり、本文の一部を選択してあなたに話しかけています。
選択箇所と周辺の本文を踏まえて、解説・背景知識・要約・批判的な視点・関連する概念などを提供してください。
- ユーザーが使っている言語で答えてください。
- 本文に書かれていることと、あなた自身の知識・推測は区別して述べてください。
- 回答は Markdown で、読みやすく簡潔に。

<book>
タイトル: %s
著者: %s
</book>

<surrounding_text>
%s
</surrounding_text>

<selected_passage>
%s
</selected_passage>`

func SystemPrompt(b BookContext) string {
	author := b.Author
	if author == "" {
		author = "(不明)"
	}
	return fmt.Sprintf(systemTemplate, b.Title, author, b.Context, b.Passage)
}

const summarizePrompt = `ここまでの会話を、後から読み返す読書メモとして Markdown で整理してください。
- 先頭に「## 」で始まる短い見出しを 1 つ
- 引用した本文は > 引用 で残す
- 要点を箇条書きで。冗長な前置きや挨拶は不要
メモ本文のみを出力してください。`

// summarizeMemoPrompt is used when the summary is added to a memo, which
// already shows the passage next to it.
const summarizeMemoPrompt = `ここまでの会話を、選択箇所に付ける短い読書メモとして Markdown で整理してください。
- 先頭に「### 」で始まる短い見出しを 1 つ
- 選択箇所はメモに表示済みなので、本文の引用は不要
- 要点を 2〜5 個の箇条書きで。冗長な前置きや挨拶は不要
メモ本文のみを出力してください。`

func Chat(ctx context.Context, p Provider, book BookContext, turns []Turn, onDelta func(string)) (string, error) {
	return p.Stream(ctx, SystemPrompt(book), turns, onDelta)
}

// Summarize turns a conversation into a Markdown reading note. forMemo asks
// for a shorter summary without the quoted passage.
func Summarize(ctx context.Context, p Provider, book BookContext, turns []Turn, forMemo bool) (string, error) {
	prompt := summarizePrompt
	if forMemo {
		prompt = summarizeMemoPrompt
	}
	turns = append(append([]Turn{}, turns...), Turn{Role: "user", Content: prompt})
	return p.Stream(ctx, SystemPrompt(book), turns, nil)
}

// Test sends a tiny prompt to check that a provider configuration works.
func Test(ctx context.Context, p Provider) (string, error) {
	return p.Stream(ctx, "You are a connectivity check. Reply briefly.", []Turn{{Role: "user", Content: "「OK」とだけ返答してください。"}}, nil)
}

package ai

import (
	"context"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/you/fuguruma/internal/config"
)

type anthropicProvider struct {
	c      anthropic.Client
	model  string
	effort anthropic.OutputConfigEffort
}

func newAnthropic(cfg config.Anthropic) *anthropicProvider {
	model := cfg.Model
	if model == "" {
		model = "claude-opus-5-5"
	}
	return &anthropicProvider{
		c:      anthropic.NewClient(option.WithAPIKey(cfg.APIKey)),
		model:  model,
		effort: anthropic.OutputConfigEffort(cfg.Effort),
	}
}

func (p *anthropicProvider) Stream(ctx context.Context, system string, turns []Turn, onDelta func(string)) (string, error) {
	msgs := make([]anthropic.MessageParam, 0, len(turns))
	for _, t := range turns {
		if t.Role == "assistant" {
			msgs = append(msgs, anthropic.NewAssistantMessage(anthropic.NewTextBlock(t.Content)))
		} else {
			msgs = append(msgs, anthropic.NewUserMessage(anthropic.NewTextBlock(t.Content)))
		}
	}
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(p.model),
		MaxTokens: 16000,
		System: []anthropic.TextBlockParam{{
			Text: system,
			// The system prompt (book + passage) is identical on every turn of a conversation.
			CacheControl: anthropic.NewCacheControlEphemeralParam(),
		}},
		Messages: msgs,
	}
	if p.effort != "" {
		params.OutputConfig = anthropic.OutputConfigParam{Effort: p.effort}
	}
	// Server-side fallback: if a safety classifier declines, the request is
	// re-served by Anthropic's recommended fallback model instead of failing.
	opts := []option.RequestOption{
		option.WithHeaderAdd("anthropic-beta", "server-side-fallback-2026-07-01"),
		option.WithJSONSet("fallbacks", "default"),
	}
	stream := p.c.Messages.NewStreaming(ctx, params, opts...)
	defer stream.Close()

	var msg anthropic.Message
	var sb strings.Builder
	for stream.Next() {
		ev := stream.Current()
		// Only StopReason is read from msg; ignore accumulation errors from
		// block types the SDK may not know (e.g. a fallback boundary marker).
		_ = msg.Accumulate(ev)
		if d, ok := ev.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if td, ok := d.Delta.AsAny().(anthropic.TextDelta); ok {
				sb.WriteString(td.Text)
				if onDelta != nil {
					onDelta(td.Text)
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		return sb.String(), err
	}
	if msg.StopReason == anthropic.StopReasonRefusal {
		return sb.String(), ErrRefused
	}
	return sb.String(), nil
}

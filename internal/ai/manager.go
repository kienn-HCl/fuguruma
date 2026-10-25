package ai

import (
	"sync"

	"github.com/you/fuguruma/internal/config"
)

// Manager holds the active provider and rebuilds it when settings change.
type Manager struct {
	dataDir string
	mu      sync.RWMutex
	p       Provider
	name    string
	err     error
}

func NewManager(cfg config.AI, dataDir string) *Manager {
	m := &Manager{dataDir: dataDir}
	m.Configure(cfg)
	return m
}

func (m *Manager) Configure(cfg config.AI) {
	p, err := New(cfg, m.dataDir)
	m.mu.Lock()
	m.p, m.err, m.name = p, err, cfg.Provider
	m.mu.Unlock()
}

// Get returns the provider (nil if AI is disabled or misconfigured),
// the configured provider name, and any configuration error.
func (m *Manager) Get() (Provider, string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.p, m.name, m.err
}

func (m *Manager) DataDir() string { return m.dataDir }

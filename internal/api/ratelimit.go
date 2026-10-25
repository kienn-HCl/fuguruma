package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// loginLimiter locks out a client after repeated failed logins.
type loginLimiter struct {
	mu      sync.Mutex
	clients map[string]*loginState
	max     int           // failures allowed within window
	window  time.Duration // failures older than this are forgotten
	lockout time.Duration
	now     func() time.Time
}

type loginState struct {
	fails       int
	first       time.Time
	lockedUntil time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{clients: map[string]*loginState{}, max: 5, window: 15 * time.Minute, lockout: 15 * time.Minute, now: time.Now}
}

// Allowed reports whether the client may try to log in, and if not, for how long it must wait.
func (l *loginLimiter) Allowed(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.clients[key]
	if st == nil {
		return true, 0
	}
	if wait := st.lockedUntil.Sub(l.now()); wait > 0 {
		return false, wait
	}
	return true, 0
}

func (l *loginLimiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	st := l.clients[key]
	if st == nil || now.Sub(st.first) > l.window {
		st = &loginState{first: now}
		l.clients[key] = st
	}
	st.fails++
	if st.fails >= l.max {
		st.lockedUntil = now.Add(l.lockout)
		st.fails, st.first = 0, now
	}
	// Drop stale entries so the map cannot grow without bound.
	for k, v := range l.clients {
		if now.Sub(v.first) > l.window && now.After(v.lockedUntil) {
			delete(l.clients, k)
		}
	}
}

func (l *loginLimiter) Succeed(key string) {
	l.mu.Lock()
	delete(l.clients, key)
	l.mu.Unlock()
}

// clientKey identifies the client for rate limiting. X-Forwarded-For is only
// trusted when the direct peer is a loopback address (a reverse proxy on the
// same host); otherwise anyone could pick their own key.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	return host
}

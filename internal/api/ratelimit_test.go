package api

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := newLoginLimiter()
	l.now = func() time.Time { return now }
	for i := 0; i < 4; i++ {
		l.Fail("a")
	}
	if ok, _ := l.Allowed("a"); !ok {
		t.Fatal("locked out before reaching the limit")
	}
	l.Fail("a")
	if ok, wait := l.Allowed("a"); ok || wait != 15*time.Minute {
		t.Fatalf("expected 15m lockout, got ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allowed("b"); !ok {
		t.Fatal("other clients must not be affected")
	}
	now = now.Add(16 * time.Minute)
	if ok, _ := l.Allowed("a"); !ok {
		t.Fatal("lockout did not expire")
	}
	l.Fail("a")
	l.Succeed("a")
	if _, exists := l.clients["a"]; exists {
		t.Fatal("success should reset the counter")
	}
}

func TestClientKey(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "203.0.113.5:4000"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := clientKey(r); got != "203.0.113.5" {
		t.Errorf("X-Forwarded-For must be ignored from non-loopback peers, got %s", got)
	}
	r.RemoteAddr = "127.0.0.1:4000"
	r.Header.Set("X-Forwarded-For", "9.9.9.9, 198.51.100.7")
	if got := clientKey(r); got != "198.51.100.7" {
		t.Errorf("expected last proxy-added address, got %s", got)
	}
}

// Package auth implements optional single-password login with signed cookies.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const cookieName = "fuguruma_session"
const sessionTTL = 30 * 24 * time.Hour

type Auth struct {
	creds  func() (hash, plain string)
	secret []byte
}

// New returns an Auth. creds is consulted on every check so password changes
// apply immediately. The cookie signing key is generated once and kept in dataDir.
func New(creds func() (hash, plain string), dataDir string) (*Auth, error) {
	a := &Auth{creds: creds}
	p := filepath.Join(dataDir, "secret")
	if b, err := os.ReadFile(p); err == nil && len(b) >= 32 {
		a.secret = b
		return a, nil
	}
	b := make([]byte, 32)
	rand.Read(b)
	if err := os.WriteFile(p, []byte(hex.EncodeToString(b)), 0o600); err != nil {
		return nil, err
	}
	a.secret, _ = os.ReadFile(p)
	return a, nil
}

func (a *Auth) Enabled() bool {
	h, p := a.creds()
	return h != "" || p != ""
}

func HashPassword(p string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
	return string(b), err
}

// sign binds the session to the current password, so changing it logs out
// every other device.
func (a *Auth) sign(v string) string {
	hash, plain := a.creds()
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(v + "\x00" + hash + "\x00" + plain))
	return hex.EncodeToString(m.Sum(nil))
}

func (a *Auth) LoggedIn(r *http.Request) bool {
	if !a.Enabled() {
		return true
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	exp, sig, ok := strings.Cut(c.Value, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(a.sign(exp))) {
		return false
	}
	t, err := strconv.ParseInt(exp, 10, 64)
	return err == nil && time.Now().Unix() < t
}

func (a *Auth) CheckPassword(p string) bool {
	hash, plain := a.creds()
	if plain != "" {
		return subtle.ConstantTimeCompare([]byte(p), []byte(plain)) == 1
	}
	return hash != "" && bcrypt.CompareHashAndPassword([]byte(hash), []byte(p)) == nil
}

func (a *Auth) SetSession(w http.ResponseWriter, r *http.Request) {
	exp := strconv.FormatInt(time.Now().Add(sessionTTL).Unix(), 10)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    exp + "." + a.sign(exp),
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func (a *Auth) ClearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
}

// Middleware rejects unauthenticated requests to everything except allowed paths.
func (a *Auth) Middleware(next http.Handler, public func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if public(r) || a.LoggedIn(r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	})
}

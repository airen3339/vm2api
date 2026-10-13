package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

func TestForwardCopiesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "sk-test" {
			t.Fatalf("missing x-api-key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	env, _ := json.Marshal(forwardEnv{
		Method:  "POST",
		URL:     up.URL + "/v1/messages?beta=true",
		Headers: map[string]string{"x-api-key": "sk-test"},
		Body:    `{"model":"x"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "message_stop") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestInternalAuthentication(t *testing.T) {
	cases := []struct {
		name    string
		current string
		legacy  string
		want    int
	}{
		{"current", "t", "", http.StatusOK},
		{"legacy", "", "t", http.StatusOK},
		{"missing", "", "", http.StatusUnauthorized},
		{"wrong current", "wrong", "", http.StatusUnauthorized},
		{"wrong legacy", "", "wrong", http.StatusUnauthorized},
		{"invalid current wins", "wrong", "t", http.StatusUnauthorized},
	}
	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/internal/health", nil)
			if tc.current != "" {
				req.Header.Set("X-Kin-Internal-Token", tc.current)
			}
			if tc.legacy != "" {
				req.Header.Set("X-Internal-Token", tc.legacy)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

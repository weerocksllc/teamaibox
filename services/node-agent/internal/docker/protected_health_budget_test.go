package docker

import (
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func TestProtectedRestoreWaitIncludesImmutableColdStartRetries(t *testing.T) {
	cases := []struct {
		name   string
		health *agent.ContainerHealthCheck
		want   time.Duration
	}{
		{"missing contract uses floor", nil, 2 * time.Minute},
		{"short contract uses floor", &agent.ContainerHealthCheck{Interval: int64(time.Second), Timeout: int64(time.Second), Retries: 1}, 2 * time.Minute},
		{"Hunyuan cold preparation and retry", &agent.ContainerHealthCheck{StartPeriod: int64(10 * time.Second), Interval: int64(180 * time.Second), Timeout: int64(180 * time.Second), Retries: 3}, 1120 * time.Second},
		{"bounded maximum", &agent.ContainerHealthCheck{StartPeriod: int64(time.Hour), Interval: int64(time.Hour), Timeout: int64(time.Hour), Retries: 3}, 35 * time.Minute},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := protectedHealthWaitBound(item.health); got != item.want {
				t.Fatalf("got %v, want %v", got, item.want)
			}
		})
	}
}

package telemetry

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPhoneBaselineReadsSmallFilesAndCorrectPageSize(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"sys/kernel/random/boot_id": "00000000-0000-4000-8000-000000000111\n",
		"meminfo":                   "MemTotal: 131000000 kB\nMemAvailable: 64000000 kB\n",
		"pressure/memory":           "some avg10=0.50 avg60=0.00 total=1\nfull avg10=0.00 avg60=0.00 total=0\n",
		"vmstat":                    "nr_free_pages 12\npswpout 17\n",
	}
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := NewPhoneBaselineSampler(root, "00000000-0000-4000-8000-000000000101", 3)
	if err != nil {
		t.Fatal(err)
	}
	s.kvm = func() (int, error) { return 12, nil }
	if _, err := s.PhoneBaseline(context.Background()); err == nil {
		t.Fatal("empty baseline accepted")
	}
	now := time.Now()
	for i := 0; i < 40; i++ {
		if err := s.collect(now.Add(time.Duration(i-39) * 2 * time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	value, err := s.PhoneBaseline(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Samples []phoneMemorySample `json:"samples"`
	}
	if err := json.Unmarshal(value, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Samples) != 17 || decoded.Samples[0].PSISomeAverage10 != 0.5 || decoded.Samples[0].AvailableBytes != 64000000*1024 || decoded.Samples[0].SwapOutBytes != 17*uint64(os.Getpagesize()) {
		t.Fatalf("unexpected bounded baseline: %s", value)
	}
	// CPU-only agents do not map /dev/kvm. Their memory samples must remain
	// usable, without incorrectly advertising virtual-phone readiness.
	s.kvm = func() (int, error) { return 0, os.ErrNotExist }
	if err := s.collect(now.Add(time.Second)); err != nil {
		t.Fatal("host memory incorrectly depends on KVM", err)
	}
	if samples, err := s.PhoneMemorySamples(context.Background()); err != nil || len(samples) != 17 {
		t.Fatal("CPU service lost host samples", err)
	}
	if _, err := s.PhoneBaseline(context.Background()); err == nil {
		t.Fatal("phone baseline must still require KVM")
	}
	if got, err := parseSwapOutBytes("pswpout 17", 65536); err != nil || got != 17*65536 {
		t.Fatal("ARM64 page size lost")
	}
	for _, body := range []string{"", "pswpout -1", "pswpout bad", "pswpout 9007199254740991", "pswpout 1\npswpout 2"} {
		if _, err := parseSwapOutBytes(body, 4096); err == nil {
			t.Fatalf("invalid counter accepted: %q", body)
		}
	}
}

func TestPhoneBaselineDoesNotBridgeRebootClockOrMissingSamples(t *testing.T) {
	for _, reason := range []string{"reboot", "gap", "clock"} {
		s := &PhoneBaselineSampler{}
		now := time.Now()
		for i := 0; i < 16; i++ {
			s.appendSample("boot-a", 12, phoneMemorySample{ObservedAt: now.Add(time.Duration(i-15) * 2 * time.Second).Format(time.RFC3339Nano)})
		}
		if _, err := s.PhoneBaseline(context.Background()); err != nil {
			t.Fatal(err)
		}
		next, boot := now.Add(2*time.Second), "boot-a"
		if reason == "reboot" {
			boot = "boot-b"
		}
		if reason == "gap" {
			next = now.Add(6 * time.Second)
		}
		if reason == "clock" {
			next = now.Add(-time.Second)
		}
		s.appendSample(boot, 12, phoneMemorySample{ObservedAt: next.Format(time.RFC3339Nano)})
		if _, err := s.PhoneBaseline(context.Background()); err == nil {
			t.Fatalf("accepted %s discontinuity", reason)
		}
	}
}

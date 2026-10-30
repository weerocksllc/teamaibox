package main

import (
	"context"
	"os"
	"path/filepath"
	"teamaibox.local/node-agent/internal/telemetry"
	"testing"
)

type inventoryFixture struct{ v telemetry.Inventory }

func (f inventoryFixture) Snapshot(context.Context) (telemetry.Inventory, error) { return f.v, nil }

func TestLiveInventoryRefreshAndConservativeFirstSample(t *testing.T) {
	d := t.TempDir()
	write := func(n, b string) {
		t.Helper()
		if e := os.WriteFile(filepath.Join(d, n), []byte(b), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 600 kB\n")
	write("stat", "cpu 10 0 10 70 10 0 0 0 8 0\n")
	v := telemetry.Inventory{Resources: telemetry.Resources{CPU: telemetry.ResourceMap{"totalMillis": 4000, "availableMillis": 3500}, UnifiedMemory: telemetry.ResourceMap{"availableBytes": 500 * 1024}, Storage: telemetry.ResourceMap{"availableBytes": 10000}}}
	p := &liveInventory{base: inventoryFixture{v}, proc: d, storage: d}
	a, e := p.Snapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if a.Resources.CPU["availableMillis"] != 0 || a.Resources.UnifiedMemory["availableBytes"] != 500*1024 {
		t.Fatal(a)
	}
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 300 kB\n")
	write("stat", "cpu 40 0 30 110 20 0 0 0 35 0\n")
	b, e := p.Snapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if b.Resources.CPU["availableMillis"] != 2000 || b.Resources.UnifiedMemory["availableBytes"] != 300*1024 || b.Resources.Storage["availableBytes"] > 10000 {
		t.Fatal(b)
	}
	if v.Resources.UnifiedMemory["availableBytes"] != 500*1024 {
		t.Fatal("mutated installed policy")
	}
	write("stat", "cpu 10 0 10 70 10 0 0 0 0 0\n")
	c, e := p.Snapshot(context.Background())
	if e != nil || c.Resources.CPU["availableMillis"] != 0 {
		t.Fatal(c, e)
	}
	write("meminfo", "MemTotal: 1000 kB\n")
	if _, e = p.Snapshot(context.Background()); e == nil {
		t.Fatal("missing measurement reused old capacity")
	}
}

func TestLiveInventoryOptInAndMalformedInputs(t *testing.T) {
	if _, e := heartbeatInventoryProvider("/config/inventory.json", func(string) string { return "" }); e != nil {
		t.Fatal(e)
	}
	if _, e := heartbeatInventoryProvider("/config/inventory.json", func(string) string { return "true" }); e == nil {
		t.Fatal("relative paths accepted")
	}
	for _, s := range []string{"MemTotal: 2 kB\nMemAvailable: 3 kB", "MemTotal: 2 kB\nMemAvailable: -1 kB", "MemTotal: 2 kB\nMemAvailable: 1 kB\nMemAvailable: 1 kB", "MemTotal: 2 kB\nMemAvailable: 1 MB"} {
		if _, _, e := liveMemory([]byte(s)); e == nil {
			t.Fatal(s)
		}
	}
	if _, _, e := liveCPU([]byte("cpu bad")); e == nil {
		t.Fatal("invalid CPU accepted")
	}
}

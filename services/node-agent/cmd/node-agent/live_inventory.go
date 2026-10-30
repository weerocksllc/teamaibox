package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"teamaibox.local/node-agent/internal/telemetry"
)

// Static inventory describes installed capabilities and upper bounds, not free
// memory at installation time. Opted-in nodes refresh availability each heartbeat
// from small procfs files. They never invoke a shell or enumerate guest data.
type liveInventory struct {
	base          telemetry.InventoryProvider
	proc, storage string
	mu            sync.Mutex
	total, idle   uint64
}

func heartbeatInventoryProvider(filename string, env func(string) string) (telemetry.InventoryProvider, error) {
	base := telemetry.FileInventoryProvider{Filename: filename}
	switch env("TEAMAIBOX_LIVE_INVENTORY_ENABLED") {
	case "", "false":
		return base, nil
	case "true":
		proc, storage := env("TEAMAIBOX_HOST_PROC_ROOT"), env("TEAMAIBOX_HOST_STORAGE_ANCHOR")
		if !filepath.IsAbs(proc) || !filepath.IsAbs(storage) {
			return nil, errors.New("live_inventory_paths_required")
		}
		return &liveInventory{base: base, proc: proc, storage: storage}, nil
	default:
		return nil, errors.New("TEAMAIBOX_LIVE_INVENTORY_ENABLED must be true or false")
	}
}

func liveRead(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(b) > 65536 {
		return nil, errors.New("live_inventory_source_invalid")
	}
	return b, nil
}

func liveMemory(raw []byte) (int64, int64, error) {
	m := map[string]int64{}
	for _, line := range strings.Split(string(raw), "\n") {
		p := strings.Fields(line)
		if len(p) == 0 || (p[0] != "MemTotal:" && p[0] != "MemAvailable:") {
			continue
		}
		if len(p) != 3 || p[2] != "kB" {
			return 0, 0, errors.New("live_memory_invalid")
		}
		n, e := strconv.ParseInt(p[1], 10, 64)
		if _, exists := m[p[0]]; exists || e != nil || n < 0 || n > (1<<53-1)/1024 {
			return 0, 0, errors.New("live_memory_invalid")
		}
		m[p[0]] = n * 1024
	}
	t, a := m["MemTotal:"], m["MemAvailable:"]
	if _, ok := m["MemAvailable:"]; !ok || t <= 0 || a > t {
		return 0, 0, errors.New("live_memory_invalid")
	}
	return t, a, nil
}

func liveCPU(raw []byte) (uint64, uint64, error) {
	line, _, _ := strings.Cut(string(raw), "\n")
	p := strings.Fields(line)
	if len(p) < 9 || p[0] != "cpu" {
		return 0, 0, errors.New("live_cpu_invalid")
	}
	var t, idle uint64
	// guest and guest_nice are already counted in user/nice by Linux.
	for i := 1; i <= 8; i++ {
		n, e := strconv.ParseUint(p[i], 10, 64)
		if e != nil || n > 1<<53-1 || t > 1<<53-1-n {
			return 0, 0, errors.New("live_cpu_invalid")
		}
		t += n
		if i == 4 || i == 5 {
			idle += n
		}
	}
	return t, idle, nil
}

func (p *liveInventory) Snapshot(ctx context.Context) (telemetry.Inventory, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, e := p.base.Snapshot(ctx)
	if e != nil {
		return v, e
	}
	raw, e := liveRead(filepath.Join(p.proc, "meminfo"))
	if e != nil {
		return v, e
	}
	total, available, e := liveMemory(raw)
	if e != nil {
		return v, e
	}
	v.Resources.UnifiedMemory = telemetry.ResourceMap{"totalBytes": total, "availableBytes": min(available, v.Resources.UnifiedMemory["availableBytes"])}
	raw, e = liveRead(filepath.Join(p.proc, "stat"))
	if e != nil {
		return v, e
	}
	t, idle, e := liveCPU(raw)
	if e != nil {
		return v, e
	}
	cpu := int64(0)
	if p.total > 0 && t > p.total && idle >= p.idle && idle-p.idle <= t-p.total {
		cpu = int64(float64(v.Resources.CPU["totalMillis"]) * float64(idle-p.idle) / float64(t-p.total))
	}
	p.total, p.idle = t, idle
	v.Resources.CPU = telemetry.ResourceMap{"totalMillis": v.Resources.CPU["totalMillis"], "availableMillis": min(cpu, v.Resources.CPU["availableMillis"])}
	var fs syscall.Statfs_t
	if e = syscall.Statfs(p.storage, &fs); e != nil {
		return v, e
	}
	if fs.Bsize <= 0 || uint64(fs.Bavail) > (1<<53-1)/uint64(fs.Bsize) {
		return v, errors.New("live_storage_invalid")
	}
	storage := int64(fs.Bavail) * int64(fs.Bsize)
	v.Resources.Storage = telemetry.ResourceMap{"availableBytes": min(storage, v.Resources.Storage["availableBytes"])}
	return v, nil
}

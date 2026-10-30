package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneMemorySample = agent.PhoneMemorySample

// PhoneBaselineSampler reads only small procfs files and the KVM version ioctl.
// It neither starts a VM nor invokes Docker, nvidia-smi, shell, or a network probe.
type PhoneBaselineSampler struct {
	procRoot, nodeID string
	generation       int64
	kvm              func() (int, error)
	mu               sync.Mutex
	bootID           string
	apiVersion       int
	samples          []phoneMemorySample
	workers          func(context.Context) ([]PhoneWorkerMemory, error)
}

type PhoneWorkerMemory struct {
	WorkerID     string `json:"workerId"`
	CurrentBytes uint64 `json:"currentBytes"`
}

// Install once before Run. The signed capacity query reads owned guest Docker
// stats; it does not depend on the optional whole-node metrics uploader.
func (s *PhoneBaselineSampler) ConfigureWorkers(socket string) error {
	provider, err := NewHostMetricProvider(HostMetricConfig{ProcRoot: s.procRoot, SysRoot: "/sys", StorageAnchor: "/", InventoryFile: "/unused", SequenceFile: "/unused", AgentVersion: "phone", NodeID: s.nodeID, SampleWindow: time.Second, DockerSocket: socket})
	if err != nil {
		return err
	}
	s.workers = provider.phoneWorkerMemory
	return nil
}

func NewPhoneBaselineSampler(procRoot, nodeID string, generation int64) (*PhoneBaselineSampler, error) {
	if !filepath.IsAbs(procRoot) || !metricUUID.MatchString(nodeID) || generation < 1 {
		return nil, errors.New("phone_baseline_configuration_invalid")
	}
	return &PhoneBaselineSampler{procRoot: procRoot, nodeID: nodeID, generation: generation, kvm: phoneKVMVersion}, nil
}

func parseSwapOutBytes(body string, pageSize uint64) (uint64, error) {
	var pages uint64
	found := false
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "pswpout" {
			continue
		}
		if found || len(fields) != 2 || pageSize == 0 {
			return 0, errors.New("phone_swap_counter_invalid")
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value > (1<<53-1)/pageSize {
			return 0, errors.New("phone_swap_counter_invalid")
		}
		pages, found = value, true
	}
	if !found {
		return 0, errors.New("phone_swap_counter_unavailable")
	}
	return pages * pageSize, nil
}

func (s *PhoneBaselineSampler) collect(at time.Time) error {
	boot, err := readBounded(filepath.Join(s.procRoot, "sys/kernel/random/boot_id"), 128)
	if err != nil || !metricUUID.MatchString(strings.TrimSpace(string(boot))) {
		return errors.New("phone_boot_identity_unavailable")
	}
	memory, err := readBounded(filepath.Join(s.procRoot, "meminfo"), 64<<10)
	if err != nil {
		return errors.New("phone_memory_unavailable")
	}
	_, available, err := parseMeminfo(string(memory))
	if err != nil || available > 1<<53-1 {
		return errors.New("phone_memory_unavailable")
	}
	pressure, err := readBounded(filepath.Join(s.procRoot, "pressure/memory"), 4096)
	if err != nil {
		return errors.New("phone_pressure_unavailable")
	}
	some, _ := parseMemoryPressure(string(pressure))
	if some.Status != "measured" || some.Value == nil || math.IsNaN(*some.Value) {
		return errors.New("phone_pressure_unavailable")
	}
	vmstat, err := readBounded(filepath.Join(s.procRoot, "vmstat"), 64<<10)
	if err != nil {
		return errors.New("phone_swap_counter_unavailable")
	}
	swap, err := parseSwapOutBytes(string(vmstat), uint64(os.Getpagesize()))
	if err != nil {
		return err
	}
	version, err := s.kvm()
	if err != nil || version != 12 {
		// KVM is required for a phone baseline, not for host-memory sampling.
		// CPU services must not require a hypervisor device in the Agent.
		version = 0
	}
	s.appendSample(strings.TrimSpace(string(boot)), version, phoneMemorySample{
		ObservedAt: at.UTC().Format("2006-01-02T15:04:05.000Z"), AvailableBytes: available, PSISomeAverage10: *some.Value * 100, SwapOutBytes: swap,
	})
	return nil
}

func (s *PhoneBaselineSampler) appendSample(bootID string, version int, value phoneMemorySample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bootID != bootID {
		s.samples = nil
	}
	if len(s.samples) > 0 {
		last, _ := time.Parse(time.RFC3339Nano, s.samples[len(s.samples)-1].ObservedAt)
		at, _ := time.Parse(time.RFC3339Nano, value.ObservedAt)
		if !at.After(last) || at.Sub(last) > 5*time.Second {
			s.samples = nil
		}
	}
	s.bootID, s.apiVersion = bootID, version
	s.samples = append(s.samples, value)
	if len(s.samples) > 17 {
		s.samples = append([]phoneMemorySample(nil), s.samples[len(s.samples)-17:]...)
	}
}

func (s *PhoneBaselineSampler) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.collect(time.Now()); err != nil {
			// Never bridge a missing or failed sample with an apparently healthy window.
			s.mu.Lock()
			s.samples = nil
			s.apiVersion = 0
			s.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *PhoneBaselineSampler) PhoneBaseline(ctx context.Context) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if len(s.samples) < 16 || s.apiVersion != 12 {
		s.mu.Unlock()
		return nil, errors.New("phone_baseline_not_ready")
	}
	last, _ := time.Parse(time.RFC3339Nano, s.samples[len(s.samples)-1].ObservedAt)
	if time.Since(last) > 10*time.Second || last.After(time.Now().Add(time.Second)) {
		s.mu.Unlock()
		return nil, errors.New("phone_baseline_stale")
	}
	boot, version, samples := s.bootID, s.apiVersion, append([]phoneMemorySample(nil), s.samples...)
	s.mu.Unlock()
	workers := []PhoneWorkerMemory{}
	if s.workers != nil {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		if values, err := s.workers(bounded); err == nil {
			workers = values
		}
		cancel()
	}
	return json.Marshal(struct {
		NodeID            string              `json:"nodeId"`
		NodeGeneration    int64               `json:"nodeGeneration"`
		BootID            string              `json:"bootId"`
		KVMAPIVersion     int                 `json:"kvmApiVersion"`
		Samples           []phoneMemorySample `json:"samples"`
		PhoneWorkers      []PhoneWorkerMemory `json:"phoneWorkers"`
		WorkersObservedAt string              `json:"workersObservedAt"`
	}{s.nodeID, s.generation, boot, version, samples, workers, time.Now().UTC().Format("2006-01-02T15:04:05.000Z")})
}

// A typed copy of the same host-only samples feeds the local protection loop.
// It never waits for a window or repeats the procfs reads on each command.
func (s *PhoneBaselineSampler) PhoneMemorySamples(ctx context.Context) ([]agent.PhoneMemorySample, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.samples) == 0 {
		return nil, errors.New("phone_baseline_not_ready")
	}
	return append([]agent.PhoneMemorySample(nil), s.samples...), nil
}

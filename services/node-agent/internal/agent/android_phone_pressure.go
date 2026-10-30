package agent

import (
	"context"
	"errors"
	"math"
	"sort"
	"time"
)

type PhoneMemorySample struct {
	ObservedAt       string  `json:"observedAt"`
	AvailableBytes   uint64  `json:"availableBytes"`
	PSISomeAverage10 float64 `json:"psiSomeAverage10"`
	SwapOutBytes     uint64  `json:"swapOutBytes"`
}

type PhoneMemorySource interface {
	PhoneMemorySamples(context.Context) ([]PhoneMemorySample, error)
}

type PhoneMemoryAssessment struct {
	MinimumAvailableBytes uint64
	AdmissionQuiet        bool
	StopReason            string
}

func validPhoneProtectionReason(reason string) bool {
	return reason == "" || reason == "memory_margin" || reason == "memory_pressure" || reason == "swap_out"
}

// The same small rolling samples serve admission and ongoing protection. Old
// swap usage alone is harmless; only increases in the swap-out counter count.
func AssessPhoneMemory(samples []PhoneMemorySample, now time.Time) (PhoneMemoryAssessment, error) {
	var empty PhoneMemoryAssessment
	bad := func() (PhoneMemoryAssessment, error) { return empty, errors.New("phone_baseline_unavailable") }
	if len(samples) < 7 || len(samples) > 128 {
		return bad()
	}
	result := PhoneMemoryAssessment{MinimumAvailableBytes: ^uint64(0), AdmissionQuiet: true}
	var first, previous, psiSince, swapSince time.Time
	for i, sample := range samples {
		at, err := time.Parse(time.RFC3339Nano, sample.ObservedAt)
		if err != nil || sample.AvailableBytes > 1<<53-1 || sample.SwapOutBytes > 1<<53-1 ||
			math.IsNaN(sample.PSISomeAverage10) || math.IsInf(sample.PSISomeAverage10, 0) ||
			sample.PSISomeAverage10 < 0 || sample.PSISomeAverage10 > 100 {
			return bad()
		}
		if i == 0 {
			first = at
		} else if !at.After(previous) || at.Sub(previous) > 5*time.Second || sample.SwapOutBytes < samples[i-1].SwapOutBytes {
			return bad()
		}
		if sample.AvailableBytes < result.MinimumAvailableBytes {
			result.MinimumAvailableBytes = sample.AvailableBytes
		}
		if sample.PSISomeAverage10 >= 1 || sample.SwapOutBytes != samples[0].SwapOutBytes {
			result.AdmissionQuiet = false
		}
		if sample.PSISomeAverage10 >= 5 {
			if psiSince.IsZero() {
				psiSince = at
			}
		} else {
			psiSince = time.Time{}
		}
		if i > 0 && float64(sample.SwapOutBytes-samples[i-1].SwapOutBytes)/at.Sub(previous).Seconds() > 1<<20 {
			if swapSince.IsZero() {
				swapSince = previous
			}
		} else {
			swapSince = time.Time{}
		}
		previous = at
	}
	if previous.Sub(first) < 30*time.Second || previous.Sub(first) > time.Minute || now.Sub(previous) > 10*time.Second || previous.After(now.Add(time.Second)) {
		return bad()
	}
	if !psiSince.IsZero() && previous.Sub(psiSince) >= 10*time.Second {
		result.StopReason = "memory_pressure"
	} else if !swapSince.IsZero() && previous.Sub(swapSince) >= 10*time.Second {
		result.StopReason = "swap_out"
	}
	return result, nil
}

// Installed composition supplies the existing procfs sampler, not request data.
// This can be configured only before a lifecycle operation has used the journal.
func (c *PhoneCoordinator) ConfigurePhoneProtection(source PhoneMemorySource) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pressureMu.Lock()
	defer c.pressureMu.Unlock()
	if c.root == nil || source == nil || c.memory != nil || c.used {
		return errors.New("phone_protection_configuration_locked")
	}
	c.memory = source
	return nil
}

func (c *PhoneCoordinator) PhoneProtectionConfigured() bool {
	c.pressureMu.Lock()
	defer c.pressureMu.Unlock()
	return c.memory != nil
}

func (c *PhoneCoordinator) assessMemory(ctx context.Context) (PhoneMemoryAssessment, error) {
	c.pressureMu.Lock()
	source := c.memory
	c.pressureMu.Unlock()
	if source == nil {
		return PhoneMemoryAssessment{}, errors.New("phone_protection_not_configured")
	}
	samples, err := source.PhoneMemorySamples(ctx)
	if err != nil {
		return PhoneMemoryAssessment{}, err
	}
	return AssessPhoneMemory(samples, time.Now())
}

// ProtectPhones stops at most one exact phone per sample, newest first. It does
// not enumerate/stop generic workers or touch disks. A failed stop remains in
// the journal and is retried even if pressure subsequently recovers.
func (c *PhoneCoordinator) ProtectPhones(ctx context.Context) (PhoneCommandResult, error) {
	assessment, sampleErr := c.assessMemory(ctx)
	c.pressureMu.Lock()
	if sampleErr == nil && assessment.StopReason != "" && c.startCancel != nil {
		c.startCancel() // Interrupt readiness wait so protection need not wait five minutes.
	}
	c.pressureMu.Unlock()
	var empty PhoneCommandResult
	// Never park the monitoring loop behind initialization that has not yet
	// installed its cancel function; the next 2s tick must still observe it.
	if !c.mu.TryLock() {
		return empty, sampleErr
	}
	defer c.mu.Unlock()
	if c.root == nil {
		return empty, errors.New("phone_journal_unavailable")
	}
	j, err := c.read()
	if err != nil {
		return empty, err
	}
	var candidates []phoneRecord
	for _, r := range j.Phones {
		pending := r.Phase == "stopping" && r.ProtectionReason != ""
		if r.Run != nil && (pending || sampleErr == nil && assessment.StopReason != "" && (r.Phase == "starting" || r.Phase == "running")) {
			candidates = append(candidates, r)
		}
	}
	if len(candidates) == 0 {
		return empty, sampleErr
	}
	sort.Slice(candidates, func(i, k int) bool {
		a, b := candidates[i], candidates[k]
		if (a.ProtectionReason != "") != (b.ProtectionReason != "") {
			return a.ProtectionReason != ""
		}
		if a.StartedAtUnixMs != b.StartedAtUnixMs {
			return a.StartedAtUnixMs > b.StartedAtUnixMs
		}
		return a.Identity.PhoneID > b.Identity.PhoneID
	})
	r := candidates[0]
	if r.ProtectionReason == "" {
		r.ProtectionReason = assessment.StopReason
	}
	r.Phase = "stopping"
	j.Phones[r.Identity.PhoneID] = r
	if err := c.write(j); err != nil {
		return empty, err
	}
	p := PhoneCommandPayload{PhoneIdentity: r.Identity, OperationID: r.Run.ID, Generation: r.Generation, Run: r.Run}
	bounded, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	result, err := c.driver.StopPhone(bounded, p)
	if err == nil {
		err = validatePhoneResult("stop", p, result)
	}
	if err != nil {
		return empty, err // No unconfirmed release and no recursive force/delete fallback.
	}
	r.Phase = "stopped"
	j.Phones[r.Identity.PhoneID] = r
	if err := c.write(j); err != nil {
		return empty, err
	}
	result.ProtectionReason = r.ProtectionReason
	return result, nil
}

func (c *PhoneCoordinator) RunPhoneProtection(ctx context.Context, onError func(error)) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := c.ProtectPhones(ctx); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}

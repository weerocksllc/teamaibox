// phone-driver-check exercises the installed production adapters with two NEW
// synthetic phones. It is an offline qualification binary, not an HTTP API.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/docker"
	"teamaibox.local/node-agent/internal/telemetry"
)

type config struct {
	Policy  docker.PhoneContainerPolicy `json:"policy"`
	Socket  string                      `json:"socket"`
	State   string                      `json:"state"`
	Phones  []agent.PhoneCommandPayload `json:"phones"`
	NextRun agent.PhoneRunIdentity      `json:"nextRun"`
}

var eventJournal *os.File

func main() {
	path := flag.String("config", "", "qualification declaration")
	flag.Parse()
	if err := run(*path); err != nil {
		event("failed", map[string]any{"error": err.Error()})
		if eventJournal != nil {
			eventJournal.Close()
		}
		os.Exit(1)
	}
	if eventJournal != nil {
		eventJournal.Close()
	}
}
func event(stage string, value any) {
	entry := map[string]any{"stage": stage, "at": time.Now().UTC().Format(time.RFC3339Nano), "value": value}
	if eventJournal != nil {
		_ = json.NewEncoder(eventJournal).Encode(entry)
		_ = eventJournal.Sync()
	}
	json.NewEncoder(os.Stdout).Encode(entry)
}

func run(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var cfg config
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if len(raw) > 65536 || d.Decode(&cfg) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || len(cfg.Phones) != 2 || os.Getuid() != 10001 {
		return errors.New("invalid qualification config")
	}
	eventJournal, err = os.OpenFile(filepath.Join(cfg.State, "events.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	engine, err := docker.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	resources, err := docker.NewInstalledPhoneResources(engine, cfg.Policy, cfg.Socket)
	if err != nil {
		return err
	}
	defer resources.Close()
	driver, err := docker.NewPhoneDriver(engine, cfg.Policy, resources)
	if err != nil {
		return err
	}
	policy := agent.PhoneRuntimePolicy{NodeID: cfg.Policy.NodeID, NodeGeneration: cfg.Policy.NodeGeneration, PoolID: cfg.Policy.PoolID, ImageDigest: cfg.Policy.ImageID}
	coordinator, err := agent.NewPhoneCoordinator(cfg.State, policy, driver)
	if err != nil {
		return err
	}
	defer func() { coordinator.Close() }()
	baseline, err := telemetry.NewPhoneBaselineSampler("/host/proc", policy.NodeID, policy.NodeGeneration)
	if err != nil {
		return err
	}
	if err = coordinator.ConfigurePhoneProtection(baseline); err != nil {
		return err
	}
	go baseline.Run(ctx)
	protection, stopProtection := context.WithCancel(ctx)
	defer stopProtection()
	event("baseline-started", nil)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(33 * time.Second):
	}
	samples, err := baseline.PhoneMemorySamples(ctx)
	if err != nil {
		return err
	}
	assessment, err := agent.AssessPhoneMemory(samples, time.Now())
	if err != nil || !assessment.AdmissionQuiet || assessment.MinimumAvailableBytes < 28<<30 {
		return errors.New("qualification_capacity_unavailable")
	}
	event("baseline", assessment)
	go coordinator.RunPhoneProtection(protection, func(err error) { event("protection-error", err.Error()) })
	execute := func(action string, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
		start := time.Now()
		result, err := coordinator.ExecutePhone(ctx, action, p, agent.Ownership{NodeID: policy.NodeID, NodeGeneration: policy.NodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1})
		event(action, map[string]any{"result": result, "seconds": time.Since(start).Seconds(), "error": safe(err)})
		return result, err
	}
	started := map[int]bool{}
	defer func() {
		for i := range cfg.Phones {
			if started[i] {
				c, done := context.WithTimeout(context.Background(), 100*time.Second)
				value, e := driver.StopPhone(c, cfg.Phones[i])
				done()
				event("cleanup-stop", map[string]any{"result": value, "error": safe(e)})
			}
		}
	}()
	for _, p := range cfg.Phones {
		provision := p
		provision.Run = nil
		provision.Generation = 0
		if _, err = execute("provision", provision); err != nil {
			return err
		}
	}
	containers := map[int]string{}
	for i, p := range cfg.Phones {
		started[i] = true
		result, e := execute("start", p)
		if e != nil {
			return e
		}
		containers[i] = result.ContainerID
		b, e := resources.ResolveRun(ctx, p)
		if e != nil {
			return e
		}
		_ = b
		decl, e := os.ReadFile(filepath.Join(cfg.Policy.ControlRoot, p.Run.ID, "config.json"))
		if e != nil {
			return e
		}
		var slot struct {
			Instance int `json:"instance"`
		}
		json.Unmarshal(decl, &slot)
		text := []byte("phone-data-" + p.PhoneID)
		_, e = guest(ctx, result.ContainerID, slot.Instance, "write", string(text))
		if e != nil {
			return e
		}
		got, e := guest(ctx, result.ContainerID, slot.Instance, "read", "")
		if e != nil {
			return e
		}
		sum := sha256.Sum256(text)
		if !strings.HasPrefix(got, hex.EncodeToString(sum[:])) {
			return errors.New("guest_file_write_unconfirmed")
		}
		adbProof, e := probeADBDriver(ctx, coordinator, p, policy, cfg.State)
		if e != nil {
			return e
		}
		fileProof, e := probeFilesDriver(ctx, coordinator, p, false)
		if e != nil {
			return e
		}
		event("guest-data", map[string]any{"phoneId": p.PhoneID, "sha256": hex.EncodeToString(sum[:]), "adb": adbProof, "files": fileProof})
	}
	// Exact retry must return the existing VM and disk, not boot a duplicate.
	result, err := execute("start", cfg.Phones[0])
	if err != nil || result.ContainerID != containers[0] {
		return errors.New("duplicate_start_not_recovered")
	}
	result, err = execute("stop", cfg.Phones[0])
	if err != nil {
		return err
	}
	started[0] = false
	if !result.CleanShutdown {
		return errors.New("shutdown_not_clean")
	}
	other, err := execute("inspect", cfg.Phones[1])
	if err != nil || !other.AndroidReady || other.ContainerID != containers[1] {
		return errors.New("other_phone_interrupted")
	}
	// Rebuild the actual coordinator/adapter clients from their persisted files.
	stopProtection()
	if err = coordinator.Close(); err != nil {
		return err
	}
	coordinator, err = agent.NewPhoneCoordinator(cfg.State, policy, driver)
	if err != nil {
		return err
	}
	if err = coordinator.ConfigurePhoneProtection(baseline); err != nil {
		return err
	}
	protection, stopProtection = context.WithCancel(ctx)
	defer stopProtection()
	go coordinator.RunPhoneProtection(protection, func(err error) { event("protection-error", err.Error()) })
	other, err = execute("inspect", cfg.Phones[1])
	if err != nil || !other.AndroidReady {
		return errors.New("journal_restart_lost_phone")
	}
	event("coordinator-reopened", map[string]any{"otherContainerId": other.ContainerID})
	// A new generation is a new admission, unlike the read-only duplicate.
	// Allow real procfs samples to become quiet after the preceding shutdown;
	// never replace them or relax the production memory/PSI/swap-out gates.
	admissionDeadline := time.Now().Add(65 * time.Second)
	for {
		values, e := baseline.PhoneMemorySamples(ctx)
		if e != nil {
			return e
		}
		assessment, e := agent.AssessPhoneMemory(values, time.Now())
		if e == nil && assessment.AdmissionQuiet && assessment.StopReason == "" && assessment.MinimumAvailableBytes >= 22<<30 {
			event("restart-admission", assessment)
			break
		}
		if time.Now().After(admissionDeadline) {
			return errors.New("restart_capacity_unavailable")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	cfg.Phones[0].Generation++
	cfg.Phones[0].Run = &cfg.NextRun
	started[0] = true
	result, err = execute("start", cfg.Phones[0])
	if err != nil {
		return err
	}
	decl, err := os.ReadFile(filepath.Join(cfg.Policy.ControlRoot, cfg.NextRun.ID, "config.json"))
	if err != nil {
		return err
	}
	var slot struct {
		Instance int `json:"instance"`
	}
	json.Unmarshal(decl, &slot)
	got, err := guest(ctx, result.ContainerID, slot.Instance, "read", "")
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte("phone-data-" + cfg.Phones[0].PhoneID))
	if !strings.HasPrefix(got, hex.EncodeToString(sum[:])) {
		return errors.New("guest_file_not_retained")
	}
	fileProof, err := probeFilesDriver(ctx, coordinator, cfg.Phones[0], true)
	if err != nil {
		return err
	}
	event("guest-data-retained", map[string]any{"sha256": hex.EncodeToString(sum[:]), "newContainer": result.ContainerID, "files": fileProof})
	for i, p := range cfg.Phones {
		result, err = execute("stop", p)
		if err != nil {
			return err
		}
		started[i] = false
		if !result.CleanShutdown {
			return errors.New("shutdown_not_clean")
		}
	}
	for _, p := range cfg.Phones {
		p.Run = nil
		if _, err = execute("delete", p); err != nil {
			return err
		}
	}
	event("complete", map[string]any{"passed": true, "kernelFixtureUsed": false, "browserAccepted": false})
	return nil
}
func safe(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

// Qualification-only fixed guest-file probe; there is no shell endpoint in the
// product driver. Docker IDs come exclusively from the exact validated driver.
func guest(ctx context.Context, container string, instance int, action, value string) (string, error) {
	if len(container) != 64 || (instance != 21 && instance != 22) {
		return "", errors.New("guest_probe_identity_invalid")
	}
	args := []string{"/opt/cuttlefish/bin/adb", "-s", fmt.Sprintf("127.0.0.1:%d", 6519+instance), "shell"}
	if action == "write" {
		args = append(args, "sh", "-c", "'printf %s "+value+" > /data/local/tmp/teamaibox-qualification'")
	} else {
		args = append(args, "toybox", "sha256sum", "/data/local/tmp/teamaibox-qualification")
	}
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
	}}}
	defer client.CloseIdleConnections()
	request := func(path string, body any) ([]byte, error) {
		encoded, _ := json.Marshal(body)
		c, done := context.WithTimeout(ctx, 20*time.Second)
		defer done()
		r, e := http.NewRequestWithContext(c, "POST", "http://docker/v1.48"+path, bytes.NewReader(encoded))
		if e != nil {
			return nil, e
		}
		r.Header.Set("Content-Type", "application/json")
		resp, e := client.Do(r)
		if e != nil {
			return nil, e
		}
		defer resp.Body.Close()
		raw, e := io.ReadAll(io.LimitReader(resp.Body, 65537))
		if e != nil || len(raw) > 65536 || resp.StatusCode < 200 || resp.StatusCode > 299 {
			return nil, errors.New("guest_probe_failed")
		}
		return raw, nil
	}
	raw, err := request("/containers/"+container+"/exec", map[string]any{"AttachStdout": true, "AttachStderr": true, "User": "10001:10001", "Cmd": args})
	if err != nil {
		return "", err
	}
	var exec struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(raw, &exec) != nil || len(exec.ID) != 64 {
		return "", errors.New("guest_probe_failed")
	}
	raw, err = request("/exec/"+exec.ID+"/start", map[string]any{"Detach": false, "Tty": false})
	if err != nil {
		return "", err
	}
	var output strings.Builder
	for len(raw) >= 8 {
		size := int(binary.BigEndian.Uint32(raw[4:8]))
		if size > len(raw)-8 {
			return "", errors.New("guest_probe_failed")
		}
		output.Write(raw[8 : 8+size])
		raw = raw[8+size:]
	}
	if len(raw) != 0 {
		return "", errors.New("guest_probe_failed")
	}
	return output.String(), nil
}

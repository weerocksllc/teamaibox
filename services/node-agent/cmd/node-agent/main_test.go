package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type commandServiceFixture struct{}

func (commandServiceFixture) Handle(context.Context, agent.CommandEnvelope, agent.AuthProof) (agent.CommandResult, error) {
	return agent.CommandResult{}, nil
}

func TestRestrictedCommandServiceUsesExactMinimalMigrationSurface(t *testing.T) {
	raw := "protected-set.transaction.execute,protected-set.transaction.inspect"
	service, err := restrictedCommandService(commandServiceFixture{}, raw)
	if err != nil {
		t.Fatalf("valid migration command allowlist was rejected: %v", err)
	}
	restricted, ok := service.(commandTypeRestrictedService)
	if !ok || len(restricted.allowed) != 2 || !restricted.allowed["protected-set.transaction.execute"] ||
		!restricted.allowed["protected-set.transaction.inspect"] {
		t.Fatalf("unexpected migration command allowlist: %#v", service)
	}
	if _, err := restricted.Handle(context.Background(), agent.CommandEnvelope{Type: "worker.start"}, agent.AuthProof{}); err == nil {
		t.Fatal("unlisted command type was accepted")
	}
}

func TestRestrictedCommandServiceRejectsDuplicateAndMalformedTypes(t *testing.T) {
	for _, raw := range []string{"worker.start,worker.start", "Worker.start", "worker_start", ",worker.start"} {
		if _, err := restrictedCommandService(commandServiceFixture{}, raw); err == nil {
			t.Fatalf("invalid command allowlist was accepted: %q", raw)
		}
	}
}

func TestRestrictedCommandServiceCoexistsWithPhoneAndComputerCapabilities(t *testing.T) {
	raw := "appliance.inspect,android-phone.baseline,android-phone.provision,android-phone.start,android-phone.stop,android-phone.inspect,android-phone.delete,android-phone.media.open,android-phone.media.renew,android-phone.media.close,android-phone.file.transfer,android-phone.storage,android-phone.camera.input,android-phone.camera.usb.inventory,virtual-computer.baseline,virtual-computer.create,virtual-computer.start,virtual-computer.shutdown,virtual-computer.delete,virtual-computer.inspect"
	service, err := restrictedCommandService(commandServiceFixture{}, raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range strings.Split(raw, ",") {
		if _, err := service.Handle(context.Background(), agent.CommandEnvelope{Type: name}, agent.AuthProof{}); err != nil {
			t.Fatalf("installed command rejected: %s", name)
		}
	}
	if _, err := service.Handle(context.Background(), agent.CommandEnvelope{Type: "worker.stop"}, agent.AuthProof{}); err == nil {
		t.Fatal("unlisted command accepted")
	}
	if _, err := restrictedCommandService(commandServiceFixture{}, strings.Repeat("a", 65537)); err == nil {
		t.Fatal("oversized configuration accepted")
	}
}

func TestProtectedSetRecoveryOnlyRequiresExactInspectSurface(t *testing.T) {
	if !protectedSetRecoveryOnlyAllowed("protected-set.transaction.inspect") {
		t.Fatal("exact recovery-only surface was rejected")
	}
	for _, raw := range []string{
		"", "protected-set.transaction.execute",
		"protected-set.transaction.inspect,protected-set.transaction.execute",
		" protected-set.transaction.inspect,worker.start ",
	} {
		if protectedSetRecoveryOnlyAllowed(raw) {
			t.Fatalf("non-exact recovery-only surface was accepted: %q", raw)
		}
	}
}

func TestLoadNodeIdentityAcceptsCompleteLocalMetadata(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "node.json")
	value := `{"nodeId":"00000000-0000-4000-8000-000000000102","nodeKey":"spark-worker-02.test","generation":7,"certificateFingerprint":"sha256:` + strings.Repeat("a", 64) + `","certificateNotAfter":"2099-08-12T00:00:00Z"}`
	if err := os.WriteFile(filename, []byte(value+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEAMAIBOX_NODE_IDENTITY_FILE", filename)
	generationFilename := filepath.Join(directory, "node-generation")
	t.Setenv("TEAMAIBOX_NODE_GENERATION_FILE", generationFilename)
	nodeID, generation, err := loadNodeIdentity()
	if err != nil {
		t.Fatalf("complete persisted appliance identity was rejected: %v", err)
	}
	if nodeID != "00000000-0000-4000-8000-000000000102" || generation != 7 {
		t.Fatalf("unexpected identity: %s generation %d", nodeID, generation)
	}
	if _, statErr := os.Lstat(generationFilename); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("ordinary startup created generation state: %v", statErr)
	}
}

func TestWatchGenerationFileRequiresForwardExactState(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "node-generation")
	if err := os.WriteFile(filename, []byte("7\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- watchGenerationFile(ctx, filename, 7, 5*time.Millisecond) }()
	select {
	case err := <-result:
		t.Fatalf("current generation unexpectedly stopped the watcher: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	nextFilename := filepath.Join(directory, "node-generation.next")
	if err := os.WriteFile(nextFilename, []byte("8\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(nextFilename, filename); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, errNodeGenerationAdvanced) {
			t.Fatalf("forward generation did not request a restart: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("forward generation did not stop the watcher")
	}
}

func TestWatchGenerationFileRejectsRegressionAndMalformedState(t *testing.T) {
	for name, value := range map[string]string{"regression": "6\n", "malformed": "7"} {
		t.Run(name, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "node-generation")
			if err := os.WriteFile(filename, []byte(value), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := watchGenerationFile(context.Background(), filename, 7, time.Millisecond); err == nil || errors.Is(err, errNodeGenerationAdvanced) {
				t.Fatalf("invalid generation state was accepted: %v", err)
			}
		})
	}
}

func TestWatchGenerationFileStopsOnCancellationWhenFileIsAbsent(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "node-generation")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := watchGenerationFile(ctx, filename, 7, time.Millisecond)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled watcher returned %v", err)
	}
	if _, statErr := os.Lstat(filename); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("generation watcher created absent state: %v", statErr)
	}
}

func TestLoadNodeIdentityRejectsTruncatedUnknownAndExpiredMetadata(t *testing.T) {
	for name, value := range map[string]string{
		"truncated": `{"nodeId":"00000000-0000-4000-8000-000000000102","generation":1}`,
		"unknown":   `{"nodeId":"00000000-0000-4000-8000-000000000102","nodeKey":"spark-worker-02.test","generation":1,"certificateFingerprint":"sha256:` + strings.Repeat("a", 64) + `","certificateNotAfter":"2099-08-12T00:00:00Z","credential":"forbidden"}`,
		"expired":   `{"nodeId":"00000000-0000-4000-8000-000000000102","nodeKey":"spark-worker-02.test","generation":1,"certificateFingerprint":"sha256:` + strings.Repeat("a", 64) + `","certificateNotAfter":"2020-08-12T00:00:00Z"}`,
	} {
		t.Run(name, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "node.json")
			if err := os.WriteFile(filename, []byte(value+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("TEAMAIBOX_NODE_IDENTITY_FILE", filename)
			if _, _, err := loadNodeIdentity(); err == nil {
				t.Fatal("invalid persisted appliance identity was accepted")
			}
		})
	}
}

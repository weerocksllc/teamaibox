package docker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

type installationAndGuestStorage struct {
	guest phoneQuotaClient
	media *installationStorageFixture
}

func (f installationAndGuestStorage) Handle(ctx context.Context, q phonepool.Request) (phonepool.Result, error) {
	if strings.HasPrefix(q.Action, "computer-media-") {
		return f.media.Handle(ctx, q)
	}
	return f.guest.Handle(ctx, q)
}

func TestInstallationCapacityRefusalCompletesAndNewRevisionCanRetry(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	r.policy.Profiles[0].ManagedMedia = true
	p.Run, p.Allocation, p.Generation = nil, nil, 0
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte("test")))
	p.Installation = &agent.ComputerInstallationCommand{Action: "mount", Revision: 1, Digest: &digest, Size: 4}
	f := &installationStorageFixture{directory: r.storage.installerDirectory(p), capacity: 0}
	r.storage.storage = installationAndGuestStorage{r.storage.storage, f}
	r.storage.mediaOwnership = func(*os.File) error { return nil }
	result, err := r.applyInstallation(context.Background(), p, strings.NewReader("test"))
	if err != nil || !result.Rejected || !result.NoSideEffects || result.ErrorCode != "computer_capacity_unavailable" {
		t.Fatal(result, err)
	}
	f.capacity = 1024
	result, err = r.applyInstallation(context.Background(), p, strings.NewReader("test"))
	if err != nil || !result.Rejected {
		t.Fatal("same operation must retain its result", result, err)
	}
	p.Installation.Revision = 2
	p.OperationID = "40000000-0000-4000-8000-000000000022"
	result, err = r.applyInstallation(context.Background(), p, strings.NewReader("test"))
	if err != nil || result.Rejected || !result.MediaReady || result.MediaDigest == nil || *result.MediaDigest != digest {
		t.Fatal("fresh retry did not recover", result, err)
	}
}

func TestStoppedInstallationSurvivesInstalledRuntimeUpdate(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	r.policy.Profiles[0].ManagedMedia = true
	p.Run, p.Allocation, p.Generation = nil, nil, 0
	profile := r.policy.Profiles[0]
	config, err := buildComputerRuntimeConfig(p, profile.ComputerRuntimeProfile)
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(r.policy.ControlRoot, "prepare", p.ComputerID, "config")
	if err = os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(config)
	if err = os.WriteFile(filepath.Join(base, "config.json"), raw, 0444); err != nil {
		t.Fatal(err)
	}
	identity := filepath.Join(r.storage.dataRoot, p.VolumeID, "guest", "identity.json")
	before, _ := os.ReadFile(identity)
	r.policy.Profiles[0].RuntimeImage = "sha256:" + strings.Repeat("f", 64)
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte("test")))
	p.Installation = &agent.ComputerInstallationCommand{Action: "mount", Revision: 1, Digest: &digest, Size: 4}
	f := &installationStorageFixture{directory: r.storage.installerDirectory(p), capacity: 1024}
	r.storage.storage = installationAndGuestStorage{r.storage.storage, f}
	r.storage.mediaOwnership = func(*os.File) error { return nil }
	result, err := r.applyInstallation(context.Background(), p, strings.NewReader("test"))
	if err != nil || !result.MediaReady || result.Rejected {
		t.Fatal(result, err)
	}
	after, _ := os.ReadFile(identity)
	if !bytes.Equal(before, after) {
		t.Fatal("disk identity changed")
	}
	// A mismatching recorded permanent identity is not a compatible update.
	config.FirmwareID = "40000000-0000-4000-8000-000000000099"
	raw, _ = json.Marshal(config)
	if err = os.Chmod(filepath.Join(base, "config.json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(base, "config.json"), raw, 0444); err != nil {
		t.Fatal(err)
	}
	if _, err = r.applyInstallation(context.Background(), p, strings.NewReader("test")); err == nil {
		t.Fatal("accepted changed firmware identity")
	}
}

func TestInstallationLaunchCreatesOptionalJournalAndKeepsLegacyDiskIdentity(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	r.policy.Profiles[0].ManagedMedia = true
	p.Installation = &agent.ComputerInstallationCommand{Action: "launch", Revision: 1}
	f := &installationStorageFixture{directory: r.storage.installerDirectory(p), capacity: 1024}
	r.storage.storage = installationAndGuestStorage{r.storage.storage, f}
	identity := filepath.Join(r.storage.dataRoot, p.VolumeID, "guest", "identity.json")
	before, err := os.ReadFile(identity)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := r.BindComputerRun(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	request, err := os.ReadFile(filepath.Join(binding.ConfigDirectory, "installation-request.json"))
	if err != nil || !bytes.Contains(request, []byte(p.Run.ID)) {
		t.Fatal(string(request), err)
	}
	after, err := os.ReadFile(identity)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("legacy identity changed", err)
	}
	if _, err = r.BindComputerRun(context.Background(), p); err != nil {
		t.Fatal("request replay", err)
	}
}

func TestInstallationStagingLocksOnlyTargetVolume(t *testing.T) {
	s := &InstalledComputerStorage{}
	unlock := s.lockInstallationVolume("first")
	other := make(chan struct{})
	go func() {
		release := s.lockInstallationVolume("second")
		release()
		close(other)
	}()
	select {
	case <-other:
	case <-time.After(time.Second):
		unlock()
		t.Fatal("one ISO transfer blocked a different volume")
	}
	unlock()
	release := s.lockInstallationVolume("first")
	release()
}

type installationStorageFixture struct {
	directory          string
	capacity, reserved uint64
	ready              bool
	calls              []phonepool.Request
}

func (f *installationStorageFixture) Handle(_ context.Context, q phonepool.Request) (phonepool.Result, error) {
	f.calls = append(f.calls, q)
	if q.Action == "computer-media-inspect" && !f.ready {
		return phonepool.Result{}, errors.New("computer_media_storage_missing")
	}
	if q.Action == "computer-media-prepare" {
		if q.MediaBytes > f.capacity {
			return phonepool.Result{}, errors.New("computer_media_capacity_unavailable")
		}
		f.reserved = q.MediaBytes
		f.ready = true
		if err := os.MkdirAll(f.directory, 0700); err != nil {
			return phonepool.Result{}, err
		}
	}
	if q.Action == "computer-media-delete" {
		f.ready = false
	}
	i := *q.Computer
	return phonepool.Result{Computer: &i, Media: true, ProjectID: 100001, QuotaBytes: (f.reserved + 65536 + 1023) / 1024 * 1024, Deleted: q.Action == "computer-media-delete"}, nil
}

type measuredReader struct {
	source  *bytes.Reader
	largest int
}

func (r *measuredReader) Read(b []byte) (int, error) {
	if len(b) > r.largest {
		r.largest = len(b)
	}
	return r.source.Read(b)
}

func TestInstallationStagingStreamingDigestCapacityAndRetry(t *testing.T) {
	p, _, _ := computerFixture(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owned := false
	s := &InstalledComputerStorage{nodeID: p.NodeID, poolID: p.PoolID, dataRoot: filepath.Join(root, "volumes"),
		mediaOwnership: func(f *os.File) error { owned = true; return nil }}
	f := &installationStorageFixture{directory: s.installerDirectory(p), capacity: 32 << 20}
	s.storage = f
	data := bytes.Repeat([]byte("ISO bytes"), 1<<20)
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
	reader := &measuredReader{source: bytes.NewReader(data)}
	if err = s.StageInstallationMedia(context.Background(), p, digest, int64(len(data)), reader); err != nil {
		t.Fatal(err)
	}
	if !owned || reader.largest > 1<<20 || f.reserved != uint64(len(data)) {
		t.Fatal("unbounded copy or wrong reservation")
	}
	file := filepath.Join(f.directory, digest[7:]+".iso")
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0400 {
		t.Fatal("not immutable staged media", err)
	}
	// Existing verified copy means a lost reply never consumes the stream again.
	if err = s.StageInstallationMedia(context.Background(), p, digest, int64(len(data)), strings.NewReader("must not copy")); err != nil {
		t.Fatal(err)
	}
	before := len(f.calls)
	badDigest := "sha256:" + strings.Repeat("a", 64)
	if err = s.StageInstallationMedia(context.Background(), p, badDigest, 4, strings.NewReader("bad!")); err == nil {
		t.Fatal("accepted corrupt ISO")
	}
	if f.reserved != uint64(len(data)) {
		t.Fatal("failed copy retained unwritten reservation")
	}
	if len(f.calls) <= before {
		t.Fatal("no capacity admission")
	}
	f.capacity = uint64(len(data))
	if err = s.StageInstallationMedia(context.Background(), p, badDigest, 4, strings.NewReader("bad!")); err == nil || err.Error() != "computer_media_capacity_unavailable" {
		t.Fatal("ignored capacity", err)
	}
	entries, _ := os.ReadDir(f.directory)
	if len(entries) != 1 {
		t.Fatal("left partial media")
	}
	foreign := p
	foreign.NodeID = "40000000-0000-4000-8000-000000000001"
	if err = s.StageInstallationMedia(context.Background(), foreign, digest, int64(len(data)), bytes.NewReader(data)); err == nil {
		t.Fatal("foreign binding")
	}
}

func TestInstallationStagingReadOnlyMountDoesNotExposeOtherComputers(t *testing.T) {
	p, b, _ := computerFixture(t)
	b.InstallerDirectory = "/srv/pool/installation-media/" + p.VolumeID + "/installer"
	spec, err := buildComputerContainer(p, b)
	if err != nil {
		t.Fatal(err)
	}
	mounts := spec["HostConfig"].(map[string]any)["Mounts"].([]map[string]any)
	found := false
	for _, mount := range mounts {
		if mount["Target"] == "/media/installer" {
			found = true
			if mount["Source"] != b.InstallerDirectory || mount["ReadOnly"] != true {
				t.Fatal("wrong mount")
			}
		}
	}
	if !found {
		t.Fatal("missing installer")
	}
	b.InstallerDirectory = b.GuestDirectory
	if _, err = buildComputerContainer(p, b); err == nil {
		t.Fatal("guest data exposed as media")
	}
}

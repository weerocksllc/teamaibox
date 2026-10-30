//go:build linux

package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
	"teamaibox.local/node-agent/internal/telemetry"
)

type computerPoolAdapter struct{ pool *phonepool.Pool }

func (a computerPoolAdapter) Handle(ctx context.Context, q phonepool.Request) (phonepool.Result, error) {
	if e := ctx.Err(); e != nil {
		return phonepool.Result{}, e
	}
	return a.pool.Handle(q)
}
func agentAssessComputerFixture(samples []agent.PhoneMemorySample) (bool, error) {
	a, e := agent.AssessPhoneMemory(samples, time.Now())
	return a.AdmissionQuiet, e
}
func computerRunFixture(p agent.ComputerCommand, image string) agent.ComputerCommand {
	p.Generation = 1
	p.Run = &agent.ComputerRun{ID: computerFixtureID(p.ComputerID + "run"), Generation: 1, RuntimeImage: image}
	p.Allocation = &agent.ComputerAllocation{MemoryBytes: 2 << 30, CPUIds: []int{10}}
	return p
}
func computerFixtureID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	sum[6] = (sum[6] & 15) | 0x50
	sum[8] = (sum[8] & 63) | 0x80
	h := hex.EncodeToString(sum[:16])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Opt-in synthetic encrypted fixture, NOT an installed Windows acceptance.
// Exercises the production adapter/engine/runtime as UID 10001, real KVM and
// TPM. Only its own empty firmware guest is terminated during teardown.
func TestComputerResourcesLinuxIntegration(t *testing.T) {
	stage := os.Getenv("COMPUTER_LIFECYCLE_TEST_ROOT")
	if stage == "" {
		t.Skip("requires isolated Linux runtime fixture")
	}
	image := os.Getenv("COMPUTER_LIFECYCLE_TEST_IMAGE")
	if os.Geteuid() != 0 || !phonePrivateRoot(stage) || !strings.HasPrefix(filepath.Base(stage), "teamaibox-computer-lifecycle-") || !digestID.MatchString(image) {
		t.Fatal("invalid explicit fixture")
	}
	command := func(input []byte, name string, args ...string) (string, error) {
		bounded, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(bounded, name, args...)
		cmd.Stdin = bytes.NewReader(input)
		out, e := cmd.Output()
		if e != nil {
			return "", fmt.Errorf("fixture %s failed", name)
		}
		return strings.TrimSpace(string(out)), nil
	}
	root := filepath.Join(stage, "synthetic")
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	file, mount := filepath.Join(root, "fixture.luks2"), filepath.Join(root, "mounted")
	if e := os.Mkdir(mount, 0700); e != nil {
		t.Fatal(e)
	}
	mapper := "teamaibox-phone-" + filepath.Base(stage)
	if _, e := os.Lstat("/dev/mapper/" + mapper); !os.IsNotExist(e) {
		t.Fatal("fixture mapper occupied")
	}
	f, e := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	e = f.Truncate(24 << 30)
	f.Close()
	if e != nil {
		t.Fatal(e)
	}
	key := make([]byte, 64)
	if _, e = rand.Read(key); e != nil {
		t.Fatal(e)
	}
	defer func() { clear(key) }()
	mapped, mounted := false, false
	var ownedContainers, ownedNetworks []string
	defer func() {
		ok := true
		for _, id := range ownedContainers {
			if _, e := command(nil, "docker", "inspect", id); e != nil {
				continue
			}
			if _, e := command(nil, "docker", "rm", "-f", id); e != nil {
				t.Error("owned fixture container cleanup failed")
				ok = false
			}
		}
		for _, id := range ownedNetworks {
			if _, e := command(nil, "docker", "network", "inspect", id); e != nil {
				continue
			}
			if _, e := command(nil, "docker", "network", "rm", id); e != nil {
				t.Error("owned fixture network cleanup failed")
				ok = false
			}
		}
		if !ok {
			return
		}
		if mounted {
			if _, e := command(nil, "umount", mount); e != nil {
				t.Error(e)
				return
			}
		}
		if mapped {
			if _, e := command(nil, "cryptsetup", "close", mapper); e != nil {
				t.Error(e)
				return
			}
		}
		if loops, e := command(nil, "losetup", "-j", file); e != nil || loops != "" {
			t.Error("fixture loop remains")
			return
		}
		for _, path := range []string{file, mount, root} {
			if e := os.Remove(path); e != nil {
				t.Error(e)
				return
			}
		}
		fmt.Println("COMPUTER_LIFECYCLE_FIXTURE_REMOVED")
	}()
	if _, e = command(key, "cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", "-", file); e != nil {
		t.Fatal(e)
	}
	if _, e = command(key, "cryptsetup", "open", "--key-file", "-", file, mapper); e != nil {
		t.Fatal(e)
	}
	mapped = true
	if _, e = command(nil, "mkfs.ext4", "-F", "-m", "0", "-O", "project,quota", "-E", "quotatype=prjquota,nodiscard", "/dev/mapper/"+mapper); e != nil {
		t.Fatal(e)
	}
	if _, e = command(nil, "mount", "-o", "nosuid,nodev,noexec,prjquota", "/dev/mapper/"+mapper, mount); e != nil {
		t.Fatal(e)
	}
	mounted = true
	c := phonepool.Config{PoolID: filepath.Base(stage), Root: mount, ClientUID: 10001, ComputerOverheadBytes: 256 << 20}
	c.LUKSUUID, e = command(nil, "cryptsetup", "luksUUID", file)
	if e != nil {
		t.Fatal(e)
	}
	c.FilesystemUUID, e = command(nil, "blkid", "-s", "UUID", "-o", "value", "/dev/mapper/"+mapper)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(map[string]string{"poolId": c.PoolID, "luksUUID": c.LUKSUUID, "filesystemUUID": c.FilesystemUUID})
	if e = os.WriteFile(filepath.Join(mount, "pool.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	pool, e := phonepool.New(c)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	p, _, _ := computerFixture(t)
	p.ComputerID = computerFixtureID(stage + "computer")
	p.OwnerID = computerFixtureID(stage + "owner")
	p.NodeID = computerFixtureID(stage + "node")
	p.VolumeID = computerFixtureID(stage + "volume")
	p.FirmwareID = computerFixtureID(stage + "firmware")
	p.OperationID = computerFixtureID(stage + "operation")
	tpmID := computerFixtureID(stage + "tpm")
	p.TPMID = &tpmID
	p.PoolID = c.PoolID
	p.RuntimeImage = image
	p.Run = nil
	p.Generation = 0
	p.Resources.MemoryBytes = 1 << 30
	p.Resources.VCPUs = 1
	p.Resources.DiskBytes = 2 << 30
	profile := installedComputerProfile()
	profile.ProfileID = p.ProfileID
	profile.RuntimeImage = image
	for _, name := range []string{"windows.iso", "virtio.iso"} {
		if e = os.WriteFile(filepath.Join(stage, "media", name), make([]byte, 8192), 0644); e != nil {
			t.Fatal(e)
		}
	}
	asset := func(dir, name string) string {
		raw, e := os.ReadFile(filepath.Join(stage, dir, name))
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(raw)
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	profile.FirmwareCodeDigest = asset("firmware", "CODE.fd")
	profile.FirmwareVarsDigest = asset("firmware", "VARS.fd")
	profile.MediaDigest = asset("media", "windows.iso")
	profile.DriverDigest = asset("media", "virtio.iso")
	engine, e := NewEngineRuntime("/var/run/docker.sock")
	if e != nil {
		t.Fatal(e)
	}
	storage, e := newComputerStorage(p.NodeID, p.PoolID, filepath.Join(mount, "volumes"), computerPoolAdapter{pool}, engine)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	sampler, e := telemetry.NewPhoneBaselineSampler("/proc", p.NodeID, 1)
	if e != nil {
		t.Fatal(e)
	}
	go sampler.Run(ctx)
	control := filepath.Join(stage, "control")
	if e = os.Mkdir(control, 0700); e != nil {
		t.Fatal(e)
	}
	i, e := os.Stat("/dev/kvm")
	if e != nil {
		t.Fatal(e)
	}
	gid := i.Sys().(*syscall.Stat_t).Gid
	policy := ComputerResourcePolicy{ControlRoot: control, Profiles: []InstalledComputerProfile{{ComputerRuntimeProfile: profile, FirmwareDirectory: filepath.Join(stage, "firmware"), MediaDirectory: filepath.Join(stage, "media")}}, CPUGroups: [][]int{{10}}, KVMGroup: gid, ProvisionMemoryBytes: 512 << 20}
	r, e := NewInstalledComputerResources(policy, storage, sampler)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	provisionName := "teamaibox-computer-prepare-" + p.OperationID
	defer func() {
		if id, e := command(nil, "docker", "inspect", "--format", "{{.Id}}", provisionName); e == nil && phoneExactContainerID.MatchString(id) {
			ownedContainers = append(ownedContainers, id)
		}
	}()
	if e = r.PrepareComputerData(ctx, p); e != nil {
		t.Fatal("prepare", e)
	}
	guest := filepath.Join(storage.dataRoot, p.VolumeID, "guest")
	before, e := os.Stat(filepath.Join(guest, "system.qcow2"))
	if e != nil {
		t.Fatal(e)
	}
	if e = r.PrepareComputerData(ctx, p); e != nil {
		t.Fatal("replay", e)
	}
	after, _ := os.Stat(filepath.Join(guest, "system.qcow2"))
	if !os.SameFile(before, after) {
		t.Fatal("replaced fixture disk")
	}
	for {
		samples, e := sampler.PhoneMemorySamples(ctx)
		if e == nil {
			if a, e := agentAssessComputerFixture(samples); e == nil && a {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("memory samples unavailable")
		case <-time.After(time.Second):
		}
	}
	run := computerRunFixture(p, image)
	p = run
	b, e := r.BindComputerRun(ctx, p)
	if e != nil {
		t.Fatal("bind", e)
	}
	ownedNetworks = append(ownedNetworks, b.NetworkID)
	state, e := engine.startComputerContainer(ctx, p, b)
	if state.ID != "" {
		ownedContainers = append(ownedContainers, state.ID)
	}
	if e != nil {
		t.Fatal("start", e)
	}
	p.Run.ContainerID = &state.ID
	driver, e := NewComputerDriver(engine, r, 100*time.Millisecond, 10*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	for {
		result, e := driver.RecheckComputer(ctx, "start", p)
		if e == nil && result.Running {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("runtime not ready", e)
		case <-time.After(100 * time.Millisecond):
		}
	}
	baseline, e := driver.ComputerBaseline(ctx)
	if e != nil {
		t.Fatal("running capacity baseline", e)
	}
	var capacity struct {
		PoolID               string `json:"poolId"`
		Encryption           string `json:"encryption"`
		FreeStorageBytes     int64  `json:"freeStorageBytes"`
		StorageOverheadBytes int64  `json:"storageOverheadBytes"`
		InstalledProfiles    []struct {
			ID           string `json:"id"`
			RuntimeImage string `json:"runtimeImage"`
			MediaDigest  string `json:"mediaDigest"`
		} `json:"installedProfiles"`
		Volumes []phonepool.VolumeUsage `json:"volumes"`
		Workers []struct {
			WorkerID string `json:"workerId"`
		} `json:"workers"`
	}
	if json.Unmarshal(baseline, &capacity) != nil || capacity.PoolID != p.PoolID || capacity.Encryption != "luks2" || capacity.FreeStorageBytes <= 0 || capacity.StorageOverheadBytes != int64(c.ComputerOverheadBytes) || len(capacity.Volumes) != 1 || capacity.Volumes[0].VolumeID != p.VolumeID || capacity.Volumes[0].UsedBytes == 0 || len(capacity.Workers) != 1 || capacity.Workers[0].WorkerID != p.Run.ID {
		t.Fatal("running baseline does not match actual fixture")
	}
	if len(capacity.InstalledProfiles) != 1 || capacity.InstalledProfiles[0].ID != p.ProfileID || capacity.InstalledProfiles[0].RuntimeImage != p.RuntimeImage || capacity.InstalledProfiles[0].MediaDigest != r.policy.Profiles[0].MediaDigest {
		t.Fatal("installed profile facts do not match runtime policy")
	}
	console, e := driver.OpenComputerDesktop(ctx, p, "console")
	if e != nil {
		t.Fatal("private installation console", e)
	}
	console.SetReadDeadline(time.Now().Add(5 * time.Second))
	header := make([]byte, 12)
	_, e = io.ReadFull(console, header)
	console.Close()
	if e != nil || string(header) != "RFB 003.008\n" {
		t.Fatal("installation console did not return VNC greeting", e)
	}
	if conn, e := driver.OpenComputerDesktop(ctx, p, "shell"); e == nil {
		conn.Close()
		t.Fatal("arbitrary desktop port allowed")
	}
	fmt.Println("COMPUTER_LIFECYCLE_PRIVATE_CONSOLE_PASSED")
	if e = r.RequestComputerShutdown(ctx, p); e != nil {
		t.Fatal(e)
	}
	// Verify the non-root runtime can read the request. The fixture has only
	// firmware, not Windows; terminate that fixture QEMU and require UNCLEAN reporting.
	if _, e = command(nil, "docker", "exec", state.ID, "python3", "-c", "import json; d=json.load(open('/control/shutdown.json')); assert d['runId']"); e != nil {
		t.Fatal("shutdown permissions", e)
	}
	if _, e = command(nil, "docker", "exec", state.ID, "python3", "-c", "import pathlib,os,signal; matches=[int(p.name) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and (p/'comm').read_text().strip()=='qemu-system-aar']; assert len(matches)==1; os.kill(matches[0],signal.SIGTERM)"); e != nil {
		t.Fatal(e)
	}
	for {
		result, e := driver.RecheckComputer(ctx, "inspect", p)
		if e == nil && result.Stopped {
			if result.CleanShutdown {
				t.Fatal("firmware quit falsely counted as guest shutdown")
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("fixture exit unavailable", e)
		case <-time.After(100 * time.Millisecond):
		}
	}
	if _, e = engine.startComputerContainer(ctx, p, b); e == nil {
		t.Fatal("revived old exited run")
	}
	r.Close()
	r, e = NewInstalledComputerResources(policy, storage, sampler)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if _, e = r.ResolveComputerRun(ctx, p); e != nil {
		t.Fatal("agent restart binding", e)
	}
	after, _ = os.Stat(filepath.Join(guest, "system.qcow2"))
	if !os.SameFile(before, after) {
		t.Fatal("disk inode changed")
	}
	deletedRunID := p.Run.ID
	p.Run = nil
	p.Allocation = nil
	if e = r.DeleteComputerData(ctx, p); e != nil {
		t.Fatal("delete", e)
	}
	if e = r.VerifyComputerDeleted(ctx, p); e != nil {
		t.Fatal("deleted recheck", e)
	}
	baseline, e = r.ComputerBaseline(ctx)
	capacity.Volumes, capacity.Workers = nil, nil
	if e != nil || json.Unmarshal(baseline, &capacity) != nil || len(capacity.Volumes) != 0 || len(capacity.Workers) != 0 {
		t.Fatal("deleted fixture still charged in baseline", e)
	}
	if _, e = os.Stat(filepath.Join(policy.ControlRoot, "runs", deletedRunID)); !os.IsNotExist(e) {
		t.Fatal("deleted fixture run binding remains", e)
	}
	fmt.Println("COMPUTER_LIFECYCLE_LIVE_CAPACITY_PASSED")
	fmt.Println("COMPUTER_LIFECYCLE_PROVISION_KVM_REPLAY_REOPEN_DELETE_PASSED")
}

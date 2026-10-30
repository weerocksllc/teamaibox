package docker

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func installedComputerProfile() ComputerRuntimeProfile {
	return ComputerRuntimeProfile{ProfileID: "windows-11-arm64-pro", RuntimeImage: "sha256:" + strings.Repeat("a", 64),
		FirmwareCodeDigest: "sha256:" + strings.Repeat("b", 64), FirmwareVarsDigest: "sha256:" + strings.Repeat("c", 64),
		MediaDigest: "sha256:" + strings.Repeat("d", 64), DriverDigest: "sha256:" + strings.Repeat("e", 64), TPMRequired: true, TPMPpi: true, ShutdownSeconds: 120}
}

func TestComputerRuntimeConfigMatchesActualPythonRuntime(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python runtime validator unavailable locally")
	}
	p, _, _ := computerFixture(t)
	profile := installedComputerProfile()
	p.ProfileID = profile.ProfileID
	p.RuntimeImage = profile.RuntimeImage
	p.Run.RuntimeImage = p.RuntimeImage
	for _, provision := range []bool{false, true} {
		if provision {
			p.Run = nil
			p.Generation = 0
		}
		c, e := buildComputerRuntimeConfig(p, profile)
		if e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(c)
		runtime, err := filepath.Abs("../../../../deploy/windows-computer/runtime.py")
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(python, "-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('runtime',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.validate_config(json.load(sys.stdin))", runtime)
		cmd.Stdin = bytes.NewReader(raw)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Go/Python contract mismatch: %s %v", output, err)
		}
	}
}

func TestComputerRuntimeConfigRetryPreservesAndRejectsRebinding(t *testing.T) {
	p, _, _ := computerFixture(t)
	profile := installedComputerProfile()
	p.ProfileID = profile.ProfileID
	p.RuntimeImage = profile.RuntimeImage
	p.Run.RuntimeImage = p.RuntimeImage
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = WriteComputerRuntimeConfig(dir, p, profile); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(filepath.Join(dir, "config.json"))
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	// New operation identity after reconnect is not a new computer/run config.
	p.OperationID = "80000000-0000-4000-8000-000000000001"
	if err = WriteComputerRuntimeConfig(dir, p, profile); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(filepath.Join(dir, "config.json"))
	if !os.SameFile(before, after) {
		t.Fatal("rewrote existing config")
	}
	p.Resources.DiskBytes *= 2
	if err = WriteComputerRuntimeConfig(dir, p, profile); err == nil {
		t.Fatal("rebound run to another disk size")
	}
	retained, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if !bytes.Equal(raw, retained) {
		t.Fatal("modified original config")
	}
}

func TestComputerRuntimeConfigRejectsBadProfileOrRun(t *testing.T) {
	for _, fault := range []string{"image", "media", "tpm", "generation", "alignment", "profile"} {
		t.Run(fault, func(t *testing.T) {
			p, _, _ := computerFixture(t)
			profile := installedComputerProfile()
			p.ProfileID = profile.ProfileID
			p.RuntimeImage = profile.RuntimeImage
			p.Run.RuntimeImage = p.RuntimeImage
			switch fault {
			case "image":
				profile.RuntimeImage = "sha256:" + strings.Repeat("f", 64)
			case "media":
				profile.MediaDigest = "unversioned.iso"
			case "tpm":
				p.TPMID = nil
			case "generation":
				p.Run.Generation++
			case "alignment":
				p.Resources.MemoryBytes++
			case "profile":
				p.ProfileID = "not a profile"
				profile.ProfileID = p.ProfileID
			}
			if _, err := buildComputerRuntimeConfig(p, profile); err == nil {
				t.Fatal("accepted invalid config")
			}
		})
	}
}

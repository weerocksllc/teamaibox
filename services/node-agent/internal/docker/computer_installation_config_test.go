package docker

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestComputerInstallationConfigEmptyMediaMatchesPython(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range []string{"windows", "linux"} {
		t.Run(family, func(t *testing.T) {
			p, _, _ := computerFixture(t)
			profile := installedComputerProfile()
			profile.SchemaVersion = 2
			profile.OSFamily = family
			profile.Architecture = "aarch64"
			profile.MediaDigest = ""
			profile.DriverDigest = ""
			p.ProfileID = profile.ProfileID
			p.RuntimeImage = profile.RuntimeImage
			p.Run.RuntimeImage = p.RuntimeImage
			c, e := buildComputerRuntimeConfig(p, profile)
			if e != nil {
				t.Fatal(e)
			}
			if c.MediaDigest != nil || c.DriverDigest != nil || c.SchemaVersion != 2 {
				t.Fatal("empty media not represented as null")
			}
			raw, _ := json.Marshal(c)
			runtime, _ := filepath.Abs("../../../../deploy/windows-computer/runtime.py")
			cmd := exec.Command(python, "-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('runtime',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.validate_config(json.load(sys.stdin))", runtime)
			cmd.Stdin = bytes.NewReader(raw)
			if output, e := cmd.CombinedOutput(); e != nil {
				t.Fatalf("new Go/Python config mismatch: %s %v", output, e)
			}
			profile.MediaDigest = installedComputerProfile().MediaDigest
			if _, e := buildComputerRuntimeConfig(p, profile); e == nil {
				t.Fatal("new hardware profile selected a fixed user ISO")
			}
		})
	}
}

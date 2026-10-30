package docker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"

	"teamaibox.local/node-agent/internal/agent"
)

// Installed profile facts, not arbitrary fields supplied by the member. These
// produce exactly the container runtime's closed configuration grammar.
type ComputerRuntimeProfile struct {
	SchemaVersion                                                     int
	OSFamily, Architecture                                            string
	ProfileID, RuntimeImage                                           string
	FirmwareCodeDigest, FirmwareVarsDigest, MediaDigest, DriverDigest string
	TPMRequired, TPMPpi                                               bool
	ShutdownSeconds                                                   int
}

type computerRuntimeConfig struct {
	SchemaVersion      int                     `json:"schemaVersion"`
	OSFamily           string                  `json:"osFamily,omitempty"`
	Architecture       string                  `json:"architecture,omitempty"`
	ComputerID         string                  `json:"computerId"`
	OwnerID            string                  `json:"ownerId"`
	NodeID             string                  `json:"nodeId"`
	VolumeID           string                  `json:"volumeId"`
	FirmwareID         string                  `json:"firmwareId"`
	TPMID              *string                 `json:"tpmId"`
	RunID              *string                 `json:"runId"`
	Generation         uint64                  `json:"generation"`
	ProfileID          string                  `json:"profileId"`
	RuntimeImage       string                  `json:"runtimeImage"`
	Resources          agent.ComputerResources `json:"resources"`
	FirmwareCodeDigest string                  `json:"firmwareCodeDigest"`
	FirmwareVarsDigest string                  `json:"firmwareVarsDigest"`
	MediaDigest        *string                 `json:"mediaDigest"`
	DriverDigest       *string                 `json:"driverDigest"`
	TPMPpi             bool                    `json:"tpmPpi"`
	ShutdownSeconds    int                     `json:"shutdownSeconds"`
}

var computerRuntimeProfileID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

func buildComputerRuntimeConfig(p agent.ComputerCommand, profile ComputerRuntimeProfile) (computerRuntimeConfig, error) {
	var c computerRuntimeConfig
	fail := errors.New("computer_runtime_configuration_invalid")
	version := profile.SchemaVersion
	if version == 0 {
		version = 1
	}
	if version != 1 && version != 2 || version == 1 && (profile.OSFamily != "" || profile.Architecture != "") ||
		version == 2 && (profile.OSFamily != "windows" && profile.OSFamily != "linux" || profile.Architecture != "aarch64") {
		return c, fail
	}
	for _, id := range []string{p.ComputerID, p.OwnerID, p.NodeID, p.VolumeID, p.FirmwareID, p.OperationID} {
		if !managedWorkerID.MatchString(id) {
			return c, fail
		}
	}
	for _, digest := range []string{profile.RuntimeImage, profile.FirmwareCodeDigest, profile.FirmwareVarsDigest} {
		if !digestID.MatchString(digest) {
			return c, fail
		}
	}
	for _, digest := range []string{profile.MediaDigest, profile.DriverDigest} {
		if !(version == 2 && digest == "") && !digestID.MatchString(digest) {
			return c, fail
		}
	}
	// Installed hardware profiles no longer select a user's installation disc.
	if version == 2 && profile.MediaDigest != "" {
		return c, fail
	}
	if !computerRuntimeProfileID.MatchString(p.ProfileID) || p.ProfileID != profile.ProfileID || p.RuntimeImage != profile.RuntimeImage || profile.ShutdownSeconds <= 0 ||
		(profile.TPMRequired || profile.TPMPpi) && p.TPMID == nil || p.TPMID != nil && !managedWorkerID.MatchString(*p.TPMID) ||
		p.Generation >= 1<<53-1 || (p.Run == nil) != (p.Generation == 0) {
		return c, fail
	}
	for _, value := range []int64{p.Resources.VCPUs, p.Resources.MemoryBytes, p.Resources.DiskBytes} {
		if value <= 0 || value >= 1<<53 {
			return c, fail
		}
	}
	if p.Resources.MemoryBytes%(1<<20) != 0 || p.Resources.DiskBytes%512 != 0 {
		return c, fail
	}
	var run *string
	if p.Run != nil {
		if !managedWorkerID.MatchString(p.Run.ID) || p.Run.Generation != p.Generation || p.Run.RuntimeImage != p.RuntimeImage {
			return c, fail
		}
		id := p.Run.ID
		run = &id
	}
	var media, driver *string
	if profile.MediaDigest != "" {
		value := profile.MediaDigest
		media = &value
	}
	if profile.DriverDigest != "" {
		value := profile.DriverDigest
		driver = &value
	}
	c = computerRuntimeConfig{SchemaVersion: version, OSFamily: profile.OSFamily, Architecture: profile.Architecture,
		ComputerID: p.ComputerID, OwnerID: p.OwnerID, NodeID: p.NodeID,
		VolumeID: p.VolumeID, FirmwareID: p.FirmwareID, TPMID: p.TPMID, RunID: run, Generation: p.Generation,
		ProfileID: p.ProfileID, RuntimeImage: p.RuntimeImage, Resources: p.Resources, FirmwareCodeDigest: profile.FirmwareCodeDigest,
		FirmwareVarsDigest: profile.FirmwareVarsDigest, MediaDigest: media, DriverDigest: driver,
		TPMPpi: profile.TPMPpi, ShutdownSeconds: profile.ShutdownSeconds}
	return c, nil
}

// directory is one installed Agent-owned config directory per provisioning/run,
// mounted read-only into that runtime. It is never the writable guest directory.
func WriteComputerRuntimeConfig(directory string, p agent.ComputerCommand, profile ComputerRuntimeProfile) error {
	c, err := buildComputerRuntimeConfig(p, profile)
	if err != nil {
		return err
	}
	if !phonePrivateRoot(directory) {
		return errors.New("computer_configuration_path_invalid")
	}
	for path := directory; path != "/"; path = filepath.Dir(path) {
		info, e := os.Lstat(path)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return errors.New("computer_configuration_path_invalid")
		}
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	if _, err = root.Lstat("config.json"); err == nil {
		raw, e := phoneReadFile(root, "config.json", 16384)
		var old computerRuntimeConfig
		if e != nil || phoneDecodeFile(raw, &old) != nil || !reflect.DeepEqual(c, old) {
			return errors.New("computer_configuration_identity_mismatch")
		}
		return nil // Never rewrite even identical config on reconnect.
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return phoneWriteFile(root, "config.json", raw)
}

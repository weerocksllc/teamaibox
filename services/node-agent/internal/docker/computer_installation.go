package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"teamaibox.local/node-agent/internal/agent"
)

type installationLaunchRequest struct {
	ComputerID    string  `json:"computerId"`
	OwnerID       string  `json:"ownerId"`
	VolumeID      string  `json:"volumeId"`
	RunID         string  `json:"runId"`
	Generation    uint64  `json:"generation"`
	Revision      uint64  `json:"revision"`
	Digest        *string `json:"digest"`
	BootRequestID *string `json:"bootRequestId"`
}

// The shared strict resource reader deliberately hides ENOENT. These new
// optional journals must distinguish first creation from a corrupt existing
// record without changing that reader's behavior for established resources.
func readOptionalInstallationFile(root *os.Root, path string, limit int64) ([]byte, error) {
	if _, err := root.Lstat(path); err != nil {
		return nil, err
	}
	return phoneReadFile(root, path, limit)
}

func (r *InstalledComputerResources) writeInstallationLaunch(p agent.ComputerCommand, profile InstalledComputerProfile, base string) error {
	if (profile.SchemaVersion != 2 && !profile.ManagedMedia) || p.Run == nil {
		if p.Installation != nil {
			return errors.New("computer_installation_request_invalid")
		}
		return nil
	}
	if p.Installation == nil && profile.SchemaVersion != 2 {
		return nil
	}
	if p.Installation == nil || p.Installation.Action != "launch" {
		return errors.New("computer_installation_request_missing")
	}
	request := installationLaunchRequest{p.ComputerID, p.OwnerID, p.VolumeID, p.Run.ID, p.Generation, p.Installation.Revision, p.Installation.Digest, p.Installation.BootRequestID}
	path := base + "/config/installation-request.json"
	raw, err := readOptionalInstallationFile(r.root, path, 4096)
	if err == nil {
		var old installationLaunchRequest
		if phoneDecodeFile(raw, &old) != nil || !reflect.DeepEqual(old, request) {
			return errors.New("computer_installation_request_mismatch")
		}
	} else if !os.IsNotExist(err) {
		return err
	} else {
		raw, _ = json.Marshal(request)
		if err = phoneWriteFile(r.root, path, raw); err != nil {
			return err
		}
	}
	return r.root.Chmod(path, 0444)
}

func (r *InstalledComputerResources) ReadComputerBootStatus(ctx context.Context, p agent.ComputerCommand) (string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	saved, err := r.readRun(p)
	if err != nil {
		return "", "", err
	}
	i := saved.Command.Installation
	if i == nil || i.BootRequestID == nil {
		return "", "", nil
	}
	raw, err := phoneReadFile(r.root, "runs/"+p.Run.ID+"/control/installation-boot.json", 4096)
	if err != nil {
		return "", "", err
	}
	var record struct {
		ComputerID string `json:"computerId"`
		OwnerID    string `json:"ownerId"`
		VolumeID   string `json:"volumeId"`
		RunID      string `json:"runId"`
		Generation uint64 `json:"generation"`
		Revision   uint64 `json:"revision"`
		RequestID  string `json:"requestId"`
		State      string `json:"state"`
	}
	if phoneDecodeFile(raw, &record) != nil || record.ComputerID != p.ComputerID || record.OwnerID != p.OwnerID || record.VolumeID != p.VolumeID ||
		record.RunID != p.Run.ID || record.Generation != p.Generation || record.Revision != i.Revision || record.RequestID != *i.BootRequestID ||
		(record.State != "armed" && record.State != "consumed") {
		return "", "", errors.New("computer_installation_boot_unconfirmed")
	}
	return record.RequestID, record.State, nil
}

type installationRecord struct {
	Command agent.ComputerCommand `json:"command"`
	Result  *agent.ComputerResult `json:"result,omitempty"`
}

func (d *ComputerDriver) ApplyComputerInstallation(ctx context.Context, p agent.ComputerCommand, input io.Reader) (agent.ComputerResult, error) {
	resources, ok := d.resources.(*InstalledComputerResources)
	if !ok {
		return agent.ComputerResult{}, errors.New("computer_installation_unavailable")
	}
	return resources.applyInstallation(ctx, p, input)
}

func (r *InstalledComputerResources) applyInstallation(ctx context.Context, p agent.ComputerCommand, input io.Reader) (agent.ComputerResult, error) {
	r.installationLifetime.RLock()
	defer r.installationLifetime.RUnlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	result := computerResult(p)
	result.InstallationRevision = p.Installation.Revision
	if p.Run != nil {
		result.ContainerID = *p.Run.ContainerID
	}
	q := p
	q.Installation = nil
	profile, err := r.profile(q)
	if err != nil {
		// An installed runtime update must not strand media operations on an
		// existing stopped computer or an older running instance. Validate its
		// recorded recipe exactly, as shutdown/recovery already do. No new
		// runtime is launched here, and immutable storage fields still match.
		if q.Run == nil {
			profile, err = r.recordedProfile(q, "prepare/"+q.ComputerID, true)
			q.RuntimeImage = profile.RuntimeImage
		} else {
			profile, err = r.recordedProfile(q, "runs/"+q.Run.ID, false)
		}
	}
	if err != nil {
		return result, err
	}
	if profile.SchemaVersion != 2 && !profile.ManagedMedia {
		return result, errors.New("computer_installation_upgrade_required")
	}
	verify := q
	if verify.Run == nil {
		verify.Generation = 0
	}
	if err = r.verifyData(ctx, verify, profile); err != nil {
		return result, err
	}
	var binding ComputerContainerBinding
	if p.Run != nil {
		saved, e := r.readRun(q)
		if e != nil {
			return result, e
		}
		binding = saved.Binding
		state, exists, e := r.engine.inspectComputerContainer(ctx, q, binding)
		if e != nil || !exists || !state.State.Running || state.ID != *p.Run.ContainerID {
			return result, errors.New("computer_runtime_unavailable")
		}
	}
	if err = r.directory("installation", 0700); err != nil {
		return result, err
	}
	path := "installation/" + p.ComputerID + ".json"
	record := installationRecord{Command: p}
	firstAttempt := true
	raw, err := readOptionalInstallationFile(r.root, path, 32768)
	if err == nil {
		var previous installationRecord
		if phoneDecodeFile(raw, &previous) != nil || previous.Command.Installation == nil {
			return result, errors.New("computer_installation_journal_invalid")
		}
		old := previous.Command.Installation
		if old.Revision > p.Installation.Revision {
			return result, errors.New("computer_state_conflict")
		}
		if old.Revision == p.Installation.Revision {
			firstAttempt = false
			if !reflect.DeepEqual(previous.Command, p) {
				return result, errors.New("computer_operation_conflict")
			}
			if previous.Result != nil {
				return *previous.Result, nil
			}
		}
	} else if !os.IsNotExist(err) {
		return result, err
	}
	write := func() error {
		raw, e := json.Marshal(record)
		if e != nil {
			return e
		}
		return phoneWriteFile(r.root, path, raw)
	}
	if err = write(); err != nil {
		return result, err
	}
	if p.Installation.Action == "mount" {
		// The coordinator fences mutations for this computer. Release the shared
		// resource lock during streaming so status/console and other guests work.
		r.mu.Unlock()
		err = r.storage.StageInstallationMedia(ctx, q, *p.Installation.Digest, p.Installation.Size, input)
		r.mu.Lock()
		if err != nil {
			// A fresh staging refusal occurs before any QMP mutation. Persist it
			// as a definite failure so the member can free space and retry a new
			// operation. A replay may have lost an earlier QMP reply: never turn
			// that uncertainty into a no-side-effects claim.
			if firstAttempt && err.Error() == "computer_media_capacity_unavailable" {
				result.Rejected, result.NoSideEffects = true, true
				result.ErrorCode = "computer_capacity_unavailable"
				record.Result = &result
				if e := write(); e != nil {
					return result, e
				}
				return result, nil
			}
			return result, err
		}
	} else {
		var extra [1]byte
		if n, e := input.Read(extra[:]); n != 0 || e != io.EOF {
			return result, errors.New("computer_media_input_invalid")
		}
	}
	if p.Run != nil {
		state, exists, e := r.engine.inspectComputerContainer(ctx, q, binding)
		if e != nil || !exists || !state.State.Running || state.ID != *p.Run.ContainerID {
			return result, errors.New("computer_runtime_unavailable")
		}
		request := map[string]any{"computerId": p.ComputerID, "ownerId": p.OwnerID, "runId": p.Run.ID, "generation": p.Generation, "digest": p.Installation.Digest}
		raw, _ = json.Marshal(request)
		var output bytes.Buffer
		if err = r.engine.execPhoneInput(ctx, *p.Run.ContainerID, "computer-optical", bytes.NewReader(raw), &output); err != nil {
			return result, err
		}
		var reply struct {
			ComputerID string `json:"computerId"`
			OwnerID    string `json:"ownerId"`
			RunID      string `json:"runId"`
			Generation uint64 `json:"generation"`
			ErrorCode  string `json:"errorCode"`
			Optical    *struct {
				Digest   *string `json:"digest"`
				Locked   bool    `json:"locked"`
				TrayOpen bool    `json:"trayOpen"`
			} `json:"optical"`
		}
		if phoneDecodeFile(output.Bytes(), &reply) != nil {
			return result, errors.New("computer_media_result_invalid")
		}
		if reply.ErrorCode == "computer_optical_locked" && reply.Optical == nil {
			result.Rejected = true
			result.NoSideEffects = true
			result.ErrorCode = reply.ErrorCode
		} else if reply.ErrorCode != "" || reply.ComputerID != p.ComputerID || reply.OwnerID != p.OwnerID || reply.RunID != p.Run.ID || reply.Generation != p.Generation ||
			reply.Optical == nil || !reflect.DeepEqual(reply.Optical.Digest, p.Installation.Digest) || p.Installation.Digest != nil && reply.Optical.TrayOpen {
			return result, errors.New("computer_media_result_invalid")
		}
	}
	if !result.Rejected {
		result.MediaReady = true
		result.MediaDigest = p.Installation.Digest
	}
	record.Result = &result
	if err = write(); err != nil {
		return result, err
	}
	return result, nil
}

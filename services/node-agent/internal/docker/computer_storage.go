package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

// Concrete Windows adapter for the already installed local storage helper.
// The helper verifies LUKS and enforces project quotas; the Agent never infers
// encryption from a pathname or lets a member supply host filesystem paths.
type InstalledComputerStorage struct {
	nodeID, poolID, dataRoot string
	storage                  phoneQuotaClient
	engine                   *EngineRuntime
	mediaMu                  sync.Mutex
	mediaLocks               map[string]*sync.Mutex
	mediaOwnership           func(*os.File) error
}

type ComputerVolume struct {
	GuestDirectory        string
	QuotaBytes, UsedBytes uint64
	Deleted               bool
}

func NewInstalledComputerStorage(nodeID, poolID, dataRoot, socket string, engine *EngineRuntime) (*InstalledComputerStorage, error) {
	if !phonePrivateRoot(socket) || filepath.Base(socket) != "storage.sock" {
		return nil, errors.New("computer_storage_socket_invalid")
	}
	return newComputerStorage(nodeID, poolID, dataRoot, phonepool.Client{Socket: socket}, engine)
}

func newComputerStorage(nodeID, poolID, dataRoot string, storage phoneQuotaClient, engine *EngineRuntime) (*InstalledComputerStorage, error) {
	if !managedWorkerID.MatchString(nodeID) || poolID == "" || !phonePrivateRoot(dataRoot) || storage == nil || engine == nil {
		return nil, errors.New("computer_storage_not_configured")
	}
	for path := dataRoot; path != "/"; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return nil, errors.New("computer_storage_path_invalid")
		}
	}
	return &InstalledComputerStorage{nodeID: nodeID, poolID: poolID, dataRoot: dataRoot, storage: storage, engine: engine,
		mediaOwnership: func(f *os.File) error { return f.Chown(10001, 10001) }}, nil
}

func (s *InstalledComputerStorage) identity(p agent.ComputerCommand) (phonepool.ComputerVolumeIdentity, error) {
	var i phonepool.ComputerVolumeIdentity
	if p.NodeID != s.nodeID || p.PoolID != s.poolID || p.Resources.DiskBytes <= 0 || p.Resources.DiskBytes >= 1<<53 || p.Resources.DiskBytes%512 != 0 || p.ProfileID == "" {
		return i, errors.New("computer_storage_binding_mismatch")
	}
	for _, id := range []string{p.ComputerID, p.OwnerID, p.VolumeID, p.FirmwareID} {
		if !managedWorkerID.MatchString(id) {
			return i, errors.New("computer_storage_binding_mismatch")
		}
	}
	i = phonepool.ComputerVolumeIdentity{ComputerID: p.ComputerID, OwnerID: p.OwnerID, NodeID: p.NodeID, VolumeID: p.VolumeID,
		FirmwareID: p.FirmwareID, PoolID: p.PoolID, ProfileID: p.ProfileID, DiskBytes: uint64(p.Resources.DiskBytes)}
	if p.TPMID != nil {
		if !managedWorkerID.MatchString(*p.TPMID) {
			return i, errors.New("computer_storage_binding_mismatch")
		}
		i.TPMID = *p.TPMID
	}
	return i, nil
}

func (s *InstalledComputerStorage) call(ctx context.Context, p agent.ComputerCommand, action string) (ComputerVolume, error) {
	var empty ComputerVolume
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	i, err := s.identity(p)
	if err != nil {
		return empty, err
	}
	r, err := s.storage.Handle(ctx, phonepool.Request{Action: "computer-" + action, Computer: &i})
	if err != nil {
		return empty, err
	}
	if r.Media || r.Computer == nil || *r.Computer != i || r.Pool != nil || r.ComputerPool != nil || r.Identity != (agent.PhoneIdentity{}) || r.ProjectID < 100000 || r.QuotaBytes <= i.DiskBytes || r.QuotaBytes >= 1<<53 || r.QuotaBytes%1024 != 0 || action != "inspect" && r.Deleted != (action == "delete") {
		return empty, errors.New("computer_storage_reply_invalid")
	}
	return ComputerVolume{GuestDirectory: filepath.Join(s.dataRoot, i.VolumeID, "guest"), QuotaBytes: r.QuotaBytes, UsedBytes: r.UsedBytes, Deleted: r.Deleted}, nil
}

func (s *InstalledComputerStorage) Prepare(ctx context.Context, p agent.ComputerCommand) (ComputerVolume, error) {
	return s.call(ctx, p, "prepare")
}
func (s *InstalledComputerStorage) Inspect(ctx context.Context, p agent.ComputerCommand) (ComputerVolume, error) {
	v, err := s.call(ctx, p, "inspect")
	if err == nil && v.Deleted {
		return ComputerVolume{}, errors.New("computer_storage_deleted")
	}
	return v, err
}
func (s *InstalledComputerStorage) VerifyDeleted(ctx context.Context, p agent.ComputerCommand) error {
	v, err := s.call(ctx, p, "inspect")
	if err != nil {
		return err
	}
	if !v.Deleted {
		return errors.New("computer_storage_not_deleted")
	}
	return nil
}

func (s *InstalledComputerStorage) Delete(ctx context.Context, p agent.ComputerCommand) (ComputerVolume, error) {
	var empty ComputerVolume
	if _, err := s.identity(p); err != nil {
		return empty, err
	}
	// Any uncertain Docker observation leaves storage allocated. A lost Agent
	// reply must not turn an existing running Windows into a supposedly free disk.
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.volume-id=" + p.VolumeID}})
	var containers []struct {
		ID string `json:"Id"`
	}
	if err := s.engine.request(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), nil, &containers, http.StatusOK); err != nil {
		return empty, err
	}
	for _, container := range containers {
		if !phoneExactContainerID.MatchString(container.ID) {
			return empty, errors.New("computer_container_identity_mismatch")
		}
		var state phoneEngineState
		if err := s.engine.request(ctx, http.MethodGet, "/containers/"+container.ID+"/json", nil, &state, http.StatusOK); err != nil {
			return empty, err
		}
		labels, ok := state.Config["Labels"].(map[string]any)
		if !ok || state.ID != container.ID || labels["com.teamaibox.kind"] != "windows-computer" ||
			labels["com.teamaibox.computer-id"] != p.ComputerID || labels["com.teamaibox.owner-identity-id"] != p.OwnerID ||
			labels["com.teamaibox.node-id"] != p.NodeID || labels["com.teamaibox.volume-id"] != p.VolumeID ||
			labels["com.teamaibox.pool-id"] != p.PoolID {
			return empty, errors.New("computer_container_identity_mismatch")
		}
		if state.State.Running || state.State.Status != "exited" && state.State.Status != "created" {
			return empty, errors.New("computer_storage_in_use")
		}
	}
	// The helper additionally holds the guest runtime file lock through removal.
	return s.call(ctx, p, "delete")
}

package docker

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"time"
)

// The host publishes this only after its exact forwarding rules have committed.
// Read on every connection, never cache a DHCP address in the Agent process.
func appliedPhoneMediaAddress(p PhoneContainerPolicy, container phoneEngineState, runID, address string, first int) (string, error) {
	bad := errors.New("phone_media_preparing")
	info, err := os.Lstat(p.HostMediaStateFile)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 1<<20 {
		return "", bad
	}
	raw, err := os.ReadFile(p.HostMediaStateFile)
	var state struct {
		Version   int    `json:"version"`
		NodeID    string `json:"nodeId"`
		PoolID    string `json:"poolId"`
		Status    string `json:"status"`
		UpdatedAt int64  `json:"updatedAt"`
		Runs      map[string]struct {
			ContainerID      string `json:"containerId"`
			StartedAt        string `json:"startedAt"`
			ContainerAddress string `json:"containerAddress"`
			Address          string `json:"address"`
			FirstPort        int    `json:"firstPort"`
			LastPort         int    `json:"lastPort"`
		} `json:"runs"`
	}
	if err != nil || json.Unmarshal(raw, &state) != nil || state.Version != 1 || state.NodeID != p.NodeID || state.PoolID != p.PoolID || state.UpdatedAt > time.Now().Unix()+5 || time.Now().Unix()-state.UpdatedAt > 60 {
		return "", bad
	}
	if state.Status == "waiting_for_network" {
		return "", errors.New("phone_media_network_unavailable")
	}
	run, ok := state.Runs[runID]
	ip := net.ParseIP(run.Address)
	if state.Status != "ready" || !ok || run.ContainerID != container.ID || run.StartedAt != container.State.StartedAt || run.ContainerAddress != address || run.FirstPort != first || run.LastPort != first+49 || ip == nil || ip.To4() == nil || !ip.IsPrivate() || ip.String() != run.Address {
		return "", bad
	}
	return run.Address, nil
}

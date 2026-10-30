package docker

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"teamaibox.local/node-agent/internal/agent"
	"time"
)

// A small, networkless one-shot runtime prepares only the selected encrypted
// volume. It has no KVM/GPU device and cannot boot Windows or contact the LAN.
func (r *EngineRuntime) provisionComputer(ctx context.Context, p agent.ComputerCommand, b ComputerContainerBinding) error {
	spec, err := buildComputerProvisionContainer(p, b)
	if err != nil {
		return err
	}
	name := "teamaibox-computer-prepare-" + p.OperationID
	inspect := func() (phoneEngineState, bool, error) {
		var s phoneEngineState
		err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &s, http.StatusOK)
		var status *engineStatusError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return s, false, nil
		}
		if err != nil {
			return s, false, err
		}
		if !exactComputerSpec(s, spec) || len(s.NetworkSettings.Networks) != 1 {
			return s, true, errors.New("computer_provision_identity_mismatch")
		}
		if _, ok := s.NetworkSettings.Networks["none"]; !ok {
			return s, true, errors.New("computer_provision_identity_mismatch")
		}
		return s, true, nil
	}
	s, exists, err := inspect()
	if err != nil {
		return err
	}
	if !exists {
		var image struct {
			ID           string `json:"Id"`
			Architecture string `json:"Architecture"`
		}
		if err = r.request(ctx, http.MethodGet, "/images/"+url.PathEscape(p.RuntimeImage)+"/json", nil, &image, http.StatusOK); err != nil {
			return err
		}
		if image.ID != p.RuntimeImage || image.Architecture != "arm64" {
			return errors.New("computer_image_identity_mismatch")
		}
		var created struct {
			ID string `json:"Id"`
		}
		if err = r.request(ctx, http.MethodPost, "/containers/create?name="+name, spec, &created, http.StatusCreated); err != nil {
			return err
		}
		s, exists, err = inspect()
		if err != nil {
			return err
		}
		if !exists || s.ID != created.ID {
			return errors.New("computer_provision_identity_mismatch")
		}
	}
	if s.State.Status == "created" {
		if err = r.request(ctx, http.MethodPost, "/containers/"+s.ID+"/start", nil, nil, http.StatusNoContent); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		s, exists, err = inspect()
		if err != nil {
			return err
		}
		if !exists {
			return errors.New("computer_provision_missing")
		}
		if s.State.Status == "exited" && !s.State.Running {
			if s.State.ExitCode != 0 || s.State.OOMKilled {
				return errors.New("computer_provision_failed")
			}
			return nil
		}
		if s.State.Status != "running" || !s.State.Running {
			return errors.New("computer_provision_unavailable")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

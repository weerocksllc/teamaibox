package docker

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

type phoneQuotaClient interface {
	Handle(context.Context, phonepool.Request) (phonepool.Result, error)
}

// Resource allocation is part of the existing Node Agent, not an additional
// orchestrator. The only privileged storage operation goes through the narrow
// local quota socket. Until the separate egress qualification is installed,
// networks are deliberately internal-only; this is not a guest-internet claim.
type InstalledPhoneResources struct {
	mu            sync.Mutex
	policy        PhoneContainerPolicy
	engine        *EngineRuntime
	storage       phoneQuotaClient
	control, data *os.Root
}

type phoneRunFiles struct {
	Version   int                       `json:"version"`
	Request   agent.PhoneCommandPayload `json:"request"`
	Instance  int                       `json:"instance"`
	NetworkID string                    `json:"networkId"`
	Released  bool                      `json:"released"`
}

var _ PhoneResources = (*InstalledPhoneResources)(nil)

func NewInstalledPhoneResources(engine *EngineRuntime, policy PhoneContainerPolicy, socket string) (*InstalledPhoneResources, error) {
	if !phonePrivateRoot(socket) || filepath.Base(socket) != "storage.sock" {
		return nil, errors.New("phone_storage_socket_invalid")
	}
	return newPhoneResources(engine, policy, phonepool.Client{Socket: socket})
}

func newPhoneResources(engine *EngineRuntime, policy PhoneContainerPolicy, storage phoneQuotaClient) (*InstalledPhoneResources, error) {
	if engine == nil || storage == nil || !phonePrivateRoot(policy.DataRoot) || !phonePrivateRoot(policy.ControlRoot) || !validPhoneNetworkPolicy(policy) || !agent.ValidInstalledPhoneImages(policy.ImageID, policy.AdditionalImageDigests, policy.RetiredImageDigests) {
		return nil, errors.New("phone_resources_not_configured")
	}
	for _, path := range []string{policy.ControlRoot, policy.DataRoot} {
		for current := path; current != "/"; current = filepath.Dir(current) {
			info, err := os.Lstat(current)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
				return nil, errors.New("phone_resources_path_invalid")
			}
		}
	}
	control, err := os.OpenRoot(policy.ControlRoot)
	if err != nil {
		return nil, err
	}
	data, err := os.OpenRoot(policy.DataRoot)
	if err != nil {
		control.Close()
		return nil, err
	}
	return &InstalledPhoneResources{policy: policy, engine: engine, storage: storage, control: control, data: data}, nil
}

func (r *InstalledPhoneResources) Close() { r.control.Close(); r.data.Close() }

func phoneReadFile(root *os.Root, path string, limit int64) ([]byte, error) {
	parts := strings.Split(path, string(filepath.Separator))
	for i := range parts {
		info, err := root.Lstat(filepath.Join(parts[:i+1]...))
		if err != nil || info.Mode()&os.ModeSymlink != 0 || (i < len(parts)-1 && !info.IsDir()) ||
			(i == len(parts)-1 && (!info.Mode().IsRegular() || info.Size() > limit)) {
			return nil, errors.New("phone_resource_file_invalid")
		}
	}
	f, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, errors.New("phone_resource_file_invalid")
	}
	return raw, nil
}

func phoneDecodeFile(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) {
		return errors.New("phone_resource_file_invalid")
	}
	return nil
}

func phoneSyncDir(root *os.Root, path string) error {
	f, err := root.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func phoneWriteFile(root *os.Root, path string, raw []byte) error {
	// A deterministic pending filename is confined to the Agent-owned control
	// directory. A guest never mounts it or the binding record.
	pending := path + ".pending"
	if info, err := root.Lstat(pending); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("phone_resource_file_invalid")
		}
		if err = root.Remove(pending); err != nil {
			return err
		}
	}
	f, err := root.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	f.Close()
	if err != nil {
		return err
	}
	if err = root.Rename(pending, path); err != nil {
		return err
	}
	return phoneSyncDir(root, filepath.Dir(path))
}

func (r *InstalledPhoneResources) quota(ctx context.Context, p agent.PhoneCommandPayload, action string) error {
	if p.PoolID != r.policy.PoolID {
		return errors.New("phone_storage_binding_mismatch")
	}
	got, err := r.storage.Handle(ctx, phonepool.Request{Action: action, Identity: p.PhoneIdentity})
	if err != nil {
		return err
	}
	if got.Identity != p.PhoneIdentity || got.QuotaBytes != uint64(agent.PhoneStorageBytes) || got.Deleted != (action == "delete") {
		return errors.New("phone_storage_binding_mismatch")
	}
	return nil
}

func (r *InstalledPhoneResources) PrepareData(ctx context.Context, p agent.PhoneCommandPayload) error {
	if p.Run != nil || p.Generation != 0 {
		return errors.New("phone_storage_binding_mismatch")
	}
	return r.quota(ctx, p, "prepare")
}

func (r *InstalledPhoneResources) readRun(id string) (phoneRunFiles, error) {
	var b phoneRunFiles
	if !managedWorkerID.MatchString(id) {
		return b, errors.New("phone_resource_identity_invalid")
	}
	raw, err := phoneReadFile(r.control, filepath.Join(id, "binding.json"), 8192)
	if err != nil {
		return b, err
	}
	if phoneDecodeFile(raw, &b) != nil || b.Version != 1 || b.Request.Run == nil || b.Request.Run.ID != id ||
		!validPhoneInstance(b.Instance) || b.Request.PoolID != r.policy.PoolID {
		return b, errors.New("phone_resource_identity_invalid")
	}
	network := b.NetworkID
	if network == "" {
		network = strings.Repeat("0", 64)
	}
	policy := r.policy.forInstance(b.Instance)
	if !agent.PhoneImageAllowed(policy.ImageID, policy.AdditionalImageDigests, b.Request.Run.ImageDigest) {
		if !b.Released {
			return b, errors.New("phone_stop_unconfirmed")
		}
		policy, err = policy.forRetiredImage(b.Request.Run.ImageDigest)
		if err != nil {
			return b, err
		}
	}
	if _, err = buildPhoneContainer(policy, b.Request, network); err != nil {
		return b, err
	}
	return b, nil
}

func samePhoneBinding(p agent.PhoneCommandPayload, b phoneRunFiles) bool {
	return p.PhoneIdentity == b.Request.PhoneIdentity && p.Generation == b.Request.Generation && reflect.DeepEqual(p.Run, b.Request.Run)
}

func (r *InstalledPhoneResources) writeRun(b phoneRunFiles) error {
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return phoneWriteFile(r.control, filepath.Join(b.Request.Run.ID, "binding.json"), raw)
}

func (r *InstalledPhoneResources) runIDs() ([]string, error) {
	dir, err := r.control.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	ids := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || !managedWorkerID.MatchString(entry.Name()) {
			return nil, errors.New("phone_resource_file_invalid")
		}
		ids = append(ids, entry.Name())
	}
	return ids, nil
}

func (r *InstalledPhoneResources) BindRun(ctx context.Context, p agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var empty PhoneResourceBinding
	if _, err := buildPhoneContainer(r.policy.forInstance(21), p, strings.Repeat("0", 64)); err != nil {
		return empty, err
	}
	if err := r.quota(ctx, p, "inspect"); err != nil {
		return empty, err
	}
	var b phoneRunFiles
	if _, err := r.control.Lstat(p.Run.ID); err == nil {
		b, err = r.readRun(p.Run.ID)
		if err != nil {
			return empty, err
		}
		if !samePhoneBinding(p, b) || b.Released {
			return empty, errors.New("phone_stale_run")
		}
	} else if !os.IsNotExist(err) {
		return empty, err
	} else {
		ids, err := r.runIDs()
		if err != nil {
			return empty, err
		}
		used := map[int]bool{}
		for _, id := range ids {
			old, e := r.readRun(id)
			if e != nil {
				return empty, e
			}
			if !old.Released {
				used[old.Instance] = true
			} else if e = r.reclaimReleasedNetwork(ctx, old); e != nil {
				if ctx.Err() != nil {
					return empty, ctx.Err()
				}
				used[old.Instance] = true
			}
			// Historical recipes can differ from the installed runtime. If an
			// old stopped resource cannot be proved exact, leave it untouched;
			// it must not prevent an unrelated new phone using free capacity.
			if old.Request.PhoneID == p.PhoneID && (!old.Released || old.Request.Generation >= p.Generation) {
				return empty, errors.New("phone_stale_run")
			}
		}
		instance := 21
		for validPhoneInstance(instance) && used[instance] {
			instance++
		}
		if !validPhoneInstance(instance) || r.policy.InstanceLimitByImage[p.Run.ImageDigest] != 0 && instance > r.policy.InstanceLimitByImage[p.Run.ImageDigest] {
			return empty, errors.New("phone_capacity_unavailable")
		}
		b = phoneRunFiles{Version: 1, Request: p, Instance: instance}
		if err = r.control.Mkdir(p.Run.ID, 0700); err != nil {
			return empty, err
		}
		if err = r.writeRun(b); err != nil {
			return empty, err
		}
		if err = phoneSyncDir(r.control, "."); err != nil {
			return empty, err
		}
	}
	if err := r.prepareRunFiles(b); err != nil {
		return empty, err
	}
	if b.NetworkID == "" {
		network, err := r.ensureNetwork(ctx, b)
		if err != nil {
			return empty, err
		}
		b.NetworkID = network
		if err = r.writeRun(b); err != nil {
			return empty, err
		}
	}
	network, err := r.inspectNetwork(ctx, b)
	if err != nil {
		return empty, err
	}
	result := bindingResult(b)
	result.NodeGeneration, _ = strconv.ParseInt(network.Labels["com.teamaibox.node-generation"], 10, 64)
	return result, nil
}

func (r *InstalledPhoneResources) resolveReleasedRun(ctx context.Context, b phoneRunFiles) (PhoneResourceBinding, error) {
	var state phoneEngineState
	if err := r.engine.request(ctx, http.MethodGet, "/containers/"+phoneContainerName(b.Request)+"/json", nil, &state, http.StatusOK); err != nil {
		return PhoneResourceBinding{}, err
	}
	labels, _ := state.Config["Labels"].(map[string]any)
	generationText, _ := labels["com.teamaibox.node-generation"].(string)
	generation, err := strconv.ParseInt(generationText, 10, 64)
	policy, policyErr := r.policy.forRetiredImage(b.Request.Run.ImageDigest)
	policy.NodeGeneration = generation
	if err != nil || policyErr != nil || generation < 1 || generation > r.policy.NodeGeneration ||
		!exactPhoneContainer(state, policy.forInstance(b.Instance), b.Request, b.NetworkID) ||
		state.State.Running || state.State.Status != "exited" && state.State.Status != "created" {
		return PhoneResourceBinding{}, errors.New("phone_stop_unconfirmed")
	}
	result := bindingResult(b)
	result.NodeGeneration, result.RetiredNodeGeneration = generation, generation
	return result, nil
}

func bindingResult(b phoneRunFiles) PhoneResourceBinding {
	return PhoneResourceBinding{Identity: b.Request.PhoneIdentity, RunID: b.Request.Run.ID, Generation: b.Request.Generation, NetworkID: b.NetworkID, QuotaBytes: agent.PhoneStorageBytes, Instance: b.Instance}
}

func (r *InstalledPhoneResources) ResolveRun(ctx context.Context, p agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	return r.resolveRun(ctx, p, false)
}

// Read-only resolution for deletion only; released records cannot be revived.
func (r *InstalledPhoneResources) ResolveRetiredRun(ctx context.Context, p agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	return r.resolveRun(ctx, p, true)
}

func (r *InstalledPhoneResources) resolveRun(ctx context.Context, p agent.PhoneCommandPayload, retired bool) (PhoneResourceBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var empty PhoneResourceBinding
	if p.Run == nil || !retired && !agent.PhoneImageAllowed(r.policy.ImageID, r.policy.AdditionalImageDigests, p.Run.ImageDigest) {
		return empty, errors.New("phone_stale_run")
	}
	b, err := r.readRun(p.Run.ID)
	if err != nil {
		return empty, err
	}
	if !samePhoneBinding(p, b) || b.NetworkID == "" || retired && !b.Released {
		return empty, errors.New("phone_stale_run")
	}
	if err = r.quota(ctx, p, "inspect"); err != nil {
		return empty, err
	}
	network, err := r.inspectNetwork(ctx, b)
	if err != nil {
		if b.Released && phoneEngineNotFound(err) {
			// A completed run keeps its stopped container and disk for exact
			// shutdown retries, but no longer consumes a Docker address pool.
			return r.resolveReleasedRun(ctx, b)
		}
		return empty, err
	}
	result := bindingResult(b)
	result.NodeGeneration, _ = strconv.ParseInt(network.Labels["com.teamaibox.node-generation"], 10, 64)
	if retired {
		result.RetiredNodeGeneration, _ = strconv.ParseInt(network.Labels["com.teamaibox.node-generation"], 10, 64)
	}
	return result, nil
}

func (r *InstalledPhoneResources) ReleaseRun(ctx context.Context, p agent.PhoneCommandPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.Run == nil {
		return errors.New("phone_stale_run")
	}
	b, err := r.readRun(p.Run.ID)
	if err != nil {
		return err
	}
	if !samePhoneBinding(p, b) || b.NetworkID == "" {
		return errors.New("phone_stale_run")
	}
	network, err := r.inspectNetwork(ctx, b)
	if err != nil {
		if b.Released && phoneEngineNotFound(err) {
			_, err = r.resolveReleasedRun(ctx, b)
			return err
		}
		return err
	}
	policy := r.policy.forInstance(b.Instance)
	policy.NodeGeneration, _ = strconv.ParseInt(network.Labels["com.teamaibox.node-generation"], 10, 64)
	state, exists, err := r.engine.inspectPhoneContainer(ctx, policy, p, b.NetworkID)
	if err != nil {
		return err
	}
	if exists && (state.State.Running || state.State.Status != "exited" && state.State.Status != "created") {
		return errors.New("phone_stop_unconfirmed")
	}
	if !b.Released {
		b.Released = true
		if err = r.writeRun(b); err != nil {
			return err
		}
	}
	return r.reclaimReleasedNetwork(ctx, b)
}

// Also used before new allocation to reclaim networks retained by older Agents.
// Never prune by name/age: verify the stored run, exact network and stopped
// container. Persistent guest files and the terminal container are untouched.
func (r *InstalledPhoneResources) reclaimReleasedNetwork(ctx context.Context, b phoneRunFiles) error {
	if !b.Released {
		return errors.New("phone_stop_unconfirmed")
	}
	network, err := r.inspectNetwork(ctx, b)
	if phoneEngineNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	policy, err := r.policy.forRetiredImage(b.Request.Run.ImageDigest)
	if err != nil {
		return err
	}
	policy.NodeGeneration, _ = strconv.ParseInt(network.Labels["com.teamaibox.node-generation"], 10, 64)
	state, exists, err := r.engine.inspectPhoneContainer(ctx, policy.forInstance(b.Instance), b.Request, network.ID)
	if err != nil {
		return err
	}
	if len(network.Containers) != 0 || exists && (state.State.Running || state.State.Status != "exited" && state.State.Status != "created") {
		return errors.New("phone_stop_unconfirmed")
	}
	return r.engine.request(ctx, http.MethodDelete, "/networks/"+network.ID, nil, nil, http.StatusNoContent, http.StatusNotFound)
}

// Cancel only an exact run whose Docker container provably does not exist.
// This recovers failures before create (including a lost network-create reply)
// without allocating data/certificates or leaving an occupied instance slot.
// The coordinator owns the persistent command fence and serializes start/stop.
func (r *InstalledPhoneResources) CancelUnstartedRun(ctx context.Context, p agent.PhoneCommandPayload) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := buildPhoneContainer(r.policy.forInstance(21), p, strings.Repeat("0", 64)); err != nil {
		return false, err
	}
	var actual phoneEngineState
	err := r.engine.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(phoneContainerName(p))+"/json", nil, &actual, http.StatusOK)
	if err == nil {
		return false, nil
	} // The normal stop path verifies and stops it.
	if !phoneEngineNotFound(err) {
		return false, err
	}
	if _, err = r.control.Lstat(p.Run.ID); os.IsNotExist(err) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	b, err := r.readRun(p.Run.ID)
	if err != nil {
		return false, err
	}
	if !samePhoneBinding(p, b) {
		return false, errors.New("phone_stale_run")
	}
	network, err := r.inspectNetwork(ctx, b)
	if err != nil && !phoneEngineNotFound(err) {
		return false, err
	}
	if err == nil {
		if len(network.Containers) != 0 {
			return false, errors.New("phone_stop_unconfirmed")
		}
		b.NetworkID = network.ID // Recover the exact network from a lost reply.
	}
	b.Released = true
	if err = r.writeRun(b); err != nil {
		return false, err
	}
	if network.ID != "" {
		if err = r.engine.request(ctx, http.MethodDelete, "/networks/"+network.ID, nil, nil, http.StatusNoContent, http.StatusNotFound); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (r *InstalledPhoneResources) ReadStatus(_ context.Context, p agent.PhoneCommandPayload) (PhoneRuntimeStatus, error) {
	var result PhoneRuntimeStatus
	if !managedWorkerID.MatchString(p.VolumeID) {
		return result, errors.New("phone_resource_identity_invalid")
	}
	raw, err := phoneReadFile(r.data, filepath.Join(p.VolumeID, "phone", ".phone-status.json"), 8192)
	if err != nil {
		return result, err
	}
	if phoneDecodeFile(raw, &result) != nil || !result.matches(p) {
		return result, errors.New("phone_runtime_status_unavailable")
	}
	return result, nil
}

func (r *InstalledPhoneResources) DeleteData(ctx context.Context, p agent.PhoneCommandPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.Run != nil || !managedWorkerID.MatchString(p.PhoneID) {
		return errors.New("phone_stale_run")
	}
	ids, err := r.runIDs()
	if err != nil {
		return err
	}
	owned := []phoneRunFiles{}
	for _, id := range ids {
		b, e := r.readRun(id)
		if e != nil {
			return e
		}
		if b.Request.PhoneID != p.PhoneID && b.Request.VolumeID != p.VolumeID {
			continue
		}
		if b.Request.PhoneIdentity != p.PhoneIdentity || !b.Released || b.Request.Generation > p.Generation {
			return errors.New("phone_stop_unconfirmed")
		}
		if b.NetworkID != "" {
			network, e := r.inspectNetwork(ctx, b)
			if e != nil && !phoneEngineNotFound(e) {
				return e
			}
			if len(network.Containers) != 0 {
				return errors.New("phone_stop_unconfirmed")
			}
		}
		owned = append(owned, b)
	}
	if err = r.quota(ctx, p, "delete"); err != nil {
		return err
	}
	for _, b := range owned {
		if b.NetworkID != "" {
			if err = r.engine.request(ctx, http.MethodDelete, "/networks/"+b.NetworkID, nil, nil, http.StatusNoContent, http.StatusNotFound); err != nil {
				return err
			}
		}
		if err = r.control.RemoveAll(b.Request.Run.ID); err != nil {
			return err
		}
	}
	return phoneSyncDir(r.control, ".")
}

func phoneEngineNotFound(err error) bool {
	var status *engineStatusError
	return errors.As(err, &status) && status.status == http.StatusNotFound
}

func (r *InstalledPhoneResources) prepareRunFiles(b phoneRunFiles) error {
	dir := b.Request.Run.ID
	config := map[string]any{"version": 1, "phoneId": b.Request.PhoneID, "ownerId": b.Request.OwnerID, "volumeId": b.Request.VolumeID,
		"runId": dir, "generation": b.Request.Generation, "buildId": b.Request.BaseBuildID, "instance": b.Instance}
	raw, _ := json.Marshal(config)
	if _, err := r.control.Lstat(dir + "/config.json"); err == nil {
		actual, e := phoneReadFile(r.control, dir+"/config.json", 8192)
		if e != nil || !bytes.Equal(actual, raw) {
			return errors.New("phone_resource_identity_invalid")
		}
	} else if !os.IsNotExist(err) {
		return err
	} else if err = phoneWriteFile(r.control, dir+"/config.json", raw); err != nil {
		return err
	}
	certDir := dir + "/certs"
	if err := r.control.Mkdir(certDir, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	if _, err := r.control.Lstat(certDir + "/server.crt"); err == nil {
		cert, e := phoneReadFile(r.control, certDir+"/server.crt", 8192)
		if e != nil {
			return e
		}
		key, e := phoneReadFile(r.control, certDir+"/server.key", 8192)
		if e != nil {
			return e
		}
		pair, e := tls.X509KeyPair(cert, key)
		if e != nil {
			return errors.New("phone_signal_certificate_invalid")
		}
		leaf, e := x509.ParseCertificate(pair.Certificate[0])
		if e != nil || leaf.Subject.CommonName != "phone-"+dir || leaf.VerifyHostname("127.0.0.1") != nil || time.Now().After(leaf.NotAfter) {
			return errors.New("phone_signal_certificate_invalid")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	// This per-run self-signed certificate is pinned inside Node Agent; it is
	// never installed into host/browser trust. Cuttlefish's loopback client
	// recognizes a self-signed issuer only with a valid certificate-signing
	// usage (otherwise OpenSSL reports "unable to get local issuer"). Keep the
	// standard self-signed shape used by the qualified runtime; do not relax
	// Node Agent's exact certificate and hostname verification.
	// User/media authorization is independently limited to five seconds.
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "phone-" + dir},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(365 * 24 * time.Hour),
		BasicConstraintsValid: true, IsCA: true, MaxPathLen: 0, MaxPathLenZero: true,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err = phoneWriteFile(r.control, certDir+"/server.key", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})); err != nil {
		return err
	}
	return phoneWriteFile(r.control, certDir+"/server.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

type phoneNetworkState struct {
	ID         string                     `json:"Id"`
	Name       string                     `json:"Name"`
	Driver     string                     `json:"Driver"`
	Scope      string                     `json:"Scope"`
	Internal   bool                       `json:"Internal"`
	EnableIPv6 bool                       `json:"EnableIPv6"`
	Labels     map[string]string          `json:"Labels"`
	Options    map[string]string          `json:"Options"`
	Containers map[string]json.RawMessage `json:"Containers"`
}

func phoneNetworkName(b phoneRunFiles) string { return "teamaibox-phone-" + b.Request.Run.ID }
func phoneNetworkOptions() map[string]string {
	return map[string]string{"com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"}
}
func (r *InstalledPhoneResources) inspectNetwork(ctx context.Context, b phoneRunFiles) (phoneNetworkState, error) {
	var state phoneNetworkState
	id := b.NetworkID
	if id == "" {
		id = phoneNetworkName(b)
	}
	err := r.engine.request(ctx, http.MethodGet, "/networks/"+url.PathEscape(id), nil, &state, http.StatusOK)
	if err != nil {
		return state, err
	}
	policy := r.policy
	// Existing bindings name a protected exact network and immutable run. Its
	// creation generation is not the generation of today's control connection.
	// Never discover/adopt an old network by name for an unbound start.
	generation, e := strconv.ParseInt(state.Labels["com.teamaibox.node-generation"], 10, 64)
	if e != nil || generation < 1 || generation > policy.NodeGeneration ||
		b.NetworkID == "" && generation != policy.NodeGeneration {
		return state, errors.New("phone_network_identity_mismatch")
	}
	policy.NodeGeneration = generation
	if b.Released {
		// A closed run's protected network and binding retain their original
		// authority after an authenticated Agent generation changes. This is
		// validation for cleanup; retired images can never be started.
		policy, e = policy.forRetiredImage(b.Request.Run.ImageDigest)
		if e != nil {
			return state, e
		}
		policy.NodeGeneration = generation
	}
	if !phoneExactContainerID.MatchString(state.ID) || (b.NetworkID != "" && state.ID != b.NetworkID) || state.Name != phoneNetworkName(b) ||
		state.Driver != "bridge" || state.Scope != "local" || state.Internal != (r.policy.NetworkProfile == "") || state.EnableIPv6 ||
		!reflect.DeepEqual(state.Labels, phoneContainerLabels(policy, b.Request)) || !reflect.DeepEqual(state.Options, phoneNetworkOptions()) || len(state.Containers) > 1 {
		return state, errors.New("phone_network_identity_mismatch")
	}
	for id := range state.Containers {
		container, exists, e := r.engine.inspectPhoneContainer(ctx, policy.forInstance(b.Instance), b.Request, state.ID)
		if e != nil || !exists || id != container.ID || b.Released && (container.State.Running || container.State.Status != "exited" && container.State.Status != "created") {
			return state, errors.New("phone_network_identity_mismatch")
		}
	}
	return state, nil
}
func (r *InstalledPhoneResources) ensureNetwork(ctx context.Context, b phoneRunFiles) (string, error) {
	state, err := r.inspectNetwork(ctx, b)
	if err == nil {
		return state.ID, nil
	}
	var status *engineStatusError
	if !errors.As(err, &status) || status.status != http.StatusNotFound {
		return "", err
	}
	request := map[string]any{"Name": phoneNetworkName(b), "Driver": "bridge", "Internal": r.policy.NetworkProfile == "", "EnableIPv6": false,
		"CheckDuplicate": true, "Labels": phoneContainerLabels(r.policy, b.Request), "Options": phoneNetworkOptions()}
	var result struct {
		ID string `json:"Id"`
	}
	if err = r.engine.request(ctx, http.MethodPost, "/networks/create", request, &result, http.StatusCreated); err != nil {
		return "", err
	}
	if !phoneExactContainerID.MatchString(result.ID) {
		return "", errors.New("phone_network_identity_mismatch")
	}
	b.NetworkID = result.ID
	state, err = r.inspectNetwork(ctx, b)
	return state.ID, err
}

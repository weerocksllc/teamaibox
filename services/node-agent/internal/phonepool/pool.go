// Package phonepool is the narrow privileged part of guest storage. It has no
// Docker, network, disk-format or member-selected command capability. An
// installed elastic pool may grow its already unlocked mapping online.
package phonepool

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"teamaibox.local/node-agent/internal/agent"
)

var uuidID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var poolID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,127}$`)

// Retained wire field for compatibility; no advance storage margin.
const marginBytes uint64 = 0

type Config struct {
	PoolID         string `json:"poolId"`
	Root           string `json:"root"`
	LUKSUUID       string `json:"luksUUID"`
	FilesystemUUID string `json:"filesystemUUID"`
	ClientUID      uint32 `json:"clientUid"`
	// Zero keeps Windows allocation disabled on existing installations. This is
	// filesystem/TPM/firmware overhead in addition to the selected guest disk.
	ComputerOverheadBytes uint64 `json:"computerOverheadBytes,omitempty"`
	// Optional installed file-backed pool. Its address space follows the backing
	// filesystem; admission still checks physical free space and commitments.
	ElasticBackingFile string `json:"elasticBackingFile,omitempty"`
	ElasticKeyFile     string `json:"elasticKeyFile,omitempty"`
}
type Request struct {
	Action     string                  `json:"action"`
	Identity   agent.PhoneIdentity     `json:"identity"`
	Computer   *ComputerVolumeIdentity `json:"computer,omitempty"`
	MediaBytes uint64                  `json:"mediaBytes,omitempty"`
}
type Result struct {
	Identity     agent.PhoneIdentity      `json:"identity"`
	ProjectID    uint32                   `json:"projectId"`
	QuotaBytes   uint64                   `json:"quotaBytes"`
	UsedBytes    uint64                   `json:"usedBytes"`
	Deleted      bool                     `json:"deleted"`
	Pool         *Observation             `json:"pool,omitempty"`
	Computer     *ComputerVolumeIdentity  `json:"computer,omitempty"`
	ComputerPool *ComputerPoolObservation `json:"computerPool,omitempty"`
	Media        bool                     `json:"media,omitempty"`
}
type record struct {
	Identity  agent.PhoneIdentity `json:"identity"`
	ProjectID uint32              `json:"projectId"`
	Phase     string              `json:"phase"`
}
type journal struct {
	Version       int                            `json:"version"`
	PoolID        string                         `json:"poolId"`
	NextProject   uint32                         `json:"nextProject"`
	Volumes       map[string]record              `json:"volumes"`
	Computers     map[string]computerRecord      `json:"computers,omitempty"`
	ComputerMedia map[string]computerMediaRecord `json:"computerMedia,omitempty"`
}

// The non-Linux source tests use an explicit kernel fixture. Production always
// instantiates the Linux implementation; there is no configuration fallback.
type kernel interface {
	verify(Config) (uint64, error)
	project(*os.File, uint32, bool) error
	quota(*os.File, uint32, bool, bool) (uint64, error)
	ownership(*os.Root, string, uint32, os.FileMode) error
	lock(*os.File) error
}
type Pool struct {
	mu     sync.Mutex
	config Config
	root   *os.Root
	kernel kernel
	lock   *os.File
}

func validIdentity(p agent.PhoneIdentity, c Config) bool {
	return uuidID.MatchString(p.PhoneID) && uuidID.MatchString(p.OwnerID) && uuidID.MatchString(p.VolumeID) && p.PoolID == c.PoolID && p.BaseBuildID == agent.PhoneBaseBuild
}
func privatePath(path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return false
	}
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if current == "/" {
			return true
		}
	}
}
func newPool(c Config, k kernel) (*Pool, error) {
	if !poolID.MatchString(c.PoolID) || !uuidID.MatchString(c.LUKSUUID) || !uuidID.MatchString(c.FilesystemUUID) || c.ClientUID != 10001 || !privatePath(c.Root) || k == nil {
		return nil, errors.New("phone_pool_configuration_invalid")
	}
	if _, err := k.verify(c); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(c.Root)
	if err != nil {
		return nil, err
	}
	p := &Pool{config: c, root: root, kernel: k}
	for _, name := range []string{"volumes", "control", "storage-state"} {
		if err = p.directory(name); err != nil {
			p.Close()
			return nil, err
		}
	}
	// Volumes' binding metadata remains outside the runtime's /phone mount.
	if err = k.ownership(root, "volumes", c.ClientUID, 0750); err == nil {
		err = k.ownership(root, "control", c.ClientUID, 0700)
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	if info, e := root.Lstat("storage-state/pool.lock"); e == nil && !info.Mode().IsRegular() {
		p.Close()
		return nil, errors.New("phone_pool_lock_invalid")
	}
	p.lock, err = root.OpenFile("storage-state/pool.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err == nil {
		err = k.lock(p.lock)
	}
	if err == nil {
		_, err = p.read()
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}
func (p *Pool) Close() {
	if p.lock != nil {
		p.lock.Close()
	}
	if p.root != nil {
		p.root.Close()
	}
}
func (p *Pool) directory(name string) error {
	err := p.root.Mkdir(name, 0700)
	if err != nil && !os.IsExist(err) {
		return err
	}
	info, err := p.root.Lstat(name)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("phone_pool_path_invalid")
	}
	return nil
}
func decode(raw []byte, v any) error {
	return decodeReader(bytes.NewReader(raw), v)
}
func decodeReader(source io.Reader, v any) error {
	d := json.NewDecoder(source)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return errors.New("phone_pool_record_invalid")
	}
	if !errors.Is(d.Decode(&struct{}{}), io.EOF) {
		return errors.New("phone_pool_record_invalid")
	}
	return nil
}
func (p *Pool) read() (journal, error) {
	j := journal{Version: 1, PoolID: p.config.PoolID, NextProject: 100000, Volumes: map[string]record{}}
	info, err := p.root.Lstat("storage-state/allocations.json")
	if os.IsNotExist(err) {
		return j, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return j, errors.New("phone_pool_record_invalid")
	}
	f, err := p.root.Open("storage-state/allocations.json")
	if err != nil {
		return j, err
	}
	defer f.Close()
	if decodeReader(f, &j) != nil || j.Version != 1 || j.PoolID != p.config.PoolID || j.NextProject < 100000 || j.Volumes == nil {
		return j, errors.New("phone_pool_record_invalid")
	}
	projects, phones := map[uint32]bool{}, map[string]bool{}
	for id, r := range j.Volumes {
		if id != r.Identity.VolumeID || !validIdentity(r.Identity, p.config) || r.ProjectID < 100000 || r.ProjectID >= j.NextProject || projects[r.ProjectID] || phones[r.Identity.PhoneID] || (r.Phase != "preparing" && r.Phase != "ready" && r.Phase != "deleting" && r.Phase != "deleted") {
			return j, errors.New("phone_pool_record_invalid")
		}
		projects[r.ProjectID] = true
		phones[r.Identity.PhoneID] = true
	}
	if err := p.validateComputers(j, projects); err != nil {
		return j, err
	}
	if err := p.validateComputerMedia(j, projects); err != nil {
		return j, err
	}
	return j, nil
}
func (p *Pool) write(j journal) error {
	// No guest can access storage-state. Replace only our own pending record.
	name := "storage-state/allocations.pending"
	if info, e := p.root.Lstat(name); e == nil {
		if !info.Mode().IsRegular() {
			return errors.New("phone_pool_record_invalid")
		}
		if e = p.root.Remove(name); e != nil {
			return e
		}
	}
	f, err := p.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = json.NewEncoder(f).Encode(j); err == nil {
		err = f.Sync()
	}
	f.Close()
	if err != nil {
		return err
	}
	if err = p.root.Rename(name, "storage-state/allocations.json"); err != nil {
		return err
	}
	dir, err := p.root.Open("storage-state")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (p *Pool) Handle(q Request) (Result, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var result Result
	if q.Action == "computer-media-prepare" || q.Action == "computer-media-inspect" || q.Action == "computer-media-delete" {
		return p.handleComputerMedia(q)
	}
	if q.MediaBytes != 0 {
		return result, errors.New("computer_media_request_invalid")
	}
	if q.Action == "computer-pool-status" {
		if q.Computer != nil || q.Identity != (agent.PhoneIdentity{PoolID: p.config.PoolID}) {
			return result, errors.New("computer_storage_request_invalid")
		}
		value, err := p.observeComputers()
		if err != nil {
			return result, err
		}
		return Result{ComputerPool: &value}, nil
	}
	if q.Computer != nil || len(q.Action) >= 9 && q.Action[:9] == "computer-" {
		return p.handleComputer(q)
	}
	if q.Action == "pool-status" {
		if q.Identity != (agent.PhoneIdentity{PoolID: p.config.PoolID}) {
			return result, errors.New("phone_pool_request_invalid")
		}
		value, err := p.observe()
		if err != nil {
			return result, err
		}
		return Result{Pool: &value}, nil
	}
	if !validIdentity(q.Identity, p.config) || (q.Action != "prepare" && q.Action != "inspect" && q.Action != "delete") {
		return result, errors.New("phone_pool_request_invalid")
	}
	available, err := p.kernel.verify(p.config)
	if err != nil {
		return result, err
	}
	j, err := p.read()
	if err != nil {
		return result, err
	}
	r, exists := j.Volumes[q.Identity.VolumeID]
	if _, collision := j.Computers[q.Identity.VolumeID]; collision {
		return result, errors.New("phone_storage_binding_mismatch")
	}
	if exists && r.Identity != q.Identity {
		return result, errors.New("phone_storage_binding_mismatch")
	}
	for _, other := range j.Volumes {
		if other.Identity.PhoneID == q.Identity.PhoneID && other.Identity.VolumeID != q.Identity.VolumeID {
			return result, errors.New("phone_storage_binding_mismatch")
		}
	}
	if !exists && q.Action != "prepare" {
		return result, errors.New("phone_storage_binding_missing")
	}
	mount, err := p.root.Open(".")
	if err != nil {
		return result, err
	}
	defer mount.Close()
	base := filepath.Join("volumes", q.Identity.VolumeID)
	if q.Action == "prepare" {
		if exists && r.Phase != "preparing" && r.Phase != "ready" {
			return result, errors.New("phone_storage_deleted")
		}
		if !exists {
			// Project IDs are a kernel uint32 namespace, not a product phone limit.
			if j.NextProject == math.MaxUint32 {
				return result, errors.New("phone_storage_project_ids_exhausted")
			}
			if available == 0 {
				return result, errors.New("phone_storage_capacity_unavailable")
			}
			if _, e := p.root.Lstat(base); !os.IsNotExist(e) {
				return result, errors.New("phone_storage_unowned_data")
			}
			r = record{Identity: q.Identity, ProjectID: j.NextProject, Phase: "preparing"}
			j.NextProject++
			j.Volumes[q.Identity.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
		if r.Phase == "preparing" {
			if err = p.directory(base); err != nil {
				return result, err
			}
			directory, e := p.root.Open(base)
			if e != nil {
				return result, e
			}
			err = p.kernel.project(directory, r.ProjectID, true)
			directory.Close()
			if err != nil {
				return result, err
			}
			if _, err = p.kernel.quota(mount, r.ProjectID, true, false); err != nil {
				return result, err
			}
			if err = p.directory(base + "/phone"); err != nil {
				return result, err
			}
			if err = p.kernel.ownership(p.root, base, p.config.ClientUID, 0750); err != nil {
				return result, err
			}
			if err = p.kernel.ownership(p.root, base+"/phone", p.config.ClientUID, 0700); err != nil {
				return result, err
			}
			r.Phase = "ready"
			j.Volumes[q.Identity.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
	}
	result = Result{Identity: r.Identity, ProjectID: r.ProjectID, QuotaBytes: uint64(agent.PhoneStorageBytes), Deleted: r.Phase == "deleted"}
	if q.Action == "delete" {
		if r.Phase == "deleted" {
			return result, nil
		}
		r.Phase = "deleting"
		j.Volumes[q.Identity.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		// Caller is the authenticated Agent, which has already confirmed all exact
		// phone containers stopped. Root prevents path/symlink escape during removal.
		// The volume's quota includes every descendant and is released only afterward.
		if info, e := p.root.Lstat(base); e == nil {
			if !info.IsDir() {
				return result, errors.New("phone_pool_path_invalid")
			}
			if err = p.root.RemoveAll(base); err != nil {
				return result, err
			}
		} else if !os.IsNotExist(e) {
			return result, e
		}
		if _, err = p.kernel.quota(mount, r.ProjectID, false, true); err != nil {
			return result, err
		}
		r.Phase = "deleted"
		j.Volumes[q.Identity.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		result.Deleted = true
		return result, nil
	}
	if r.Phase != "ready" {
		return result, errors.New("phone_storage_not_ready")
	}
	for _, name := range []string{base, base + "/phone"} {
		info, e := p.root.Lstat(name)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return result, errors.New("phone_pool_path_invalid")
		}
		f, e := p.root.Open(name)
		if e != nil {
			return result, e
		}
		err = p.kernel.project(f, r.ProjectID, false)
		f.Close()
		if err != nil {
			return result, err
		}
	}
	result.UsedBytes, err = p.kernel.quota(mount, r.ProjectID, false, false)
	return result, err
}

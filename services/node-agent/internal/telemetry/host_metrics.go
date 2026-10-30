package telemetry

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const metricMaximumResponseBytes = 8 << 20

var metricUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var metricDockerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

type HostMetricConfig struct {
	ProcRoot       string
	SysRoot        string
	StorageAnchor  string
	DockerSocket   string
	ComposeProject string
	// Explicit deployment retirement, not an ignore-errors switch. A retired
	// service that is still running remains visible until it is actually stopped.
	RetiredCoreServices []string
	InventoryFile       string
	SequenceFile        string
	AgentVersion        string
	NodeID              string
	SampleWindow        time.Duration
	NvidiaSMI           string
}

type HostMetricProvider struct {
	config HostMetricConfig
	docker *http.Client
	mu     sync.Mutex
}

func NewHostMetricProvider(config HostMetricConfig) (*HostMetricProvider, error) {
	for _, key := range config.RetiredCoreServices {
		if !validMetricID(key) {
			return nil, errors.New("retired core service key is invalid")
		}
	}
	for name, value := range map[string]string{"proc root": config.ProcRoot, "sys root": config.SysRoot, "storage anchor": config.StorageAnchor, "inventory file": config.InventoryFile, "sequence file": config.SequenceFile} {
		if !filepath.IsAbs(value) {
			return nil, fmt.Errorf("metric %s must be absolute", name)
		}
	}
	if config.AgentVersion == "" || !metricUUID.MatchString(config.NodeID) || config.SampleWindow < 100*time.Millisecond || config.SampleWindow > 2*time.Second {
		return nil, errors.New("host metric collector configuration is invalid")
	}
	if config.NvidiaSMI == "" {
		config.NvidiaSMI = "/usr/bin/nvidia-smi"
	}
	provider := &HostMetricProvider{config: config}
	if config.DockerSocket != "" {
		if !filepath.IsAbs(config.DockerSocket) {
			return nil, errors.New("metric Docker socket must be absolute")
		}
		dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
		provider.docker = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", config.DockerSocket)
		}}, Timeout: 5 * time.Second}
	}
	return provider, nil
}

func number(value float64) *float64 { return &value }
func reason(value string) *string   { return &value }
func boolean(value bool) *bool      { return &value }
func measured(value float64) Metric {
	return Metric{Status: "measured", Value: number(value), ReasonCode: nil}
}
func unsupported(code string) Metric {
	return Metric{Status: "unsupported", Value: nil, ReasonCode: reason(code)}
}
func unavailable(code string) Metric {
	return Metric{Status: "unavailable", Value: nil, ReasonCode: reason(code)}
}

func readBounded(filename string, maximum int64) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maximum {
		return nil, errors.New("metric source is too large")
	}
	return body, nil
}

type cpuCounters struct{ total, idle uint64 }

func parseCPU(body string) (cpuCounters, error) {
	line, _, _ := strings.Cut(body, "\n")
	fields := strings.Fields(line)
	if len(fields) < 8 || fields[0] != "cpu" {
		return cpuCounters{}, errors.New("host CPU counters are invalid")
	}
	values := make([]uint64, len(fields)-1)
	for index, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuCounters{}, errors.New("host CPU counters are invalid")
		}
		values[index] = value
	}
	var total uint64
	for _, value := range values {
		total += value
	}
	return cpuCounters{total: total, idle: values[3] + values[4]}, nil
}

func utilization(before, after cpuCounters) Metric {
	if after.total <= before.total || after.idle < before.idle {
		return unavailable("host_cpu_counter_reset")
	}
	total, idle := after.total-before.total, after.idle-before.idle
	if idle > total {
		return unavailable("host_cpu_counter_invalid")
	}
	return measured(float64(total-idle) * 100 / float64(total))
}

func parseMeminfo(body string) (total, available uint64, err error) {
	values := map[string]uint64{}
	scanner := bufio.NewScanner(strings.NewReader(body))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		if key != "MemTotal" && key != "MemAvailable" {
			continue
		}
		value, parseError := strconv.ParseUint(fields[1], 10, 64)
		if parseError != nil {
			return 0, 0, errors.New("host memory counters are invalid")
		}
		values[key] = value * 1024
	}
	if values["MemTotal"] == 0 || values["MemAvailable"] > values["MemTotal"] {
		return 0, 0, errors.New("host memory counters are invalid")
	}
	return values["MemTotal"], values["MemAvailable"], scanner.Err()
}

func load1(body string) Metric {
	field := strings.Fields(body)
	if len(field) == 0 {
		return unavailable("host_load_unavailable")
	}
	value, err := strconv.ParseFloat(field[0], 64)
	if err != nil || value < 0 {
		return unavailable("host_load_unavailable")
	}
	return measured(value)
}

type ioCounters struct{ readBytes, writeBytes uint64 }

func readDiskCounters(sysRoot string) (ioCounters, error) {
	directories, err := filepath.Glob(filepath.Join(sysRoot, "class/block/*"))
	if err != nil {
		return ioCounters{}, err
	}
	var result ioCounters
	var found bool
	for _, directory := range directories {
		name := filepath.Base(directory)
		if !(strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "sd") || strings.HasPrefix(name, "mmcblk")) {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, "partition")); err == nil {
			continue
		}
		body, err := readBounded(filepath.Join(directory, "stat"), 4096)
		if err != nil {
			continue
		}
		fields := strings.Fields(string(body))
		if len(fields) < 7 {
			continue
		}
		readSectors, readError := strconv.ParseUint(fields[2], 10, 64)
		writeSectors, writeError := strconv.ParseUint(fields[6], 10, 64)
		sectorSize := uint64(512)
		if sectorBody, sectorError := readBounded(filepath.Join(directory, "queue/hw_sector_size"), 64); sectorError == nil {
			if parsed, parseError := strconv.ParseUint(strings.TrimSpace(string(sectorBody)), 10, 64); parseError == nil && parsed > 0 {
				sectorSize = parsed
			}
		}
		if readError == nil && writeError == nil {
			result.readBytes += readSectors * sectorSize
			result.writeBytes += writeSectors * sectorSize
			found = true
		}
	}
	if !found {
		return ioCounters{}, errors.New("host storage IO counters are unavailable")
	}
	return result, nil
}

type networkCounters struct{ receiveBytes, transmitBytes, receiveErrors, transmitErrors, availableBits uint64 }

// routedInterfaces returns physical candidates used for ordinary appliance egress.
// Dedicated ConnectX routes are certified and reported separately as topology facts;
// summing them here would invent capacity for traffic that still uses the default LAN.
func routedInterfaces(body string) map[string]bool {
	result := map[string]bool{}
	lines := strings.Split(body, "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[0] == "lo" || fields[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 64)
		if err != nil || flags&1 == 0 {
			continue
		}
		result[fields[0]] = true
	}
	return result
}

func readNetworkCounters(sysRoot string, routed map[string]bool) (networkCounters, error) {
	directories, err := filepath.Glob(filepath.Join(sysRoot, "class/net/*"))
	if err != nil {
		return networkCounters{}, err
	}
	var result networkCounters
	var found bool
	for _, directory := range directories {
		name := filepath.Base(directory)
		if name == "lo" || !routed[name] {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, "device")); err != nil {
			continue
		}
		state, err := readBounded(filepath.Join(directory, "operstate"), 64)
		if err != nil || strings.TrimSpace(string(state)) != "up" {
			continue
		}
		read := func(relative string) (uint64, error) {
			body, readError := readBounded(filepath.Join(directory, relative), 64)
			if readError != nil {
				return 0, readError
			}
			return strconv.ParseUint(strings.TrimSpace(string(body)), 10, 64)
		}
		rx, e1 := read("statistics/rx_bytes")
		tx, e2 := read("statistics/tx_bytes")
		rxErrors, e3 := read("statistics/rx_errors")
		txErrors, e4 := read("statistics/tx_errors")
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
			continue
		}
		result.receiveBytes += rx
		result.transmitBytes += tx
		result.receiveErrors += rxErrors
		result.transmitErrors += txErrors
		if speed, speedError := read("speed"); speedError == nil && speed <= 1_000_000 {
			result.availableBits += speed * 1_000_000
		}
		found = true
	}
	if !found {
		return networkCounters{}, errors.New("host network counters are unavailable")
	}
	return result, nil
}

func rate(before, after uint64, elapsed time.Duration, resetCode string) Metric {
	if after < before || elapsed <= 0 {
		return unavailable(resetCode)
	}
	return measured(math.Round(float64(after-before) / elapsed.Seconds()))
}

func parseNvidiaSMI(body string) map[string]Metric {
	result := map[string]Metric{
		"utilizationPercent": unavailable("nvidia_smi_unavailable"), "temperatureCelsius": unavailable("nvidia_smi_unavailable"),
		"powerWatts": unavailable("nvidia_smi_unavailable"), "powerLimitWatts": unavailable("nvidia_smi_unavailable"),
	}
	line, _, _ := strings.Cut(strings.TrimSpace(body), "\n")
	fields := strings.Split(line, ",")
	if len(fields) != 4 {
		return result
	}
	keys := []string{"utilizationPercent", "temperatureCelsius", "powerWatts", "powerLimitWatts"}
	for index, key := range keys {
		value := strings.TrimSpace(fields[index])
		if value == "[N/A]" || value == "N/A" || value == "" {
			result[key] = unsupported("nvidia_driver_metric_unsupported")
			continue
		}
		parsed, err := strconv.ParseFloat(value, 64)
		if err != nil || parsed < 0 {
			result[key] = unavailable("nvidia_smi_invalid")
			continue
		}
		result[key] = measured(parsed)
	}
	return result
}

func (provider *HostMetricProvider) accelerator(ctx context.Context) map[string]Metric {
	commandContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(commandContext, provider.config.NvidiaSMI,
		"--query-gpu=utilization.gpu,temperature.gpu,power.draw,power.limit", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return parseNvidiaSMI("")
	}
	return parseNvidiaSMI(string(output))
}

func (provider *HostMetricProvider) nextSequence() (int64, error) {
	body, err := readBounded(provider.config.SequenceFile, 64)
	sequence := int64(0)
	if err == nil {
		sequence, err = strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, errors.New("metric sequence state is invalid")
	}
	if sequence < 0 || sequence == int64(^uint64(0)>>1) {
		return 0, errors.New("metric sequence state is invalid")
	}
	sequence++
	temporary := provider.config.SequenceFile + ".next"
	if err := os.WriteFile(temporary, []byte(strconv.FormatInt(sequence, 10)+"\n"), 0o600); err != nil {
		return 0, err
	}
	if err := os.Rename(temporary, provider.config.SequenceFile); err != nil {
		_ = os.Remove(temporary)
		return 0, err
	}
	return sequence, nil
}

type dockerContainer struct {
	ID, State, Status string
	Names             []string
	Created           int64
	Labels            map[string]string
}
type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint64 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

type dockerInspectTelemetry struct {
	State struct {
		Pid       int  `json:"Pid"`
		OOMKilled bool `json:"OOMKilled"`
	} `json:"State"`
	HostConfig struct {
		Memory int64 `json:"Memory"`
	} `json:"HostConfig"`
}

func parseMemoryPressure(body string) (Metric, Metric) {
	values := map[string]float64{}
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || (fields[0] != "some" && fields[0] != "full") {
			continue
		}
		for _, field := range fields[1:] {
			if !strings.HasPrefix(field, "avg10=") {
				continue
			}
			value, err := strconv.ParseFloat(strings.TrimPrefix(field, "avg10="), 64)
			if err == nil && value >= 0 && value <= 100 {
				values[fields[0]] = value / 100
			}
		}
	}
	some, someOK := values["some"]
	full, fullOK := values["full"]
	if !someOK || !fullOK {
		return unavailable("host_memory_pressure_unavailable"), unavailable("host_memory_pressure_unavailable")
	}
	return measured(some), measured(full)
}

func parseCgroupPath(body string) (string, error) {
	for _, line := range strings.Split(body, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(parts) != 3 || parts[0] != "0" || parts[1] != "" || !strings.HasPrefix(parts[2], "/") {
			continue
		}
		cleaned := filepath.Clean(parts[2])
		if cleaned == "/" || strings.Contains(cleaned, "..") {
			return "", errors.New("worker cgroup path is unsafe")
		}
		return strings.TrimPrefix(cleaned, "/"), nil
	}
	return "", errors.New("worker cgroup v2 path is unavailable")
}

func boundedIntFile(filename string) (int64, error) {
	body, err := readBounded(filename, 128)
	if err != nil {
		return 0, err
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	if err != nil || value < 0 {
		return 0, errors.New("cgroup memory value is invalid")
	}
	return value, nil
}

func parseMemoryEvents(body string) (WorkerCgroupMemoryEvents, error) {
	values := map[string]int64{}
	for _, line := range strings.Split(body, "\n") {
		parts := strings.Fields(line)
		if len(parts) != 2 {
			continue
		}
		value, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || value < 0 {
			return WorkerCgroupMemoryEvents{}, errors.New("cgroup memory event is invalid")
		}
		values[parts[0]] = value
	}
	return WorkerCgroupMemoryEvents{High: values["high"], Max: values["max"], OOM: values["oom"], OOMKill: values["oom_kill"], OOMGroupKill: values["oom_group_kill"]}, nil
}

func parseResidentBytes(body string) (int64, error) {
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "VmRSS:" && fields[2] == "kB" {
			value, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil || value < 0 || value > math.MaxInt64/1024 {
				return 0, errors.New("worker resident memory is invalid")
			}
			return value * 1024, nil
		}
	}
	return 0, errors.New("worker resident memory is unavailable")
}

func (provider *HostMetricProvider) workerMemoryTelemetry(inspect dockerInspectTelemetry, containerID string) (*WorkerCgroupMemoryMetric, *WorkerProcessMemoryMetric) {
	if inspect.State.Pid < 1 {
		return nil, nil
	}
	cgroupBody, err := readBounded(filepath.Join(provider.config.ProcRoot, strconv.Itoa(inspect.State.Pid), "cgroup"), 64<<10)
	if err != nil {
		return nil, nil
	}
	root := filepath.Clean(filepath.Join(provider.config.SysRoot, "fs/cgroup"))
	candidates := []string{}
	if relative, parseError := parseCgroupPath(string(cgroupBody)); parseError == nil {
		candidates = append(candidates, relative)
	}
	if metricDockerID.MatchString(containerID) {
		// In a private cgroup namespace, a host /proc entry for a sibling
		// container can appear as /../docker-<id>.scope. Never resolve that
		// path. Probe only the two bounded Docker cgroup-v2 layouts derived
		// from the exact container identity returned by the Docker API.
		candidates = append(candidates,
			filepath.Join("system.slice", "docker-"+containerID+".scope"),
			filepath.Join("docker", containerID))
	}
	var cgroup *WorkerCgroupMemoryMetric
	for _, relative := range candidates {
		path := filepath.Clean(filepath.Join(root, relative))
		if path == root || !strings.HasPrefix(path, root+string(os.PathSeparator)) {
			continue
		}
		current, currentError := boundedIntFile(filepath.Join(path, "memory.current"))
		peak, peakError := boundedIntFile(filepath.Join(path, "memory.peak"))
		maximumBody, maximumError := readBounded(filepath.Join(path, "memory.max"), 128)
		eventBody, eventError := readBounded(filepath.Join(path, "memory.events"), 64<<10)
		events, parseEventsError := parseMemoryEvents(string(eventBody))
		if currentError != nil || peakError != nil || maximumError != nil || eventError != nil || parseEventsError != nil {
			continue
		}
		var maximum any = strings.TrimSpace(string(maximumBody))
		if maximum != "max" {
			parsed, parseError := strconv.ParseInt(maximum.(string), 10, 64)
			if parseError != nil || parsed < 0 {
				continue
			}
			maximum = parsed
		}
		cgroup = &WorkerCgroupMemoryMetric{CurrentBytes: current, PeakBytes: peak, MaximumBytes: maximum, Events: events}
		// Report inactive file cache separately. Keep memory.current intact for
		// accounting; the pressure consumer can distinguish reclaimable cache
		// from the working set without guessing or relaxing the hard limit.
		if body, err := readBounded(filepath.Join(path, "memory.stat"), 64<<10); err == nil {
			cgroup.InactiveFileBytes = parseInactiveFileBytes(string(body), current)
		}
		break
	}
	if cgroup == nil {
		return nil, nil
	}
	statusBody, statusError := readBounded(filepath.Join(provider.config.ProcRoot, strconv.Itoa(inspect.State.Pid), "status"), 1<<20)
	resident, residentError := parseResidentBytes(string(statusBody))
	if statusError != nil || residentError != nil {
		return cgroup, nil
	}
	return cgroup, &WorkerProcessMemoryMetric{ResidentBytes: resident}
}

func parseInactiveFileBytes(body string, current int64) *int64 {
	var found *int64
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "inactive_file" {
			continue
		}
		if len(fields) != 2 || found != nil {
			return nil
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || value < 0 || value > current {
			return nil
		}
		found = &value
	}
	return found
}

func (provider *HostMetricProvider) dockerRequest(ctx context.Context, endpoint string, output any) error {
	if provider.docker == nil {
		return errors.New("Docker telemetry is disabled")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/v1.48"+endpoint, nil)
	if err != nil {
		return err
	}
	response, err := provider.docker.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("Docker telemetry returned %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, metricMaximumResponseBytes)).Decode(output)
}

func dockerCPU(value dockerStats) Metric {
	containerDelta := value.CPUStats.CPUUsage.TotalUsage - value.PreCPUStats.CPUUsage.TotalUsage
	systemDelta := value.CPUStats.SystemCPUUsage - value.PreCPUStats.SystemCPUUsage
	cores := value.CPUStats.OnlineCPUs
	if containerDelta == 0 || systemDelta == 0 || cores == 0 {
		return measured(0)
	}
	return measured(float64(containerDelta) / float64(systemDelta) * float64(cores) * 100)
}

func dockerMemory(value dockerStats) Metric {
	usage := value.MemoryStats.Usage
	if inactive := value.MemoryStats.Stats["inactive_file"]; inactive <= usage {
		usage -= inactive
	}
	return measured(float64(usage))
}

func validMetricID(value string) bool {
	return value != "" && len(value) <= 256 && regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`).MatchString(value)
}

func inferredComposeService(names []string, composeProject string) string {
	if composeProject == "" {
		return ""
	}
	prefix := "/" + composeProject + "-"
	for _, name := range names {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		remainder := strings.TrimPrefix(name, prefix)
		separator := strings.LastIndexByte(remainder, '-')
		if separator < 1 || separator == len(remainder)-1 {
			continue
		}
		instance, err := strconv.Atoi(remainder[separator+1:])
		service := remainder[:separator]
		if err == nil && instance > 0 && validMetricID(service) {
			return service
		}
	}
	return ""
}

func coreServiceKey(container dockerContainer, composeProject string) string {
	if value := container.Labels["com.teamaibox.core-service-key"]; validMetricID(value) {
		return value
	}
	if composeProject != "" && container.Labels["com.docker.compose.project"] == composeProject {
		if value := container.Labels["com.docker.compose.service"]; validMetricID(value) {
			return value
		}
	}
	return inferredComposeService(container.Names, composeProject)
}

func successfulCompletedContainer(container dockerContainer) bool {
	return container.State == "exited" && strings.Contains(container.Status, "Exited (0)")
}

func coreServiceRank(container dockerContainer) int {
	if container.State != "running" {
		return 0
	}
	if strings.Contains(strings.ToLower(container.Status), "unhealthy") {
		return 1
	}
	return 2
}

// currentCoreServices collapses Docker's retained Compose history to one
// current representative per logical service. A live successor always wins
// over an exited predecessor. Successful one-shot containers are intentionally
// omitted when no live successor exists, while failed/stuck services remain
// visible and fail closed.
func currentCoreServices(containers []dockerContainer, composeProject string, retiredKeys ...string) map[string]dockerContainer {
	retired := make(map[string]bool, len(retiredKeys))
	for _, key := range retiredKeys {
		retired[key] = true
	}
	candidates := map[string][]dockerContainer{}
	for _, container := range containers {
		key := coreServiceKey(container, composeProject)
		if key != "" && !(retired[key] && container.State == "exited") {
			candidates[key] = append(candidates[key], container)
		}
	}
	selected := map[string]dockerContainer{}
	for key, values := range candidates {
		sort.Slice(values, func(left, right int) bool {
			leftRank, rightRank := coreServiceRank(values[left]), coreServiceRank(values[right])
			if leftRank != rightRank {
				return leftRank > rightRank
			}
			if values[left].Created != values[right].Created {
				return values[left].Created > values[right].Created
			}
			return values[left].ID > values[right].ID
		})
		if coreServiceRank(values[0]) == 0 {
			failed := values[:0]
			for _, candidate := range values {
				if !successfulCompletedContainer(candidate) {
					failed = append(failed, candidate)
				}
			}
			if len(failed) == 0 {
				continue
			}
			values = failed
			sort.Slice(values, func(left, right int) bool {
				if values[left].Created != values[right].Created {
					return values[left].Created > values[right].Created
				}
				return values[left].ID > values[right].ID
			})
		}
		selected[key] = values[0]
	}
	return selected
}

// Guest reservations are keyed by run ID, not a model worker ID. Reuse the
// authenticated cgroup telemetry path so realized guest memory is not reserved
// twice. This grants no model-worker execution authority.
// Match the guest provisioning contract: a storage pool is a logical key,
// not a UUID. Factory installations generate pool-<uuid> keys.
var metricPoolID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,127}$`)

func metricWorkerIdentity(labels map[string]string, nodeID string) string {
	if labels["com.teamaibox.node-id"] != nodeID {
		return ""
	}
	if labels["com.teamaibox.kind"] == "android-phone" {
		if labels["com.teamaibox.managed"] != "true" {
			return ""
		}
		for _, key := range []string{"phone-run-id", "phone-id", "owner-identity-id", "reservation-id", "volume-id"} {
			if !metricUUID.MatchString(labels["com.teamaibox."+key]) {
				return ""
			}
		}
		if !metricPoolID.MatchString(labels["com.teamaibox.pool-id"]) {
			return ""
		}
		for _, key := range []string{"node-generation", "phone-generation"} {
			generation, err := strconv.ParseUint(labels["com.teamaibox."+key], 10, 53)
			if err != nil || generation < 1 {
				return ""
			}
		}
		return labels["com.teamaibox.phone-run-id"]
	}
	if labels["com.teamaibox.kind"] == "windows-computer" {
		if labels["com.teamaibox.managed"] != "true" {
			return ""
		}
		// These are the labels written by ComputerContainerBuilder. Provisioning
		// containers have no run ID and must not discount a running reservation.
		for _, key := range []string{"computer-run-id", "computer-id", "owner-identity-id", "volume-id", "firmware-id"} {
			if !metricUUID.MatchString(labels["com.teamaibox."+key]) {
				return ""
			}
		}
		if !metricPoolID.MatchString(labels["com.teamaibox.pool-id"]) {
			return ""
		}
		if !validMetricID(labels["com.teamaibox.profile-id"]) {
			return ""
		}
		generation, err := strconv.ParseUint(labels["com.teamaibox.computer-generation"], 10, 53)
		if err != nil || generation < 1 {
			return ""
		}
		return labels["com.teamaibox.computer-run-id"]
	}
	if id := labels["com.teamaibox.worker-id"]; metricUUID.MatchString(id) {
		return id
	}
	return ""
}

// Current owned guests share the same reservation ledger. Read both Android
// and Windows directly so an optional/late metrics upload cannot count already
// realized Windows memory a second time. The legacy phone-baseline wire name is
// retained; these measurements grant no guest or model execution authority.
// Docker memory_stats.usage includes the guest and media processes. Failed or
// unknown measurements get no reservation discount.
func (provider *HostMetricProvider) phoneWorkerMemory(ctx context.Context) ([]PhoneWorkerMemory, error) {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.managed=true", "com.teamaibox.node-id=" + provider.config.NodeID}})
	containers := []dockerContainer{}
	if err := provider.dockerRequest(ctx, "/containers/json?filters="+url.QueryEscape(string(filters)), &containers); err != nil {
		return nil, err
	}
	result := []PhoneWorkerMemory{}
	for _, c := range containers {
		id := metricWorkerIdentity(c.Labels, provider.config.NodeID)
		kind := c.Labels["com.teamaibox.kind"]
		if c.State != "running" || (kind != "android-phone" && kind != "windows-computer") || id == "" || !metricDockerID.MatchString(c.ID) {
			continue
		}
		stats := dockerStats{}
		if err := provider.dockerRequest(ctx, "/containers/"+c.ID+"/stats?stream=false&one-shot=true", &stats); err != nil {
			return nil, err
		}
		if stats.MemoryStats.Usage > 0 && stats.MemoryStats.Usage <= 1<<53-1 {
			result = append(result, PhoneWorkerMemory{WorkerID: id, CurrentBytes: stats.MemoryStats.Usage})
		}
	}
	return result, nil
}

func (provider *HostMetricProvider) containerMetrics(ctx context.Context) ([]ProcessMetric, []WorkerMetric, []ModelMetric, []CoreServiceMetric) {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.managed=true"}})
	containers := []dockerContainer{}
	if err := provider.dockerRequest(ctx, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), &containers); err != nil {
		return []ProcessMetric{}, []WorkerMetric{}, []ModelMetric{}, []CoreServiceMetric{}
	}
	sort.Slice(containers, func(left, right int) bool { return containers[left].ID < containers[right].ID })
	processes := []ProcessMetric{}
	workers := []WorkerMetric{}
	models := []ModelMetric{}
	services := []CoreServiceMetric{}
	seenModels := map[string]bool{}
	selectedServices := currentCoreServices(containers, provider.config.ComposeProject, provider.config.RetiredCoreServices...)
	selectedServiceByContainer := map[string]string{}
	for key, container := range selectedServices {
		selectedServiceByContainer[container.ID] = key
	}
	for _, container := range containers {
		labels := container.Labels
		kind, targetID := "", ""
		workerID := metricWorkerIdentity(labels, provider.config.NodeID)
		ownedWorker := workerID != ""
		projectOwned := provider.config.ComposeProject != "" && labels["com.docker.compose.project"] == provider.config.ComposeProject
		if ownedWorker {
			if labels["com.teamaibox.kind"] == "agent-sandbox" {
				kind, targetID = "agent_sandbox", workerID
			} else {
				kind, targetID = "worker", workerID
			}
		} else if projectOwned && labels["com.teamaibox.plugin-id"] != "" {
			kind, targetID = "plugin", labels["com.teamaibox.plugin-id"]
		} else if key := selectedServiceByContainer[container.ID]; key != "" {
			kind, targetID = "core_service", key
		}
		if !validMetricID(targetID) {
			continue
		}
		stats := dockerStats{}
		statsError := provider.dockerRequest(ctx, "/containers/"+url.PathEscape(container.ID)+"/stats?stream=false&one-shot=true", &stats)
		cpu, memory := unavailable("container_stats_unavailable"), unavailable("container_stats_unavailable")
		if statsError == nil {
			cpu, memory = dockerCPU(stats), dockerMemory(stats)
		}
		cgroupMemory := memory
		var inspect dockerInspectTelemetry
		var cgroup *WorkerCgroupMemoryMetric
		var process *WorkerProcessMemoryMetric
		inspectError := errors.New("container inspection is unavailable")
		if ownedWorker {
			inspectError = provider.dockerRequest(ctx, "/containers/"+url.PathEscape(container.ID)+"/json", &inspect)
		}
		if ownedWorker && inspectError == nil {
			cgroup, process = provider.workerMemoryTelemetry(inspect, container.ID)
			if cgroup != nil {
				cgroupMemory = measured(float64(cgroup.CurrentBytes))
				memory = cgroupMemory
			}
		}
		// A retained stopped container is not current Worker capacity. Preserve a
		// stopped container only when Docker itself records an OOM kill, so the
		// scheduler can fence that still-active logical Worker without publishing
		// every historical non-OOM container forever.
		if ownedWorker && container.State != "running" && (inspectError != nil || !inspect.State.OOMKilled) {
			continue
		}
		processes = append(processes, ProcessMetric{TargetKind: kind, TargetID: targetID, CPUPercent: cpu, UnifiedMemoryBytes: memory, CgroupMemoryBytes: cgroupMemory, AcceleratorMemoryBytes: unsupported("unified_memory_architecture")})
		if ownedWorker && kind == "worker" {
			state := "ready"
			if labels["com.teamaibox.attempt-id"] != "" || labels["com.teamaibox.kind"] == "android-phone" || labels["com.teamaibox.kind"] == "windows-computer" {
				state = "busy"
			}
			if container.State != "running" {
				state = "failed"
			}
			var profileID *string
			if value := labels["com.teamaibox.model-profile-id"]; metricUUID.MatchString(value) {
				profileID = &value
			}
			runtime := WorkerRuntimeMemoryMetric{Status: "unavailable", ReasonCode: reason("worker_runtime_inspection_unavailable"), OOMKilled: nil}
			if inspectError == nil {
				runtime = WorkerRuntimeMemoryMetric{Status: "measured", ReasonCode: nil, OOMKilled: boolean(inspect.State.OOMKilled)}
			}
			workers = append(workers, WorkerMetric{WorkerID: workerID, State: state, ProfileID: profileID, JobID: nil, CPUPercent: cpu, UnifiedMemoryBytes: memory, AcceleratorUtilizationPercent: unavailable("per_worker_accelerator_attribution_unavailable"), Cgroup: cgroup, Process: process,
				Engine: WorkerEngineMemoryMetric{Status: "unavailable", ReasonCode: reason("worker_engine_memory_not_reported")}, Runtime: runtime})
			if profileID != nil && !seenModels[*profileID] {
				seenModels[*profileID] = true
				copiedWorker := workerID
				models = append(models, ModelMetric{ProfileID: *profileID, State: "loaded", WorkerID: &copiedWorker, UnifiedMemoryBytes: memory, LoadMilliseconds: unavailable("worker_load_duration_not_reported")})
			}
		}
		if kind == "core_service" {
			state := "healthy"
			availability := measured(100)
			if container.State != "running" || strings.Contains(strings.ToLower(container.Status), "unhealthy") {
				state = "unavailable"
				availability = measured(0)
			}
			services = append(services, CoreServiceMetric{ServiceKey: targetID, State: state, AvailabilityPercent: availability, LatencyMilliseconds: unavailable("service_latency_not_collected_at_node"), ErrorRatePercent: unavailable("service_error_rate_not_collected_at_node")})
		}
	}
	sort.Slice(services, func(left, right int) bool { return services[left].ServiceKey < services[right].ServiceKey })
	return processes, workers, models, services
}

func storageMetrics(anchor string) map[string]Metric {
	stat := syscall.Statfs_t{}
	if err := syscall.Statfs(anchor, &stat); err != nil {
		return map[string]Metric{"totalBytes": unavailable("host_storage_unavailable"), "usedBytes": unavailable("host_storage_unavailable"), "availableBytes": unavailable("host_storage_unavailable")}
	}
	total := uint64(stat.Blocks) * uint64(stat.Bsize)
	available := uint64(stat.Bavail) * uint64(stat.Bsize)
	return map[string]Metric{"totalBytes": measured(float64(total)), "usedBytes": measured(float64(total - available)), "availableBytes": measured(float64(available))}
}

func (provider *HostMetricProvider) Snapshot(ctx context.Context) (MetricSnapshot, error) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	bootBody, err := readBounded(filepath.Join(provider.config.ProcRoot, "sys/kernel/random/boot_id"), 128)
	if err != nil || !metricUUID.MatchString(strings.TrimSpace(string(bootBody))) {
		return MetricSnapshot{}, errors.New("host boot identity is unavailable")
	}
	statBeforeBody, err := readBounded(filepath.Join(provider.config.ProcRoot, "stat"), 1<<20)
	if err != nil {
		return MetricSnapshot{}, err
	}
	cpuBefore, err := parseCPU(string(statBeforeBody))
	if err != nil {
		return MetricSnapshot{}, err
	}
	diskBefore, diskBeforeError := readDiskCounters(provider.config.SysRoot)
	// A bind-mounted /proc/net follows the caller's network namespace. PID 1 in
	// the host procfs mount retains the host network namespace and route table.
	routeBody, routeError := readBounded(filepath.Join(provider.config.ProcRoot, "1/net/route"), 1<<20)
	routed := routedInterfaces(string(routeBody))
	networkBefore, networkBeforeError := readNetworkCounters(provider.config.SysRoot, routed)
	if routeError != nil {
		networkBeforeError = routeError
	}
	started := time.Now()
	timer := time.NewTimer(provider.config.SampleWindow)
	select {
	case <-ctx.Done():
		timer.Stop()
		return MetricSnapshot{}, ctx.Err()
	case <-timer.C:
	}
	elapsed := time.Since(started)
	statAfterBody, err := readBounded(filepath.Join(provider.config.ProcRoot, "stat"), 1<<20)
	if err != nil {
		return MetricSnapshot{}, err
	}
	cpuAfter, err := parseCPU(string(statAfterBody))
	if err != nil {
		return MetricSnapshot{}, err
	}
	diskAfter, diskAfterError := readDiskCounters(provider.config.SysRoot)
	networkAfter, networkAfterError := readNetworkCounters(provider.config.SysRoot, routed)
	memBody, err := readBounded(filepath.Join(provider.config.ProcRoot, "meminfo"), 1<<20)
	if err != nil {
		return MetricSnapshot{}, err
	}
	totalMemory, availableMemory, err := parseMeminfo(string(memBody))
	if err != nil {
		return MetricSnapshot{}, err
	}
	loadBody, _ := readBounded(filepath.Join(provider.config.ProcRoot, "loadavg"), 4096)
	pressureBody, pressureError := readBounded(filepath.Join(provider.config.ProcRoot, "pressure/memory"), 64<<10)
	someAverage10, fullAverage10 := unavailable("host_memory_pressure_unavailable"), unavailable("host_memory_pressure_unavailable")
	if pressureError == nil {
		someAverage10, fullAverage10 = parseMemoryPressure(string(pressureBody))
	}
	inventory, err := FileInventoryProvider{Filename: provider.config.InventoryFile}.Snapshot(ctx)
	if err != nil {
		return MetricSnapshot{}, err
	}
	sequence, err := provider.nextSequence()
	if err != nil {
		return MetricSnapshot{}, err
	}
	processes, workers, models, coreServices := provider.containerMetrics(ctx)
	storage := storageMetrics(provider.config.StorageAnchor)
	if diskBeforeError == nil && diskAfterError == nil {
		storage["readBytesPerSecond"] = rate(diskBefore.readBytes, diskAfter.readBytes, elapsed, "host_storage_counter_reset")
		storage["writeBytesPerSecond"] = rate(diskBefore.writeBytes, diskAfter.writeBytes, elapsed, "host_storage_counter_reset")
	} else {
		storage["readBytesPerSecond"] = unavailable("host_storage_io_unavailable")
		storage["writeBytesPerSecond"] = unavailable("host_storage_io_unavailable")
	}
	network := map[string]Metric{}
	if networkBeforeError == nil && networkAfterError == nil {
		network["receiveBytesPerSecond"] = rate(networkBefore.receiveBytes, networkAfter.receiveBytes, elapsed, "host_network_counter_reset")
		network["transmitBytesPerSecond"] = rate(networkBefore.transmitBytes, networkAfter.transmitBytes, elapsed, "host_network_counter_reset")
		network["availableBitsPerSecond"] = measured(float64(networkAfter.availableBits))
		network["receiveErrors"] = measured(float64(networkAfter.receiveErrors))
		network["transmitErrors"] = measured(float64(networkAfter.transmitErrors))
	} else {
		for _, key := range []string{"receiveBytesPerSecond", "transmitBytesPerSecond", "availableBitsPerSecond", "receiveErrors", "transmitErrors"} {
			network[key] = unavailable("host_network_unavailable")
		}
	}
	reservations := map[string]Metric{}
	for _, key := range []string{"cpuMillis", "unifiedMemoryBytes", "acceleratorUnits", "codecSessions", "storageBytes", "networkBitsPerSecond"} {
		reservations[key] = measured(float64(inventory.Reservations[key]))
	}
	jobs := map[string]Metric{}
	for _, key := range []string{"queued", "preparing", "running", "succeeded", "failed", "cancelled"} {
		jobs[key] = unavailable("controller_job_telemetry_not_available_on_node")
	}
	logicalCores := inventory.Resources.CPU["totalMillis"] / 1000
	if logicalCores < 1 {
		logicalCores = int64(cpuAfter.total - cpuBefore.total)
		if logicalCores < 1 {
			logicalCores = 1
		}
	}
	snapshot := MetricSnapshot{SchemaVersion: 1, ObservedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Sequence: sequence,
		Domains: MetricDomains{
			CPU:           map[string]Metric{"logicalCores": measured(float64(logicalCores)), "utilizationPercent": utilization(cpuBefore, cpuAfter), "load1": load1(string(loadBody))},
			UnifiedMemory: map[string]Metric{"totalBytes": measured(float64(totalMemory)), "usedBytes": measured(float64(totalMemory - availableMemory)), "availableBytes": measured(float64(availableMemory)), "dedicatedAcceleratorMemoryBytes": unsupported("unified_memory_architecture")},
			Accelerator:   provider.accelerator(ctx), Storage: storage, Network: network,
			Codecs: map[string]Metric{"encodeActive": unsupported("codec_session_metrics_not_exposed"), "encodeCapacity": unsupported("codec_session_metrics_not_exposed"), "decodeActive": unsupported("codec_session_metrics_not_exposed"), "decodeCapacity": unsupported("codec_session_metrics_not_exposed")},
		}, MemoryPressure: MemoryPressureMetric{SomeAverage10: someAverage10, FullAverage10: fullAverage10}, Processes: processes, Workers: workers, Models: models, Jobs: jobs, Queues: []QueueMetric{}, Reservations: reservations, CoreServices: coreServices}
	snapshot.Collector.AgentVersion = provider.config.AgentVersion
	snapshot.Collector.BootID = strings.TrimSpace(string(bootBody))
	return snapshot, nil
}

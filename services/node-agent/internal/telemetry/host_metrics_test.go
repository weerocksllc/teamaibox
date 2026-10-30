package telemetry

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHostMetricParsersPreserveUnifiedMemoryAndCPUTruth(t *testing.T) {
	total, available, err := parseMeminfo("MemTotal:       125000000 kB\nMemAvailable:    64000000 kB\n")
	if err != nil || total != 128000000000 || available != 65536000000 {
		t.Fatalf("unexpected memory result: %d %d %v", total, available, err)
	}
	before, err := parseCPU("cpu  100 10 20 400 10 0 0 0 0 0\n")
	if err != nil {
		t.Fatal(err)
	}
	after, err := parseCPU("cpu  120 10 30 450 10 0 0 0 0 0\n")
	if err != nil {
		t.Fatal(err)
	}
	metric := utilization(before, after)
	if metric.Status != "measured" || metric.Value == nil || *metric.Value <= 0 || *metric.Value >= 100 {
		t.Fatalf("unexpected CPU utilization: %#v", metric)
	}
}

func TestNvidiaSMIParserMarksUnsupportedFieldsExplicitly(t *testing.T) {
	metrics := parseNvidiaSMI("37, 58, 12.75, [N/A]\n")
	if metrics["utilizationPercent"].Status != "measured" || *metrics["utilizationPercent"].Value != 37 {
		t.Fatal("GPU utilization was not measured")
	}
	if metrics["powerLimitWatts"].Status != "unsupported" || metrics["powerLimitWatts"].Value != nil {
		t.Fatal("unsupported power limit was invented")
	}
}

func TestCounterRatesFailClosedOnReset(t *testing.T) {
	metric := rate(200, 100, 1, "counter_reset")
	if metric.Status != "unavailable" || metric.ReasonCode == nil || *metric.ReasonCode != "counter_reset" {
		t.Fatalf("counter reset did not fail closed: %#v", metric)
	}
}

func TestCounterRatesAreProtocolSafeIntegers(t *testing.T) {
	metric := rate(100, 201, 3*time.Second, "counter_reset")
	if metric.Status != "measured" || metric.Value == nil || *metric.Value != 34 {
		t.Fatalf("counter rate was not rounded to a safe integer: %#v", metric)
	}
}

func TestMetricTimestampUsesControllerCanonicalMilliseconds(t *testing.T) {
	value := time.Date(2026, 8, 19, 7, 8, 9, 123456789, time.UTC).Format("2006-01-02T15:04:05.000Z")
	if value != "2026-08-19T07:08:09.123Z" {
		t.Fatalf("metric timestamp is not canonical: %s", value)
	}
}

func TestRoutedInterfacesRejectsInactiveAndLoopbackLinks(t *testing.T) {
	body := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
		"enP2p1s0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n" +
		"enp1s0f0np0\t00DCFEA9\t00000000\t0001\t0\t0\t0\tFCFFFFFF\t0\t0\t0\n" +
		"lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n"
	routed := routedInterfaces(body)
	if !routed["enP2p1s0"] || routed["enp1s0f0np0"] || routed["lo"] || len(routed) != 1 {
		t.Fatalf("unexpected routed interface set: %#v", routed)
	}
}

func TestMemoryPressureAndCgroupEvidenceParsersRemainBounded(t *testing.T) {
	some, full := parseMemoryPressure("some avg10=1.25 avg60=0.10 avg300=0.01 total=42\nfull avg10=0.05 avg60=0.01 avg300=0.00 total=7\n")
	if some.Status != "measured" || some.Value == nil || *some.Value != 0.0125 || full.Value == nil || *full.Value != 0.0005 {
		t.Fatalf("unexpected PSI metrics: %#v %#v", some, full)
	}
	path, err := parseCgroupPath("0::/system.slice/docker-abc.scope\n")
	if err != nil || path != "system.slice/docker-abc.scope" {
		t.Fatalf("unexpected cgroup path: %q %v", path, err)
	}
	events, err := parseMemoryEvents("low 0\nhigh 2\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n")
	if err != nil || events.High != 2 || events.Max != 3 || events.OOM != 1 || events.OOMKill != 1 || events.OOMGroupKill != 0 {
		t.Fatalf("unexpected memory events: %#v %v", events, err)
	}
	resident, err := parseResidentBytes("Name:\tworker\nVmRSS:\t1234 kB\n")
	if err != nil || resident != 1234*1024 {
		t.Fatalf("unexpected resident memory: %d %v", resident, err)
	}
}

func TestWorkerMemoryTelemetryUsesBoundedDockerSystemdFallbackInPrivateCgroupNamespace(t *testing.T) {
	root := t.TempDir()
	procRoot, sysRoot := filepath.Join(root, "proc"), filepath.Join(root, "sys")
	containerID := strings.Repeat("a", 64)
	processRoot := filepath.Join(procRoot, "123")
	cgroupRoot := filepath.Join(sysRoot, "fs/cgroup/system.slice", "docker-"+containerID+".scope")
	for _, directory := range []string{processRoot, cgroupRoot} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(processRoot, "cgroup"):        "0::/../docker-" + containerID + ".scope\n",
		filepath.Join(processRoot, "status"):        "Name:\tsleep\nVmRSS:\t  1234 kB\n",
		filepath.Join(cgroupRoot, "memory.current"): "4096\n",
		filepath.Join(cgroupRoot, "memory.peak"):    "8192\n",
		filepath.Join(cgroupRoot, "memory.stat"):    "anon 1024\ninactive_file 2048\n",
		filepath.Join(cgroupRoot, "memory.max"):     "134217728\n",
		filepath.Join(cgroupRoot, "memory.events"):  "low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 5\n",
	}
	for name, body := range files {
		if err := os.WriteFile(name, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	provider := &HostMetricProvider{config: HostMetricConfig{ProcRoot: procRoot, SysRoot: sysRoot}}
	inspect := dockerInspectTelemetry{}
	inspect.State.Pid = 123
	cgroup, process := provider.workerMemoryTelemetry(inspect, containerID)
	if cgroup == nil || process == nil || cgroup.CurrentBytes != 4096 || cgroup.PeakBytes != 8192 ||
		cgroup.InactiveFileBytes == nil || *cgroup.InactiveFileBytes != 2048 ||
		cgroup.MaximumBytes != int64(134217728) || cgroup.Events.OOMKill != 4 || process.ResidentBytes != 1234*1024 {
		t.Fatalf("unexpected private-cgroup fallback telemetry: cgroup=%+v process=%+v", cgroup, process)
	}
}

func TestInactiveFileCacheFailsClosed(t *testing.T) {
	for _, value := range []string{"", "inactive_file -1", "inactive_file 4097", "inactive_file 1\ninactive_file 2", "inactive_file not-a-number"} {
		if parseInactiveFileBytes(value, 4096) != nil {
			t.Fatalf("accepted invalid cache measurement: %q", value)
		}
	}
	if value := parseInactiveFileBytes("inactive_file 0", 4096); value == nil || *value != 0 {
		t.Fatal("measured zero lost")
	}
}

func TestCurrentCoreServicesPrefersLiveSuccessorAndOmitsSuccessfulOneShot(t *testing.T) {
	project := "teamaibox_feature_encryption_suite_20260823_a377"
	containers := []dockerContainer{
		{ID: "old", State: "exited", Status: "Exited (1) 2 hours ago", Created: 1,
			Labels: map[string]string{"com.docker.compose.project": project, "com.docker.compose.service": "local-node-agent"}},
		{ID: "live", State: "running", Status: "Up 10 minutes (healthy)", Created: 2,
			Labels: map[string]string{"com.docker.compose.project": project, "com.docker.compose.service": "local-node-agent"}},
		{ID: "migrate", State: "exited", Status: "Exited (0) 3 hours ago", Created: 3,
			Labels: map[string]string{"com.docker.compose.project": project, "com.docker.compose.service": "database-migrate"}},
	}
	selected := currentCoreServices(containers, project)
	if selected["local-node-agent"].ID != "live" {
		t.Fatalf("live successor was not selected: %#v", selected)
	}
	if _, exists := selected["database-migrate"]; exists {
		t.Fatalf("successful one-shot was published as a live core service: %#v", selected)
	}
}

func TestCurrentCoreServicesInfersCanonicalReplacementAndRetainsFailure(t *testing.T) {
	project := "teamaibox_feature_encryption_suite_20260823_a377"
	containers := []dockerContainer{
		{ID: "gateway", State: "running", Status: "Up 5 minutes (healthy)", Created: 4,
			Names: []string{"/" + project + "-compute-gateway-1"}, Labels: map[string]string{}},
		{ID: "failed", State: "exited", Status: "Exited (137) 1 minute ago", Created: 5,
			Labels: map[string]string{"com.teamaibox.core-service-key": "object-service"}},
	}
	selected := currentCoreServices(containers, project)
	if selected["compute-gateway"].ID != "gateway" {
		t.Fatalf("canonical replacement name was not inferred: %#v", selected)
	}
	if selected["object-service"].ID != "failed" {
		t.Fatalf("failed persistent service was hidden: %#v", selected)
	}
}

func TestExplicitRetirementOmitsStoppedHistoryButNotLiveOrUnexpectedFailure(t *testing.T) {
	containers := []dockerContainer{
		{ID: "retired", State: "exited", Status: "Exited (143)", Labels: map[string]string{"com.teamaibox.core-service-key": "retired-service"}},
		{ID: "required", State: "exited", Status: "Exited (1)", Labels: map[string]string{"com.teamaibox.core-service-key": "required-service"}},
		{ID: "still-live", State: "running", Status: "Up (unhealthy)", Labels: map[string]string{"com.teamaibox.core-service-key": "incomplete-retirement"}},
		{ID: "stuck", State: "dead", Status: "Dead", Labels: map[string]string{"com.teamaibox.core-service-key": "stuck-retirement"}},
	}
	selected := currentCoreServices(containers, "", "retired-service", "incomplete-retirement", "stuck-retirement")
	if _, exists := selected["retired-service"]; exists {
		t.Fatalf("retired stopped service remains required: %#v", selected)
	}
	for _, key := range []string{"required-service", "incomplete-retirement", "stuck-retirement"} {
		if _, exists := selected[key]; !exists {
			t.Fatalf("active or unresolved service was hidden: %s", key)
		}
	}
	if _, exists := currentCoreServices(containers, "")["retired-service"]; !exists {
		t.Fatal("stopped service was hidden without explicit deployment retirement")
	}
}

func TestRetiredCoreServiceConfigurationRejectsWildcard(t *testing.T) {
	_, err := NewHostMetricProvider(HostMetricConfig{RetiredCoreServices: []string{"*"}})
	if err == nil || err.Error() != "retired core service key is invalid" {
		t.Fatalf("invalid retirement accepted: %v", err)
	}
}

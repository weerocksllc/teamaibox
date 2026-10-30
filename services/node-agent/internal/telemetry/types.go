package telemetry

type ResourceMap map[string]int64

type Health struct {
	State     string  `json:"state"`
	ErrorCode *string `json:"errorCode"`
}

type Runtime struct {
	RuntimeKey  string `json:"runtimeKey"`
	Version     string `json:"version"`
	ImageDigest string `json:"imageDigest"`
}

type ModelProfile struct {
	ProfileID          string   `json:"profileId"`
	ProfileKey         string   `json:"profileKey"`
	ProfileFingerprint string   `json:"profileFingerprint"`
	LifecycleState     string   `json:"lifecycleState"`
	Operations         []string `json:"operations"`
}

type Capability struct {
	CapabilityKey  string `json:"capabilityKey"`
	State          string `json:"state"`
	EvidenceDigest string `json:"evidenceDigest"`
}

type NetworkLink struct {
	LinkKey             string `json:"linkKey"`
	NetworkClass        string `json:"networkClass"`
	Health              string `json:"health"`
	SpeedBitsPerSecond  int64  `json:"speedBitsPerSecond"`
	MTU                 int64  `json:"mtu"`
	LatencyMicroseconds int64  `json:"latencyMicroseconds"`
}

type Resources struct {
	CPU           ResourceMap `json:"cpu"`
	UnifiedMemory ResourceMap `json:"unifiedMemory"`
	Accelerator   ResourceMap `json:"accelerator"`
	Codecs        ResourceMap `json:"codecs"`
	Storage       ResourceMap `json:"storage"`
	Network       ResourceMap `json:"network"`
}

type AcceleratorSchedulingFacts struct {
	Kind                string   `json:"kind"`
	ComputeCapability   string   `json:"computeCapability"`
	SupportedPrecisions []string `json:"supportedPrecisions"`
	EvidenceDigest      string   `json:"evidenceDigest"`
}

type CodecSchedulingFacts struct {
	EncodeSessions int64  `json:"encodeSessions"`
	DecodeSessions int64  `json:"decodeSessions"`
	EvidenceDigest string `json:"evidenceDigest"`
}

type StorageSchedulingFacts struct {
	Classes        []string `json:"classes"`
	EvidenceDigest string   `json:"evidenceDigest"`
}

type SchedulerFacts struct {
	Accelerator         AcceleratorSchedulingFacts `json:"accelerator"`
	Codec               CodecSchedulingFacts       `json:"codec"`
	Storage             StorageSchedulingFacts     `json:"storage"`
	WorkerState         string                     `json:"workerState"`
	ModelArtifactCached bool                       `json:"modelArtifactCached"`
	InputArtifactIDs    []string                   `json:"inputArtifactIds"`
}

type Inventory struct {
	SchemaVersion   int            `json:"schemaVersion"`
	Architecture    string         `json:"architecture"`
	AgentVersion    string         `json:"agentVersion"`
	Health          Health         `json:"health"`
	Runtimes        []Runtime      `json:"runtimes"`
	ModelProfiles   []ModelProfile `json:"modelProfiles"`
	Capabilities    []Capability   `json:"capabilities"`
	Resources       Resources      `json:"resources"`
	SchedulerFacts  SchedulerFacts `json:"schedulerFacts"`
	NetworkLinks    []NetworkLink  `json:"networkLinks"`
	Reservations    ResourceMap    `json:"reservations"`
	ActiveWorkloads int64          `json:"activeWorkloads"`
}

type HeartbeatResponse struct {
	NodeID              string `json:"nodeId"`
	Generation          int64  `json:"generation"`
	LifecycleState      string `json:"lifecycleState"`
	HeartbeatAcceptedAt string `json:"heartbeatAcceptedAt"`
	NextHeartbeatBefore string `json:"nextHeartbeatBefore"`
}

type Metric struct {
	Status     string   `json:"status"`
	Value      *float64 `json:"value"`
	ReasonCode *string  `json:"reasonCode"`
}

type MetricDomains struct {
	CPU           map[string]Metric `json:"cpu"`
	UnifiedMemory map[string]Metric `json:"unifiedMemory"`
	Accelerator   map[string]Metric `json:"accelerator"`
	Storage       map[string]Metric `json:"storage"`
	Network       map[string]Metric `json:"network"`
	Codecs        map[string]Metric `json:"codecs"`
}

type MemoryPressureMetric struct {
	SomeAverage10 Metric `json:"someAverage10"`
	FullAverage10 Metric `json:"fullAverage10"`
}

type ProcessMetric struct {
	TargetKind             string `json:"targetKind"`
	TargetID               string `json:"targetId"`
	CPUPercent             Metric `json:"cpuPercent"`
	UnifiedMemoryBytes     Metric `json:"unifiedMemoryBytes"`
	CgroupMemoryBytes      Metric `json:"cgroupMemoryBytes"`
	AcceleratorMemoryBytes Metric `json:"acceleratorMemoryBytes"`
}

type WorkerMetric struct {
	WorkerID                      string                     `json:"workerId"`
	State                         string                     `json:"state"`
	ProfileID                     *string                    `json:"profileId"`
	JobID                         *string                    `json:"jobId"`
	CPUPercent                    Metric                     `json:"cpuPercent"`
	UnifiedMemoryBytes            Metric                     `json:"unifiedMemoryBytes"`
	AcceleratorUtilizationPercent Metric                     `json:"acceleratorUtilizationPercent"`
	Cgroup                        *WorkerCgroupMemoryMetric  `json:"cgroup,omitempty"`
	Process                       *WorkerProcessMemoryMetric `json:"process,omitempty"`
	Engine                        WorkerEngineMemoryMetric   `json:"engine"`
	Runtime                       WorkerRuntimeMemoryMetric  `json:"runtime"`
}

type WorkerCgroupMemoryEvents struct {
	High         int64 `json:"high"`
	Max          int64 `json:"max"`
	OOM          int64 `json:"oom"`
	OOMKill      int64 `json:"oomKill"`
	OOMGroupKill int64 `json:"oomGroupKill"`
}

type WorkerCgroupMemoryMetric struct {
	CurrentBytes      int64                    `json:"currentBytes"`
	InactiveFileBytes *int64                   `json:"inactiveFileBytes,omitempty"`
	PeakBytes         int64                    `json:"peakBytes"`
	MaximumBytes      any                      `json:"maximumBytes"`
	Events            WorkerCgroupMemoryEvents `json:"events"`
}

type WorkerProcessMemoryMetric struct {
	ResidentBytes int64 `json:"residentBytes"`
}

type WorkerEngineMemoryMetric struct {
	Status                 string  `json:"status"`
	ReasonCode             *string `json:"reasonCode"`
	AllocatedBytes         *int64  `json:"allocatedBytes"`
	ModelBytes             *int64  `json:"modelBytes"`
	CacheBytes             *int64  `json:"cacheBytes"`
	CertifiedEnvelopeBytes *int64  `json:"certifiedEnvelopeBytes"`
}

type WorkerRuntimeMemoryMetric struct {
	Status     string  `json:"status"`
	ReasonCode *string `json:"reasonCode"`
	OOMKilled  *bool   `json:"oomKilled"`
}

type ModelMetric struct {
	ProfileID          string  `json:"profileId"`
	State              string  `json:"state"`
	WorkerID           *string `json:"workerId"`
	UnifiedMemoryBytes Metric  `json:"unifiedMemoryBytes"`
	LoadMilliseconds   Metric  `json:"loadMilliseconds"`
}

type QueueReason struct {
	ReasonCode string `json:"reasonCode"`
	Count      int64  `json:"count"`
}

type QueueMetric struct {
	QueueKey               string        `json:"queueKey"`
	Depth                  Metric        `json:"depth"`
	OldestWaitMilliseconds Metric        `json:"oldestWaitMilliseconds"`
	Reasons                []QueueReason `json:"reasons"`
}

type CoreServiceMetric struct {
	ServiceKey          string `json:"serviceKey"`
	State               string `json:"state"`
	AvailabilityPercent Metric `json:"availabilityPercent"`
	LatencyMilliseconds Metric `json:"latencyMilliseconds"`
	ErrorRatePercent    Metric `json:"errorRatePercent"`
}

type MetricSnapshot struct {
	SchemaVersion int64  `json:"schemaVersion"`
	ObservedAt    string `json:"observedAt"`
	Sequence      int64  `json:"sequence"`
	Collector     struct {
		AgentVersion string `json:"agentVersion"`
		BootID       string `json:"bootId"`
	} `json:"collector"`
	Domains        MetricDomains        `json:"domains"`
	MemoryPressure MemoryPressureMetric `json:"memoryPressure"`
	Processes      []ProcessMetric      `json:"processes"`
	Workers        []WorkerMetric       `json:"workers"`
	Models         []ModelMetric        `json:"models"`
	Jobs           map[string]Metric    `json:"jobs"`
	Queues         []QueueMetric        `json:"queues"`
	Reservations   map[string]Metric    `json:"reservations"`
	CoreServices   []CoreServiceMetric  `json:"coreServices"`
}

type MetricResponse struct {
	NodeID         string `json:"nodeId"`
	NodeGeneration int64  `json:"nodeGeneration"`
	Sequence       int64  `json:"sequence"`
	ObservedAt     string `json:"observedAt"`
	ReceivedAt     string `json:"receivedAt"`
	SnapshotDigest string `json:"snapshotDigest"`
}

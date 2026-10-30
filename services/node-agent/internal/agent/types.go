package agent

import (
	"context"
	"encoding/json"
	"time"
)

type CommandEnvelope struct {
	ProtocolVersion int             `json:"protocolVersion"`
	CommandID       string          `json:"commandId"`
	NodeID          string          `json:"nodeId"`
	NodeGeneration  int64           `json:"nodeGeneration"`
	Type            string          `json:"type"`
	IssuedAt        time.Time       `json:"issuedAt"`
	DeadlineAt      time.Time       `json:"deadlineAt"`
	CorrelationID   string          `json:"correlationId,omitempty"`
	LeaseID         string          `json:"leaseId,omitempty"`
	FencingToken    uint64          `json:"fencingToken,omitempty"`
	Idempotency     string          `json:"idempotency"`
	Payload         json.RawMessage `json:"payload"`
}

type AuthProof struct {
	KeyID      string
	Nonce      string
	Signature  string
	SignedBody []byte
}

type CommandResult struct {
	CommandID      string          `json:"commandId"`
	NodeID         string          `json:"nodeId"`
	NodeGeneration int64           `json:"nodeGeneration"`
	Type           string          `json:"type"`
	Status         string          `json:"status"`
	FencingToken   uint64          `json:"fencingToken,omitempty"`
	WorkerID       string          `json:"workerId,omitempty"`
	ContainerID    string          `json:"containerId,omitempty"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	ErrorCode      string          `json:"errorCode,omitempty"`
	Retryable      bool            `json:"retryable"`
	CompletedAt    time.Time       `json:"completedAt"`
	CorrelationID  string          `json:"correlationId,omitempty"`
}

type ResourceLimits struct {
	MemoryBytes       int64 `json:"memoryBytes"`
	CPUQuotaMicros    int64 `json:"cpuQuotaMicros"`
	PidsLimit         int64 `json:"pidsLimit"`
	EphemeralBytes    int64 `json:"ephemeralBytes"`
	SharedMemoryBytes int64 `json:"sharedMemoryBytes,omitempty"`
	WorkspaceBytes    int64 `json:"workspaceQuotaBytes,omitempty"`
	OpenFilesLimit    int64 `json:"openFilesLimit"`
}

type SecurityProfile struct {
	RunAsUID        uint32 `json:"runAsUid"`
	RunAsGID        uint32 `json:"runAsGid"`
	ReadOnlyRoot    bool   `json:"readOnlyRoot"`
	DropAllCaps     bool   `json:"dropAllCapabilities"`
	NoNewPrivileges bool   `json:"noNewPrivileges"`
	Privileged      bool   `json:"privileged"`
	HostPID         bool   `json:"hostPid"`
	HostIPC         bool   `json:"hostIpc"`
	HostNetwork     bool   `json:"hostNetwork"`
	DockerSocket    bool   `json:"dockerSocket"`
	SeccompProfile  string `json:"seccompProfile,omitempty"`
}

type VolumeMount struct {
	Type     string `json:"type"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly"`
}

// ContainerHealthCheck is the exact create-time health contract used when a
// protected image does not carry an adequate OCI/Docker HEALTHCHECK.  Durations
// are nanoseconds because that is the Docker Engine API representation.  A nil
// value means that the immutable image healthcheck must be present and is used
// unchanged; it never means that a protected Worker may be considered healthy
// from its process state or container name alone.
type ContainerHealthCheck struct {
	Test        []string `json:"test"`
	Interval    int64    `json:"intervalNanoseconds"`
	Timeout     int64    `json:"timeoutNanoseconds"`
	StartPeriod int64    `json:"startPeriodNanoseconds"`
	Retries     int      `json:"retries"`
}

type PublishedPort struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
	HostIP        string `json:"hostIp"`
}

type WorkerStartPayload struct {
	WorkerID              string                `json:"workerId"`
	OwnerIdentityID       string                `json:"ownerIdentityId,omitempty"`
	SandboxKey            string                `json:"sandboxKey,omitempty"`
	AttemptID             string                `json:"attemptId"`
	ModelProfileID        string                `json:"modelProfileId"`
	WorkloadKind          string                `json:"workloadKind,omitempty"`
	PluginID              string                `json:"pluginId,omitempty"`
	Image                 string                `json:"image"`
	Network               string                `json:"network"`
	NetworkPolicyID       string                `json:"networkPolicyId,omitempty"`
	APIScopes             []string              `json:"apiScopes,omitempty"`
	EgressHosts           []string              `json:"egressHosts,omitempty"`
	Limits                ResourceLimits        `json:"limits"`
	Security              SecurityProfile       `json:"security"`
	Mounts                []VolumeMount         `json:"mounts,omitempty"`
	PublishedPorts        []PublishedPort       `json:"publishedPorts,omitempty"`
	ApplicationPort       int                   `json:"applicationPort,omitempty"`
	Devices               []string              `json:"devices,omitempty"`
	Environment           map[string]string     `json:"environment,omitempty"`
	Entrypoint            []string              `json:"entrypoint,omitempty"`
	Command               []string              `json:"command,omitempty"`
	HealthCommand         []string              `json:"healthCommand,omitempty"`
	HealthCheck           *ContainerHealthCheck `json:"healthCheck,omitempty"`
	TmpfsExecutable       bool                  `json:"tmpfsExecutable,omitempty"`
	PlacementClass        string                `json:"placementClass,omitempty"`
	MaintenanceGeneration int64                 `json:"maintenanceGeneration,omitempty"`
	ConfigDigest          string                `json:"configDigest,omitempty"`
}

type WorkerStopPayload struct {
	WorkerID           string `json:"workerId"`
	GracePeriodSeconds int    `json:"gracePeriodSeconds"`
	ApplicationOnly    bool   `json:"applicationOnly,omitempty"`
	RuntimeGeneration  int64  `json:"runtimeGeneration,omitempty"`
}

type WorkerHealthPayload struct {
	WorkerID          string `json:"workerId"`
	RuntimeGeneration int64  `json:"runtimeGeneration,omitempty"`
}

type WorkerControlPayload struct {
	WorkerID          string          `json:"workerId"`
	Request           json.RawMessage `json:"request"`
	RuntimeGeneration int64           `json:"runtimeGeneration,omitempty"`
}

type ApplicationFetchPayload struct {
	WorkerID          string `json:"workerId"`
	Method            string `json:"method"`
	Path              string `json:"path"`
	RuntimeGeneration int64  `json:"runtimeGeneration,omitempty"`
}

type ApplicationContent struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

type ExclusiveConflictListPayload struct {
	ExclusiveJobID string `json:"exclusiveJobId"`
}

type ExclusiveConflictWorkerPayload struct {
	ExclusiveJobID string `json:"exclusiveJobId"`
	TargetKey      string `json:"targetKey"`
}

type ExclusiveDrainTarget struct {
	TargetKey               string                        `json:"targetKey"`
	WorkerID                string                        `json:"workerId,omitempty"`
	ModelProfileID          string                        `json:"modelProfileId,omitempty"`
	ContainerName           string                        `json:"containerName"`
	PlacementClass          string                        `json:"placementClass,omitempty"`
	MaintenanceGeneration   int64                         `json:"maintenanceGeneration,omitempty"`
	StageOrder              int                           `json:"stageOrder,omitempty"`
	DependsOnWorkerIDs      []string                      `json:"dependsOnWorkerIds,omitempty"`
	RequiredImageID         string                        `json:"requiredImageId,omitempty"`
	RequiredImageDigest     string                        `json:"requiredImageDigest,omitempty"`
	RequiredConfigDigest    string                        `json:"requiredConfigDigest,omitempty"`
	RequiredStartSpecDigest string                        `json:"requiredStartSpecDigest,omitempty"`
	RequiredLabels          map[string]string             `json:"requiredLabels"`
	DependentContainers     []ExclusiveDependentContainer `json:"dependentContainers,omitempty"`
}

// LegacyContainerIdentity is a one-time, immutable allowlist entry for a
// pre-Node-Agent container. ContainerID is the full Docker object identity;
// RequiredImageID is the local image configuration ID, while
// RequiredImageReference is the exact Config.Image string. They are separate
// fields on purpose: neither an OCI manifest digest nor a mutable source tag is
// accepted as evidence for the other.
type LegacyContainerIdentity struct {
	ContainerName             string            `json:"containerName"`
	ContainerID               string            `json:"containerId"`
	RequiredImageID           string            `json:"requiredImageId"`
	RequiredImageReference    string            `json:"requiredImageReference"`
	RequiredNetworkMode       string            `json:"requiredNetworkMode"`
	RequiredRuntimeDigest     string            `json:"requiredRuntimeDigest"`
	RequiredMounts            []VolumeMount     `json:"requiredMounts"`
	RequiredEnvironmentDigest string            `json:"requiredEnvironmentDigest"`
	RequiredCommandDigest     string            `json:"requiredCommandDigest"`
	RequiredHealthcheckDigest string            `json:"requiredHealthcheckDigest"`
	RequiredLabels            map[string]string `json:"requiredLabels"`
}

// LegacyProtectedTransitionTarget binds the exact legacy Worker and any
// lifecycle-coupled companions that must be stopped first, retained as stopped
// rollback objects, and restored in reverse on failure. It is deliberately
// distinct from ExclusiveDrainTarget because legacy containers do not have
// canonical Worker or protected-placement labels.
type LegacyProtectedTransitionTarget struct {
	Primary             LegacyContainerIdentity   `json:"primary"`
	DependentContainers []LegacyContainerIdentity `json:"dependentContainers,omitempty"`
}

// ProtectedCompanionStartPayload is the bounded create contract for a
// non-Worker Provider which must be created together with a canonical protected
// Worker. In particular, an OCR Provider must use the stable compute-internal
// bridge and service discovery; container:<worker-id> network namespaces are
// rejected for successor identities.
type ProtectedCompanionStartPayload struct {
	ContainerName   string                `json:"containerName"`
	ParentWorkerID  string                `json:"parentWorkerId"`
	Image           string                `json:"image"`
	RequiredImageID string                `json:"requiredImageId"`
	ConfigDigest    string                `json:"configDigest"`
	Network         string                `json:"network"`
	Limits          ResourceLimits        `json:"limits"`
	Security        SecurityProfile       `json:"security"`
	Mounts          []VolumeMount         `json:"mounts,omitempty"`
	PublishedPorts  []PublishedPort       `json:"publishedPorts,omitempty"`
	Environment     map[string]string     `json:"environment,omitempty"`
	Command         []string              `json:"command,omitempty"`
	HealthCheck     *ContainerHealthCheck `json:"healthCheck,omitempty"`
	RequiredLabels  map[string]string     `json:"requiredLabels"`
}

// LegacyProtectedSetMigrationTarget is loaded only from the local immutable
// migration plan. It binds a desired canonical Worker start specification and
// companion specifications to the exact legacy rollback identity.
type LegacyProtectedSetMigrationTarget struct {
	TargetKey              string                           `json:"targetKey"`
	DesiredWorkerID        string                           `json:"desiredWorkerId"`
	DesiredStartSpecDigest string                           `json:"desiredStartSpecDigest"`
	LegacyPreviousTarget   LegacyProtectedTransitionTarget  `json:"legacyPreviousTarget"`
	DesiredCompanions      []ProtectedCompanionStartPayload `json:"desiredCompanions,omitempty"`
}

// ProtectedSetTransitionFaultInjection is a one-shot, policy-bound test
// boundary. Both a root-owned migration or canonical qualification policy and
// the signed transition command must contain the exact same value. Ordinary
// transitions can never select it.
type ProtectedSetTransitionFaultInjection struct {
	StageOrder     int    `json:"stageOrder"`
	TargetKey      string `json:"targetKey"`
	InjectionPoint string `json:"injectionPoint"`
	FailureCode    string `json:"failureCode"`
	OneShot        bool   `json:"oneShot"`
}

type LegacyProtectedSetMigrationPolicy struct {
	SchemaVersion    int                                  `json:"schemaVersion"`
	NodeID           string                               `json:"nodeId"`
	NodeGeneration   int64                                `json:"nodeGeneration"`
	PlanID           string                               `json:"planId"`
	SetID            string                               `json:"setId"`
	SourceSetDigest  string                               `json:"sourceSetDigest"`
	DesiredSetDigest string                               `json:"desiredSetDigest"`
	FaultInjection   ProtectedSetTransitionFaultInjection `json:"faultInjection"`
	SourceDigest     string                               `json:"-"`
	Targets          []LegacyProtectedSetMigrationTarget  `json:"targets"`
}

// ProtectedSetQualificationPolicy is a separate, root-owned authority for a
// one-shot fault at an exact stage of the already-canonical protected set. It
// deliberately does not authorize legacy identities, companions, or any
// target-policy change.
type ProtectedSetQualificationPolicy struct {
	SchemaVersion               int                                  `json:"schemaVersion"`
	NodeID                      string                               `json:"nodeId"`
	NodeGeneration              int64                                `json:"nodeGeneration"`
	QualificationID             string                               `json:"qualificationId"`
	SetID                       string                               `json:"setId"`
	ProtectedTargetPolicyDigest string                               `json:"protectedTargetPolicyDigest"`
	FaultInjection              ProtectedSetTransitionFaultInjection `json:"faultInjection"`
	SourceDigest                string                               `json:"-"`
}

// ExclusiveDependentContainer is a non-Worker service whose lifecycle is tied
// to a drained Worker.  It is stopped before the Worker and restarted after it,
// which is required for containers sharing the Worker's network namespace.
type ExclusiveDependentContainer struct {
	ContainerName           string            `json:"containerName"`
	RequiredStartSpecDigest string            `json:"requiredStartSpecDigest,omitempty"`
	RequiredImageID         string            `json:"requiredImageId,omitempty"`
	RequiredImageDigest     string            `json:"requiredImageDigest,omitempty"`
	RequiredConfigDigest    string            `json:"requiredConfigDigest,omitempty"`
	RequiredLabels          map[string]string `json:"requiredLabels"`
}

type ExclusiveConflictState struct {
	WorkerID       string `json:"workerId"`
	ContainerName  string `json:"containerName"`
	State          string `json:"state"`
	Health         string `json:"health"`
	PlacementClass string `json:"placementClass,omitempty"`
	WasRunning     bool   `json:"wasRunning"`
	LeasesReleased bool   `json:"leasesReleased"`
}

const (
	PlacementWarmOptional      = "warm-optional"
	PlacementExclusiveBatch    = "exclusive-batch"
	PlacementProtectedResident = "protected-resident"

	ProtectedSetMaintenance     = "protected-set.maintenance"
	ProtectedMaintenanceStop    = "protected.stop"
	ProtectedMaintenanceRestore = "protected.restore"
	ProtectedMaintenanceVerify  = "protected.verify"

	// ProtectedSetTransition is a distinct, complete-set authority.  It is not
	// accepted by the ordinary Worker lifecycle or by the stop/restore-only
	// maintenance command.  The narrower command lets boot and successor
	// reconciliation create/remove only journal-bound protected identities.
	ProtectedSetTransition     = "protected-set.transition"
	ProtectedTransitionInspect = "protected.inspect"
	ProtectedTransitionStage   = "protected.stage"
	ProtectedTransitionVerify  = "protected.verify"
	ProtectedTransitionCommit  = "protected.commit"
)

func EffectivePlacementClass(value string) string {
	if value == "" {
		return PlacementWarmOptional
	}
	return value
}

func IsProtectedPlacement(value string) bool {
	return EffectivePlacementClass(value) == PlacementProtectedResident
}

// ProtectedControlRequestAllowed is deliberately an allowlist. Future worker
// protocol lifecycle operations therefore fail closed for a resident Worker
// until the Node Agent is explicitly taught that they are non-destructive.
func ProtectedControlRequestAllowed(requestType string) bool {
	switch requestType {
	case "worker.prepare.request", "worker.object.begin.request", "worker.object.chunk.request",
		"worker.object.commit.request", "worker.object.discard.request", "worker.execute.request", "worker.cancel.request":
		return true
	default:
		return false
	}
}

// ProtectedMaintenancePayload is the only command payload allowed to stop a
// protected-resident target. The signed command envelope and this payload bind
// the same short-lived transaction window, while the policy file binds every
// target and dependency to its prior healthy image/config identity.
type ProtectedMaintenancePayload struct {
	TransactionID         string                 `json:"transactionId"`
	WorkerIDs             []string               `json:"workerIds"`
	AllowedOperations     []string               `json:"allowedOperations"`
	OperationOrder        []string               `json:"operationOrder"`
	MaintenanceGeneration int64                  `json:"maintenanceGeneration"`
	IssuedAt              time.Time              `json:"issuedAt"`
	ExpiresAt             time.Time              `json:"expiresAt"`
	JournalRevision       int64                  `json:"journalRevision"`
	Targets               []ExclusiveDrainTarget `json:"targets"`
}

type ProtectedMaintenanceTargetState struct {
	Target       ExclusiveConflictState   `json:"target"`
	Dependencies []ExclusiveConflictState `json:"dependencies"`
}

type ProtectedMaintenanceJournalState struct {
	TransactionID         string    `json:"transactionId"`
	MaintenanceGeneration int64     `json:"maintenanceGeneration"`
	JournalRevision       int64     `json:"journalRevision"`
	Phase                 string    `json:"phase"`
	NextOperation         int       `json:"nextOperation"`
	PlanDigest            string    `json:"planDigest"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

// ProtectedSetTransitionTarget binds both sides of one declarative protected
// resident cutover. PreviousTarget is nil only when the exact Worker was
// absent before the transaction.  DesiredWorker is the complete policy-
// validated create request; DesiredTarget pins the actual local image ID,
// configuration and dependent companion identities that must become healthy.
// A non-nil previous target is kept as an exact stopped rollback container
// until every desired member has passed its warm/health probe.
type ProtectedSetTransitionTarget struct {
	DesiredWorker        WorkerStartPayload               `json:"desiredWorker"`
	DesiredTarget        ExclusiveDrainTarget             `json:"desiredTarget"`
	PreviousTarget       *ExclusiveDrainTarget            `json:"previousTarget,omitempty"`
	LegacyPreviousTarget *LegacyProtectedTransitionTarget `json:"legacyPreviousTarget,omitempty"`
	DesiredCompanions    []ProtectedCompanionStartPayload `json:"desiredCompanions,omitempty"`
}

// ProtectedSetTransitionPayload is accepted only as one bounded, signed,
// fenced command over the complete current protected policy set.  Targets are
// dependency-first; rollback is therefore their exact reverse.
type ProtectedSetTransitionPayload struct {
	TransactionID         string                                `json:"transactionId"`
	SetID                 string                                `json:"setId"`
	DesiredStateRevision  int64                                 `json:"desiredStateRevision"`
	WorkerIDs             []string                              `json:"workerIds"`
	AllowedOperations     []string                              `json:"allowedOperations"`
	OperationOrder        []string                              `json:"operationOrder"`
	MaintenanceGeneration int64                                 `json:"maintenanceGeneration"`
	IssuedAt              time.Time                             `json:"issuedAt"`
	ExpiresAt             time.Time                             `json:"expiresAt"`
	JournalRevision       int64                                 `json:"journalRevision"`
	MigrationPlanID       string                                `json:"migrationPlanId,omitempty"`
	MigrationPlanDigest   string                                `json:"migrationPlanDigest,omitempty"`
	QualificationID       string                                `json:"qualificationId,omitempty"`
	QualificationDigest   string                                `json:"qualificationDigest,omitempty"`
	FaultInjection        *ProtectedSetTransitionFaultInjection `json:"faultInjection,omitempty"`
	Targets               []ProtectedSetTransitionTarget        `json:"targets"`
}

type ProtectedSetTransitionJournalState struct {
	TransactionID              string    `json:"transactionId"`
	SetID                      string    `json:"setId"`
	DesiredStateRevision       int64     `json:"desiredStateRevision"`
	MaintenanceGeneration      int64     `json:"maintenanceGeneration"`
	JournalRevision            int64     `json:"journalRevision"`
	Phase                      string    `json:"phase"`
	NextOperation              int       `json:"nextOperation"`
	PlanDigest                 string    `json:"planDigest"`
	FailureCode                string    `json:"failureCode,omitempty"`
	FaultInjectionConsumed     bool      `json:"faultInjectionConsumed,omitempty"`
	FaultInjectionStageOrder   int       `json:"faultInjectionStageOrder,omitempty"`
	FaultInjectionTargetKey    string    `json:"faultInjectionTargetKey,omitempty"`
	FaultInjectionAfterHealthy bool      `json:"faultInjectionAfterHealthy,omitempty"`
	UpdatedAt                  time.Time `json:"updatedAt"`
}

// ProtectedSetTransitionInspectionPayload is a read-only, migration-bound
// request for one already-durable transition.  It cannot select containers or
// Docker operations: the root-owned migration plan and fsynced journal select
// the complete target set.
type ProtectedSetTransitionInspectionPayload struct {
	InspectionID        string `json:"inspectionId"`
	TransactionID       string `json:"transactionId"`
	MigrationPlanID     string `json:"migrationPlanId,omitempty"`
	MigrationPlanDigest string `json:"migrationPlanDigest,omitempty"`
	QualificationID     string `json:"qualificationId,omitempty"`
	QualificationDigest string `json:"qualificationDigest,omitempty"`
	Mode                string `json:"mode"`
}

// ProtectedSetTransitionContainerSnapshot is a redacted projection of an
// exact plan-bound Docker inspect document.  It deliberately omits commands,
// environment values, mounts, labels, ports, and host paths.
type ProtectedSetTransitionContainerSnapshot struct {
	ContainerName       string `json:"containerName"`
	ContainerID         string `json:"containerId"`
	ImageReference      string `json:"imageReference"`
	ImageID             string `json:"imageId"`
	ImageManifestDigest string `json:"imageManifestDigest,omitempty"`
	RuntimeDigest       string `json:"runtimeDigest"`
	NetworkMode         string `json:"networkMode"`
	State               string `json:"state"`
	Health              string `json:"health"`
	StartSpecDigest     string `json:"startSpecDigest,omitempty"`
	OOMKilled           bool   `json:"oomKilled"`
	Exact               bool   `json:"exact"`
}

type ProtectedSetTransitionTargetSnapshot struct {
	TargetKey                string                                    `json:"targetKey"`
	StageOrder               int                                       `json:"stageOrder"`
	WorkerID                 string                                    `json:"workerId"`
	ModelProfileID           string                                    `json:"modelProfileId"`
	RuntimeState             string                                    `json:"runtimeState"`
	Desired                  *ProtectedSetTransitionContainerSnapshot  `json:"desired,omitempty"`
	CanonicalPrevious        *ProtectedSetTransitionContainerSnapshot  `json:"canonicalPrevious,omitempty"`
	CanonicalDependents      []ProtectedSetTransitionContainerSnapshot `json:"canonicalDependents,omitempty"`
	DesiredCompanions        []ProtectedSetTransitionContainerSnapshot `json:"desiredCompanions"`
	LegacyPrimary            *ProtectedSetTransitionContainerSnapshot  `json:"legacyPrimary,omitempty"`
	LegacyDependents         []ProtectedSetTransitionContainerSnapshot `json:"legacyDependents"`
	MountsExact              bool                                      `json:"mountsExact"`
	ReadOnlyModelMount       bool                                      `json:"readOnlyModelMount"`
	ModelMaterialMode        string                                    `json:"modelMaterialMode"`
	HealthcheckExact         bool                                      `json:"healthcheckExact"`
	RuntimeLimitsExact       bool                                      `json:"runtimeLimitsExact"`
	LegacyHostNetworkRemoved bool                                      `json:"legacyHostNetworkRemoved"`
	TmpfsExecutable          bool                                      `json:"tmpfsExecutable"`
}

// ProtectedSetTransitionInspection is assembled from the durable coordinator
// journal and fresh, exact Docker identity checks.  It contains no caller-
// supplied facts and carries no mutation authority.
type ProtectedSetTransitionInspection struct {
	SchemaVersion                int                                    `json:"schemaVersion"`
	ReadOnly                     bool                                   `json:"readOnly"`
	MutationCount                int                                    `json:"mutationCount"`
	NodeID                       string                                 `json:"nodeId"`
	NodeGeneration               int64                                  `json:"nodeGeneration"`
	TransactionID                string                                 `json:"transactionId"`
	SetID                        string                                 `json:"setId"`
	MigrationPlanID              string                                 `json:"migrationPlanId,omitempty"`
	MigrationPlanDigest          string                                 `json:"migrationPlanDigest,omitempty"`
	QualificationID              string                                 `json:"qualificationId,omitempty"`
	QualificationDigest          string                                 `json:"qualificationDigest,omitempty"`
	ProtectedTargetPolicyDigest  string                                 `json:"protectedTargetPolicyDigest,omitempty"`
	SourceSetDigest              string                                 `json:"sourceSetDigest,omitempty"`
	DesiredSetDigest             string                                 `json:"desiredSetDigest,omitempty"`
	RuntimeState                 string                                 `json:"runtimeState"`
	Journal                      ProtectedSetTransitionJournalState     `json:"journal"`
	Targets                      []ProtectedSetTransitionTargetSnapshot `json:"targets"`
	RollbackTargetKeys           []string                               `json:"rollbackTargetKeys"`
	CanonicalContainersRemaining []string                               `json:"canonicalContainersRemaining"`
	RollbackContainersRemaining  []string                               `json:"rollbackContainersRemaining"`
	TransitionHelpersRemaining   []string                               `json:"transitionHelpersRemaining"`
	OOMKilled                    bool                                   `json:"oomKilled"`
	RestartPersistenceObserved   bool                                   `json:"restartPersistenceObserved"`
}

// MaintenancePreflightPayload is deliberately read-only. It lets the control
// plane ask the Node Agent for closed host/runtime facts without granting it an
// arbitrary command, package-manager, or Docker API proxy.
type MaintenancePreflightPayload struct {
	PlanID                            string   `json:"planId"`
	Kind                              string   `json:"kind"`
	CandidateDigest                   string   `json:"candidateDigest"`
	ExpectedArchitecture              string   `json:"expectedArchitecture"`
	MinimumDockerAPIVersion           string   `json:"minimumDockerApiVersion"`
	RequireNvidiaContainerIntegration bool     `json:"requireNvidiaContainerIntegration"`
	AllowedSecureBootStates           []string `json:"allowedSecureBootStates"`
}

type MaintenancePreflightEvidence struct {
	PlanID                              string   `json:"planId"`
	NodeID                              string   `json:"nodeId"`
	NodeGeneration                      int64    `json:"nodeGeneration"`
	Passed                              bool     `json:"passed"`
	Blockers                            []string `json:"blockers"`
	Warnings                            []string `json:"warnings"`
	Architecture                        string   `json:"architecture"`
	DockerVersion                       string   `json:"dockerVersion"`
	DockerAPIVersion                    string   `json:"dockerApiVersion"`
	KernelVersion                       string   `json:"kernelVersion"`
	OperatingSystem                     string   `json:"operatingSystem"`
	SecureBootState                     string   `json:"secureBootState"`
	NvidiaContainerIntegrationAvailable bool     `json:"nvidiaContainerIntegrationAvailable"`
	NvidiaContainerIntegrationMode      string   `json:"nvidiaContainerIntegrationMode"`
	ActiveManagedWorkloads              int      `json:"activeManagedWorkloads"`
	EvidenceDigest                      string   `json:"evidenceDigest"`
}

type SandboxFileProjectPayload struct {
	WorkerID        string    `json:"workerId"`
	OwnerIdentityID string    `json:"ownerIdentityId"`
	SandboxKey      string    `json:"sandboxKey"`
	FileClass       string    `json:"fileClass"`
	ContentBase64   string    `json:"contentBase64"`
	ContentSHA256   string    `json:"contentSha256"`
	TokenID         string    `json:"tokenId,omitempty"`
	ExpiresAt       time.Time `json:"expiresAt,omitempty"`
}

type SandboxFileProjection struct {
	WorkerID        string
	OwnerIdentityID string
	SandboxKey      string
	FileClass       string
	ContentSHA256   string
	TokenID         string
	ExpiresAt       time.Time
	Contents        []byte
}

type SandboxFileState struct {
	WorkerID      string `json:"workerId"`
	FileClass     string `json:"fileClass"`
	ContentSHA256 string `json:"contentSha256"`
	Bytes         int    `json:"bytes"`
}

type WorkerState struct {
	WorkerID              string    `json:"workerId"`
	ModelProfileID        string    `json:"modelProfileId,omitempty"`
	ContainerID           string    `json:"containerId"`
	Status                string    `json:"status"`
	Health                string    `json:"health"`
	Image                 string    `json:"image"`
	PlacementClass        string    `json:"placementClass,omitempty"`
	MaintenanceGeneration int64     `json:"maintenanceGeneration,omitempty"`
	ConfigDigest          string    `json:"configDigest,omitempty"`
	StartedAt             time.Time `json:"startedAt,omitempty"`
}

type ApplianceInspectPayload struct {
	InspectionID string `json:"inspectionId"`
}

type ApplianceIdentity struct {
	NodeID                      string            `json:"nodeId"`
	NodeGeneration              int64             `json:"nodeGeneration"`
	ImageDigest                 string            `json:"imageDigest"`
	ConfigurationDigest         string            `json:"configurationDigest"`
	BootID                      string            `json:"bootId"`
	CertificateFingerprint      string            `json:"certificateFingerprint"`
	Healthy                     bool              `json:"healthy"`
	RuntimeIdentities           []json.RawMessage `json:"runtimeIdentities"`
	ProtectedTargetPolicyDigest string            `json:"protectedTargetPolicyDigest,omitempty"`
}

// ProtectedOfficeInspectionRuntime only inspects targets already installed in
// the Agent policy. A command cannot supply a container name or runtime spec.
type ProtectedOfficeInspectionRuntime interface {
	InspectProtectedOfficeProfile(context.Context, ExclusiveDrainTarget, Ownership) (WorkerState, error)
}

type ProtectedOfficeRuntimeIdentity struct {
	WorkerState
	IdentityExact bool   `json:"identityExact"`
	ErrorCode     string `json:"errorCode,omitempty"`
}

type WorkerEvent struct {
	ProtocolVersion int             `json:"protocolVersion"`
	EventID         string          `json:"eventId"`
	Sequence        uint64          `json:"sequence"`
	NodeID          string          `json:"nodeId"`
	WorkerID        string          `json:"workerId,omitempty"`
	AttemptID       string          `json:"attemptId,omitempty"`
	LeaseID         string          `json:"leaseId,omitempty"`
	FencingToken    uint64          `json:"fencingToken,omitempty"`
	Type            string          `json:"type"`
	OccurredAt      time.Time       `json:"occurredAt"`
	CorrelationID   string          `json:"correlationId,omitempty"`
	Payload         json.RawMessage `json:"payload"`
}

type Runtime interface {
	StartWorker(ctx context.Context, spec WorkerStartPayload, ownership Ownership) (WorkerState, error)
	StopWorker(ctx context.Context, workerID string, gracePeriodSeconds int, ownership Ownership) (WorkerState, error)
	WorkerHealth(ctx context.Context, workerID string, ownership Ownership) (WorkerState, error)
	FetchApplication(ctx context.Context, payload ApplicationFetchPayload, ownership Ownership) (ApplicationContent, error)
	ProjectSandboxFile(ctx context.Context, projection SandboxFileProjection, ownership Ownership) (SandboxFileState, error)
}

// WorkerControlRuntime is intentionally separate from Runtime. A runtime must
// explicitly implement the bounded, ownership-checked internal-network proxy
// before the public command service will accept worker-control requests.
type WorkerControlRuntime interface {
	ForwardWorkerControl(ctx context.Context, payload WorkerControlPayload, ownership Ownership) (json.RawMessage, error)
}

// ExclusiveDrainRuntime is intentionally separate from Runtime so a runtime
// without the appliance-only, fixed-target drain boundary fails closed.
type ExclusiveDrainRuntime interface {
	ListExclusiveConflicts(ctx context.Context, targets []ExclusiveDrainTarget) ([]ExclusiveConflictState, error)
	DrainExclusiveConflict(ctx context.Context, target ExclusiveDrainTarget) (ExclusiveConflictState, error)
	RestoreExclusiveConflict(ctx context.Context, target ExclusiveDrainTarget) (ExclusiveConflictState, error)
}

// MaintenancePreflightRuntime is intentionally separate from Runtime. Only
// the appliance-owned implementation may observe the bounded host facts used
// by a platform/host maintenance plan.
type MaintenancePreflightRuntime interface {
	InspectMaintenancePreflight(ctx context.Context, payload MaintenancePreflightPayload, ownership Ownership) (MaintenancePreflightEvidence, error)
}

// ProtectedMaintenanceRuntime deliberately exposes no arbitrary container
// mutation. It can only inspect, stop, restore, and verify the exact immutable
// targets already admitted by the Node Agent's protected policy.
type ProtectedMaintenanceRuntime interface {
	InspectProtectedMaintenanceTarget(ctx context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error)
	StopProtectedMaintenanceTarget(ctx context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error)
	RestoreProtectedMaintenanceTarget(ctx context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error)
}

// ProtectedSetTransitionRuntime is deliberately transaction-specific.  It
// cannot address an arbitrary container: every method receives the exact
// desired/prior target pair that was policy-checked and fsynced first.  The
// backup name is deterministic from the transaction and never supplied by a
// caller.
type ProtectedSetTransitionRuntime interface {
	InspectProtectedSetTransitionTarget(ctx context.Context, target ProtectedSetTransitionTarget, rollbackContainerName string, requireDesired bool) error
	StageProtectedSetTransitionTarget(ctx context.Context, target ProtectedSetTransitionTarget, ownership Ownership, rollbackContainerName string) (WorkerState, error)
	RollbackProtectedSetTransitionTarget(ctx context.Context, target ProtectedSetTransitionTarget, ownership Ownership, rollbackContainerName string) error
	CommitProtectedSetTransitionTarget(ctx context.Context, target ProtectedSetTransitionTarget, ownership Ownership, rollbackContainerName string) error
}

// ProtectedSetTransitionInspectionRuntime is deliberately separate from the
// mutating transition runtime.  Implementations can only inspect the exact
// journal payload selected by the coordinator.
type ProtectedSetTransitionInspectionRuntime interface {
	InspectProtectedSetTransitionRuntime(ctx context.Context, payload ProtectedSetTransitionPayload, rollbackContainerNames []string, requireDesired bool) ([]ProtectedSetTransitionTargetSnapshot, error)
}

// ApplianceInspectionRuntime reports only this appliance's installed identity.
// It grants no deployment, transfer, enrollment or arbitrary mutation authority.
type ApplianceInspectionRuntime interface {
	InspectAppliance(ctx context.Context, ownership Ownership) (ApplianceIdentity, error)
}

type EventSink interface {
	Publish(event WorkerEvent) error
}

type Ownership struct {
	NodeID            string
	NodeGeneration    int64
	RuntimeGeneration int64
	ApplicationOnly   bool
	CommandID         string
	CommandDigest     string
	LeaseID           string
	FencingToken      uint64
	AttemptID         string
}

// Synthetic, local-only presentation data. Never imported by a production bundle.
// No credentials, media, VM controls or writes are provided by these fixtures.
const roms = [
  { id: 'synthetic-standard', familyId: 'aosp', name: '标准 Android', version: 'Android 17', googlePlay: false, experimental: false },
  { id: 'synthetic-google', familyId: 'google-experimental', name: 'Android + Google Play', version: 'Android 17', googlePlay: true, experimental: true },
].map(rom => ({ ...rom, cameraCapability: 'verified', createEnabled: true, reasonCode: null }));
const phones = ['演示工作手机', '移动应用测试'].map((name, i) => ({
  object: 'virtual_phone', id: `00000000-0000-4000-8000-00000000010${i}`, name,
  state: i ? 'stopped' : 'running', revision: 1, generation: 1, runningCharged: !i, rom: roms[i],
}));
const systems = [{ id: 'synthetic-windows', name: 'Windows 11', edition: '专业版', createEnabled: true, minimum: { vcpus: 2, memoryGiB: 8, diskGiB: 64 } }];
const computers = [{ id: '00000000-0000-4000-8000-000000000201', name: '设计工作电脑', state: 'running', revision: 1, system: systems[0], resources: { vcpus: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 128 * 1024 ** 3 } }];
const users = ['产品管理员', '陈玫', '林默'].map((displayName, i) => ({
  id: `00000000-0000-4000-8000-00000000030${i}`, identityKind: 'local_user', displayName,
  loginName: ['preview-admin', 'chenmei', 'linmo'][i], status: i === 2 ? 'disabled' : 'active',
  roles: [i ? 'member' : 'owner'], preferredLocale: 'zh-CN', preferredTheme: 'light',
  lastAuthenticatedAt: '2026-10-22T03:00:00Z', disabledAt: null, createdAt: null, updatedAt: null,
}));
const generatedAt = '2026-10-22T03:00:00Z';
const nodeId = '00000000-0000-4000-8000-000000000501';
const identityPage = { offset: 0, limit: 50, hasMore: false, total: 3, matching: 3 };
const quotas = users.map((user, i) => ({ ownerId: user.id, loginName: user.loginName, displayName: user.displayName, status: user.status, storedPerUser: null, runningPerUser: null, stored: i ? 0 : 2, running: i ? 0 : 1, revision: 1 }));
const phonePolicy = { enabled: true, revision: 1, storedPerUser: null, runningPerUser: null };
const node = { nodeId, nodeName: '本机设备 · 设计示例', address: '仅本地预览', configuredLimit: null, running: 1, runningCount: 1, reservedCount: 0, reasonCode: null, observedAt: generatedAt, ready: true, reservedMemoryBytes: 8 * 1024 ** 3 };
const pools = [{ poolId: 'synthetic-local-pool', displayName: '本机工作空间', backendKind: 'local-filesystem', nodeId, failureDomain: 'local', lifecycleState: 'active', healthState: 'healthy', totalBytes: 1024 ** 4, availableBytes: 780 * 1024 ** 3, safetyReserveBytes: 0, encryptionMode: 'luks2', encryptionStatus: 'verified', compatibilityStatus: 'verified', dataClasses: ['team-file', 'plugin-data', 'ai-artifact'], allocationCount: 3, allocatedBytes: 96 * 1024 ** 3, liveReservationCount: 0, liveReservationBytes: 0, incompleteMigrationCount: 0, observedAt: generatedAt, createdAt: generatedAt, updatedAt: generatedAt, removedAt: null }];
const queuePolicy = { policyKey: 'default', minimumPriority: 0, maximumPriority: 100, maxQueuedPerOwner: 0, maxActivePerOwner: 0, maxQueuedPerCapability: 0, maxDailySubmissionsPerOwner: 0, maxRequestBytes: 0, maxDeadlineSeconds: 0, revision: 1, updatedBy: null, createdAt: generatedAt, updatedAt: generatedAt };
const source = { sourceId: 'synthetic-source', sourceKey: 'npm.public', displayName: '团队软件缓存', ecosystem: 'npm', kind: 'proxy-cache', endpoint: { url: 'https://example.invalid/npm', networkZone: 'internal' }, priority: 10, packageScopes: ['*'], architectures: ['arm64'], trust: { checksumRequired: true, signaturePolicy: 'ecosystem', tlsRequired: true }, credentialConfigured: false, credentialSecretKey: null, onlineMode: 'auto', cache: { mode: 'read-through', maximumBytes: 0, ttlSeconds: 86400, retainVerified: true }, storagePoolId: pools[0].poolId, health: { state: 'healthy', latencyMilliseconds: 8, errorCode: null, observedAt: generatedAt }, enabled: true, revision: 1, updatedAt: generatedAt };
const modelProfile = { profileId: 'synthetic-assistant', profileKey: 'assistant.local', fingerprint: 'synthetic-preview-only', state: 'certified', revision: 1, reasonKey: 'validation_passed', evidenceRefs: [], validationRunId: null, updatedAt: generatedAt };
const modelCard = { schemaVersion: 1, generatedAt, profile: { ...modelProfile, sourceModel: '办公助手 · 设计示例', precision: '默认', artifactDigest: 'synthetic-preview-only', apiContracts: ['chat.completions'], limits: {}, resourceEnvelope: {}, exclusive: false }, lifecycle: modelProfile, compatibilityMatrix: [], validationRuns: [], comparisons: [], knownLimitations: [], routingRecommendation: { recommendationKey: 'production_ready', productionEligible: true, allowedEnvironments: ['production'], reasonKeys: [] }, rawRunLinks: [] };
const conversation = { id: '00000000-0000-4000-8000-000000000401', object: 'assistant.conversation', title: '整理产品发布会议', createdAt: '2026-10-22T03:00:00Z', updatedAt: '2026-10-22T03:02:00Z' };
const messages = ['把会议纪要整理成可以执行的行动清单。', '已将讨论整理为三个行动项：\n\n1. 陈玫：确认演示材料，周五前完成。\n2. 林默：汇总客户问题，补充使用说明。\n3. 项目负责人：核对发布清单并确认交付时间。\n\n相关文件保留在右侧，方便继续阅读和分享。'].map((content, i) => ({
  id: `00000000-0000-4000-8000-00000000041${i}`, conversationId: conversation.id, runId: 'synthetic-run', role: i ? 'assistant' : 'user', content,
  requestedMode: 'auto', effectiveMode: 'answer', status: 'completed',
  sources: i ? [{ referenceId: 'synthetic-source', label: '产品发布会议纪要', url: null }] : [],
  artifacts: i ? [{ referenceId: 'synthetic-artifact', label: '行动清单.md', mimeType: 'text/markdown', sizeBytes: 2048, downloadPath: null }] : [],
  toolCalls: [], routing: null, usage: null, error: null, createdAt: '2026-10-22T03:01:00Z', completedAt: '2026-10-22T03:02:00Z',
}));

export function precisionPreviewResponse(path, state = 'ready') {
  const empty = state === 'empty';
  switch (path) {
    case '/api/v1/assistant/conversations': return { data: empty ? [] : [conversation] };
    case `/api/v1/assistant/conversations/${conversation.id}`: return { ...conversation, messages, confirmations: [], eventCursor: 2 };
    case '/api/v1/virtual-phones': return { object: 'list', data: empty ? [] : phones, quota: { stored: empty ? 0 : 2, running: empty ? 0 : 1, storedPerUser: null, runningPerUser: null } };
    case '/api/v1/virtual-phones/availability': return { object: 'virtual_phone.availability', enabled: true, runtimeConfigured: true, roms, defaultRomVersionId: roms[0].id };
    case '/api/v1/virtual-computers': return { object: 'list', data: empty ? [] : computers };
    case '/api/v1/virtual-computers/availability': return { enabled: true, systems, limits: { maximum: { vcpus: null, memoryGiB: null, diskGiB: null } } };
    case '/api/v1/admin/users': return { data: empty ? [] : users, summary: { total: empty ? 0 : 3, active: empty ? 0 : 2, owners: empty ? 0 : 1, matching: empty ? 0 : 3 }, offset: 0, limit: 50, hasMore: false };
    case '/api/v1/admin/roles': return { roles: ['owner', 'member'].map(roleKey => ({ roleKey, displayNameKey: `role.${roleKey}`, descriptionKey: `role.${roleKey}.description`, systemRole: true, allowedScopes: ['global'], permissions: roleKey === 'owner' ? ['identity:manage', 'file:read', 'file:write'] : ['file:read'], bindingCount: roleKey === 'owner' ? 1 : 2 })), identities: empty ? [] : users, identityPage };
    case '/api/v1/admin/teams': return { teams: empty ? [] : [{ id: 'synthetic-team', teamKey: 'product', displayName: '产品设计组', status: 'active', systemTeam: false, memberCount: 2, members: users.slice(0, 2).map((identity, i) => ({ identity, roleKey: i ? 'member' : 'team_admin' })), updatedAt: generatedAt }], identities: empty ? [] : users, identityPage, membershipRoles: ['team_admin', 'member', 'guest'] };
    case '/api/v1/admin/virtual-phones': return { policy: phonePolicy, deploymentReady: true, contentAccessGranted: false, roms, nodes: [node] };
    case '/api/v1/admin/virtual-computers': return { policy: { ...phonePolicy, maximum: { vcpus: null, memoryGiB: null, diskGiB: null } }, systems, nodes: [node] };
    case '/api/v1/admin/virtual-phones/quotas':
    case '/api/v1/admin/virtual-computers/quotas': return { data: empty ? [] : quotas, nextCursor: null };
    case `/api/v1/admin/virtual-phones/nodes/${nodeId}/usb-cameras`: return { nodeId, data: [] };
    case `/api/v1/admin/virtual-phones/nodes/${nodeId}/network-cameras`: return { nodeId, addresses: [], data: [] };
    case '/api/v1/admin/storage/pools': return { schemaVersion: 1, generatedAt, dataClasses: pools[0].dataClasses, summary: { poolCount: 1, activePoolCount: 1, degradedPoolCount: 0, totalBytes: pools[0].totalBytes, availableBytes: pools[0].availableBytes, allocatedBytes: pools[0].allocatedBytes }, pools: empty ? [] : pools };
    case '/api/v1/admin/queues': return { schemaVersion: 1, generatedAt, policy: queuePolicy, summary: { totalJobs: 0, activeJobs: 0, activeLeases: 0, realtimeReservations: 0, exclusiveIntents: 0, oldestQueuedAt: null }, statusCounts: [], waitingReasons: [], priorityBands: [], jobs: [], realtimeReservations: [], exclusiveIntents: [] };
    case '/api/v1/admin/plugins': return { object: 'plugin_administration', architecture: 'linux/arm64/v8', supportedPluginTypes: ['ApplicationPlugin', 'ComputePlugin'], supportedSources: ['marketplace', 'private-registry', 'offline-bundle'], imports: [], plugins: empty ? [] : ['official.messaging', 'official.virtual-phones'].map(pluginId => ({ pluginId, pluginType: 'ApplicationPlugin', publisherId: 'official', protectedOfficial: true, lifecycleState: 'enabled', currentVersion: 'delivery-2026-10-22', activeSlot: 'blue', generation: 1, dataRetentionState: 'retained', versions: [], updatedAt: generatedAt })) };
    case '/api/v1/admin/encryption/status': return { schemaVersion: 1, generatedAt, blockEncryption: { configured: true, mode: 'luks2', status: 'verified' }, startupProtection: { enabled: false, mode: 'automatic' }, capabilities: { transition: true, webPassphrase: true, },  prerequisites: [{ key: 'recovery', state: 'passed' }], latestTransition: null, recentTransitions: [] };
    case '/api/v1/admin/source-center/overview': return { schemaVersion: 1, sourceCount: empty ? 0 : 1, policyCount: 0, byEcosystem: Object.fromEntries(['pip', 'npm', 'apt'].map(key => [key, { sources: key === 'npm' && !empty ? 1 : 0, enabled: key === 'npm' && !empty ? 1 : 0, healthy: key === 'npm' && !empty ? 1 : 0, offline: 0, policies: 0 }])) };
    case '/api/v1/admin/source-center/data-planes': return { schemaVersion: 1, state: 'ready', observedAt: generatedAt, errorCode: null, ecosystems: Object.fromEntries(['pip', 'npm', 'apt'].map(key => [key, { requests: 0, cacheHits: 0, upstreamFetches: 0, upstreamBytes: 0 }])) };
    case '/api/v1/admin/source-center/sources': return { data: empty ? [] : [source] };
    case '/api/v1/admin/source-center/policies':
    case '/api/v1/admin/source-center/offline-media': return { data: [] };
    case '/api/v1/admin/model-profiles': return { data: empty ? [] : [modelProfile] };
    case '/api/v1/admin/model-profiles/by-key/assistant.local/card': return modelCard;
    case '/api/v1/admin/routing-policies': return { data: [] };
    case '/api/v1/admin/model-routing-policies/validation.default/experimental-profiles': return { policyKey: 'validation.default', environment: 'validation', experimentalProfileIds: [] };
    default: return undefined;
  }
}

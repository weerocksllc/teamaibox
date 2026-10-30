/** Windows resource planning. Policy and profile constraints are supplied by
 * administration/catalogue; lab allocations must never become product limits.
 * The node owns exact operation identity. Configured CPU/RAM is not booked
 * against other workloads before launch.
 */
const GiB = 1024 ** 3;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
function invalid(message) { throw Object.assign(new Error(message), {code:'computer_resources_invalid'}); }

// Per-guest disk boundary only. This is never subtracted from shared free space.
export function computerDiskLimitBytes(resources,policy) {
  if(!positive(resources?.diskBytes)||!positive(policy?.storageOverheadBytes))invalid('缺少电脑存储开销配置。');
  const bytes=Math.ceil((resources.diskBytes+policy.storageOverheadBytes)/1024)*1024;
  if(!positive(bytes)||bytes<=resources.diskBytes)invalid('存储配置超出可表示范围。');
  return bytes;
}

export function validateComputerResources(input, {profile, policy}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !['vcpus','memoryGiB','diskGiB'].includes(k))) invalid('请选择 CPU、内存和磁盘容量。');
  for (const key of ['vcpus','memoryGiB','diskGiB']) {
    const label = {vcpus:'CPU 核',memoryGiB:'GiB 内存',diskGiB:'GiB 磁盘'}[key];
    if (!positive(input[key]) || !positive(profile?.minimum?.[key])) invalid('资源配置或系统要求无效。');
    if (input[key] < profile.minimum[key]) invalid(`所选系统至少需要 ${profile.minimum[key]} ${label}。`);
    const max = policy?.maximum?.[key];
    if (max != null && (!positive(max) || input[key] > max)) invalid(`超过管理员配置的上限：${max} ${label}。`);
  }
  if (!positive(input.memoryGiB * GiB) || !positive(input.diskGiB * GiB)) invalid('容量超出可表示范围。');
  return Object.freeze({vcpus:input.vcpus, memoryBytes:input.memoryGiB*GiB, diskBytes:input.diskGiB*GiB});
}

export function planComputerPlacement({resources, nodes, policy, now = Date.now()}) {
  if (!Array.isArray(nodes) || nodes.length !== 1) invalid('仅支持本机容量规划。');
  for (const key of ['qemuOverheadBytes','gatewayOverheadBytes','maximumSampleAgeMs']) {
    if (!nonnegative(policy?.[key])) invalid(`缺少容量策略 ${key}。`);
  }
  if (!positive(policy.maximumSampleAgeMs) || !positive(resources?.vcpus)
    || !positive(resources?.memoryBytes) || !positive(resources?.diskBytes)) invalid('容量规划参数无效。');
  const runtimeBytes = resources.memoryBytes + policy.qemuOverheadBytes + policy.gatewayOverheadBytes;
  const diskLimitBytes = computerDiskLimitBytes(resources,policy);
  if (!positive(runtimeBytes)) invalid('内存配置超出可表示范围。');
  const results = nodes.map(node => {
    const reasons = [];
    if (!nonnegative(node.sampledAt)) reasons.push({code:'telemetry_missing'});
    if (!node.online) reasons.push({code:'node_offline'});
    if (node.architecture !== 'arm64' || node.kvm !== true) reasons.push({code:'arm_kvm_unavailable'});
    if (node.sampledAt > now || now - node.sampledAt > policy.maximumSampleAgeMs) reasons.push({code:'telemetry_stale'});
    // GB10 has heterogeneous CPU groups. Use a group verified by node inventory
    // rather than combining PMU-incompatible cores or pinning fixed CPU numbers.
    const group = node.availableCpuGroups?.find(g => Array.isArray(g) && g.length >= resources.vcpus
      && new Set(g).size === g.length && g.every(nonnegative));
    if (!group) reasons.push({code:'compatible_cpu_group_unavailable'});
    return {nodeId:node.id,role:node.role,eligible:reasons.length===0,reasons,
      runtimeMemoryBytes:runtimeBytes,diskLimitBytes,
      cpuIds:group?.slice(0,resources.vcpus)??[]};
  });
  const eligible = results.filter(n=>n.eligible);
  return {selected:eligible[0]??null,nodes:results};
}

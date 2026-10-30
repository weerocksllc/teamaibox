// The local macOS probe must use available memory, not just unused pages.
// Linux production admission continues to use its host/cgroup observations.
import {execFileSync} from 'node:child_process';
import {availableMediaMemory} from '../services/object-service/src/buffered-media-budget.mjs';

export function parseDarwinAvailableMemory(output) {
  const total=Number(/^The system has (\d+) /m.exec(output)?.[1]);
  const percent=Number(/^System-wide memory free percentage: (\d+)%$/m.exec(output)?.[1]);
  if(!Number.isSafeInteger(total)||total<=0||!Number.isInteger(percent)||percent<0||percent>100)
    throw new Error('installer_probe_memory_observation_invalid');
  return Math.floor(total*percent/100);
}

export function probeAvailableMemory() {
  if(process.platform!=='darwin')return availableMediaMemory();
  // -Q only queries; never use flags that generate memory pressure.
  return parseDarwinAvailableMemory(execFileSync('/usr/bin/memory_pressure',['-Q'],
    {encoding:'utf8',timeout:5000,env:{...process.env,LC_ALL:'C'}}));
}

"""Publish an already tested API build without restarting phones or models."""
import argparse, datetime as dt, json, re
from pathlib import Path
import appliance_container_operations as d
from spark_validation import RemoteSpark

HELPERS = ['deploy_control_only_resource_successor.py', 'deploy_asr_resource_maintenance.py',
           'validate_node_agent_candidate_startup.py']

def main():
    parser = argparse.ArgumentParser()
    for name in ['run-id', 'api-id', 'agent-id']: parser.add_argument('--'+name, required=True)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--agent-build', type=Path)
    args = parser.parse_args()
    args.build = args.build.resolve()
    if args.agent_build: args.agent_build = args.agent_build.resolve()
    d.need(re.fullmatch(r'resource-control-successor-\d{8}-a[1-9]\d*', args.run_id), 'invalid_run')
    d.need(all(re.fullmatch('[a-f0-9]{64}', value) for value in [args.api_id, args.agent_id]), 'invalid_container')
    path = d.ROOT/'evidence/validation/feature-deployments'/(args.run_id+'.json')
    d.need(not path.exists(), 'run_occupied')
    build = json.loads(args.build.read_bytes())
    d.need(build['status']=='passed' and build['parentContainer']==args.api_id, 'build_parent_changed')
    for name, digest in build['sources'].items():
        d.need(d.sha((d.ROOT/name).read_bytes())==digest, 'build_source_changed')
    result = dict(runId=args.run_id, status='failed', startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
        build=str(args.build.relative_to(d.ROOT)), buildDigest=d.sha(args.build.read_bytes()),
        sources={str(Path('tools')/name):d.sha((d.ROOT/'tools'/name).read_bytes()) for name in [*HELPERS,Path(__file__).name]},
        phonesBefore=d.phones(), modelsRestarted=False, phonesRestarted=False)
    agent_args=[]
    if args.agent_build:
        agent_build=json.loads(args.agent_build.read_bytes())
        d.need(agent_build['status']=='passed' and agent_build['parentContainer']==args.agent_id,'agent_build_parent_changed')
        for name,digest in agent_build['sources'].items():d.need(d.sha((d.ROOT/name).read_bytes())==digest,'agent_source_changed')
        agent_args=['--agent-image',agent_build['image']]
        result['agentBuild']={'path':str(args.agent_build.relative_to(d.ROOT)),'sha256':d.sha(args.agent_build.read_bytes()),'image':agent_build['image']}
    try:
        remote=RemoteSpark(d.MAIN)
        stage='/var/tmp/teamaibox-'+args.run_id
        d.run(d.MAIN,['test','!','-e',stage]); d.run(d.MAIN,['mkdir','-m','700',stage])
        for name in HELPERS:
            copied=remote.copy(d.ROOT/'tools'/name,stage+'/'+name)
            d.need(copied.returncode==0,'helper_copy_failed')
        flatten=[]
        if build.get('flatten'):
            proof=build['flatten']
            d.need(proof['status']=='passed' and proof['parentImageId']==build['parentImage']
                and proof['rootfsCompared'] and proof['configurationMatched'] and not proof['containersStarted'],'invalid_flatten_proof')
            flatten=['--flatten-evidence',build['flattenEvidencePath'],'--flatten-sha256',build['flattenEvidenceSha256']]
        raw=d.run(d.MAIN,['sudo','-n','python3',stage+'/'+HELPERS[0],'--run-id',args.run_id,
            '--api-id',args.api_id,'--agent-id',args.agent_id,'--image',build['image'],*flatten,*agent_args],timeout=300)
        cutover=json.loads(raw);result['cutover']=cutover
        d.need(cutover['status']=='passed','cutover_failed')
        files={name:digest for name,digest in build['sources'].items()
            if '/test/' not in name and not name.startswith('tools/')}
        targets=build.get('fileTargets',{name:'/opt/teamaibox/'+name for name in files})
        reverse={targets[name]:name for name in files}
        observed=d.run(d.MAIN,['docker','exec',cutover['platformId'],'sha256sum',*[targets[name] for name in files]])
        hashes={reverse[line.split()[1]]:line.split()[0] for line in observed.decode().splitlines()}
        d.need(hashes==files,'live_source_mismatch'); result['liveSources']=hashes
        result['phonesAfter']=d.phones();d.need(result['phonesBefore']==result['phonesAfter'],'phone_changed')
        d.need(all(d.sha((d.ROOT/name).read_bytes())==digest for name,digest in result['sources'].items()),'helper_changed')
        result['status']='passed'
    except Exception as error: result['failure']=str(error)[-1200:]
    result['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    with path.open('x') as stream: json.dump(result,stream,indent=2)
    print(json.dumps({key:result.get(key) for key in ['runId','status','failure','cutover']}),flush=True)
    return result['status']!='passed'

if __name__=='__main__': raise SystemExit(main())

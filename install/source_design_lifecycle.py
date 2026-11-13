"""Copy-on-upgrade for standalone Design on a dedicated engine."""
import fcntl
import os
from pathlib import Path
import re
import stat
import uuid

from offline_common import digest, need, read_json, within, write_json
from source_design_ai import AI_IMAGES, dynamic_resources

JOURNAL = 'generation-switch.json'
SNAPSHOT = ('data', 'https', 'secrets')
AGENT_STATE_ENV = frozenset(('HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME',
                            'OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_DB','OPENCODE_DISABLE_CHANNEL_DB'))
BUSY_SQL = "SELECT EXISTS (SELECT 1 FROM platform.agent_prompts WHERE status IN ('admitted','submitting','accepted','running','reconcile_required'))"
NATIVE_IDLE = '''
import {readFile,readdir} from 'node:fs/promises';
import {nativeInstanceBusy} from '/opt/teamaibox/services/agent-bridge/src/opencode-native-activity.mjs';
const token=(await readFile('/run/teamaibox/secrets/opencode-password','utf8')).trim();
const authorization='Basic '+Buffer.from('opencode:'+token).toString('base64');
const busy=await nativeInstanceBusy({request:(_,path,{signal})=>
  fetch('http://127.0.0.1:4096'+path,{headers:{authorization},signal,redirect:'error'})});
// The legacy PTY list is directory-scoped. Check for controlling terminals
// anywhere in this sandbox's own PID namespace, including other projects.
let terminal=false;
for (const id of (await readdir('/proc')).filter(name=>/^\\d+$/.test(name))) {
  const stat=await readFile('/proc/'+id+'/stat','utf8').catch(e=>{if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e;});
  if(stat===null)continue;
  const tty=stat.slice(stat.lastIndexOf(')')+2).split(' ')[4];
  if(tty!=='0'){terminal=true;break;}
}
console.log(busy||terminal?'busy':'idle');
'''


def check_identity(root, state):
    slot = uuid.UUID(state.get('slotId') or state['installationId'])
    need(state.get('schemaVersion') == 1 and state['root'] == str(root)
         and state['project'] == 'teamaibox-design-' + slot.hex, 'Design instance identity mismatch')


def private_root(path):
    need(path == path.resolve() and path.is_dir() and path.stat().st_uid == 0
         and path.stat().st_mode & 0o077 == 0, 'Design root is not a private owned directory')


def journal(root, state):
    path = within(root, JOURNAL)
    if not path.exists():
        return None
    row = read_json(path)
    need(row['schemaVersion'] == 1 and row['baseline'] == str(root)
         and row['installationId'] == state['installationId'] and row['engineId'] == state.get('engineId')
         and row['baselineComposeSha256'] == state.get('composeSha256')
         and row['phase'] in ('preparing','upgraded','rolling-back','rolled-back'), 'invalid Design generation journal')
    return row


def activation_allowed(root, state):
    if 'baselineRoot' in state:
        baseline = Path(state['baselineRoot'])
        private_root(baseline)
        original = read_json(within(baseline, 'design-state.json'))
        check_identity(baseline, original)
        row = journal(baseline, original)
        need(row and row['phase']=='upgraded' and row['candidate']==str(root)
             and row['slotId']==state['slotId'], 'candidate is inactive; do not start it outside the generation switch')
    else:
        row = journal(root, state)
        need(not row or row['phase']=='rolled-back', 'baseline is inactive; use design rollback to switch back')


def checked_compose(root, state):
    path = within(root, 'compose.json')
    need(path.is_file() and digest(path)==state.get('composeSha256'), 'unknown or changed Design configuration')
    return read_json(path)


def safe_snapshot(root, *, ai=False):
    # No external tablespaces, nested bind mounts, or special files. Snapshot
    # only the three installer-owned trees, not build cache or host paths.
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mounts.append(Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1],8)), line.split()[4])))
    for leaf in SNAPSHOT:
        path = within(root, leaf)
        need(path.is_dir() and not any(p.is_relative_to(path) for p in mounts),
             'Design snapshot has a nested mount or missing directory')
        for directory, folders, files in os.walk(path, followlinks=False):
            for name in (*folders, *files):
                entry = Path(directory)/name
                mode = entry.lstat().st_mode
                # User project/dependency symlinks are valid workspace contents.
                # cp -a and the scan both preserve links without following them.
                rel = entry.relative_to(root).parts
                user_link = ai and len(rel)>5 and rel[:3]==('data','agent','dynamic') and re.fullmatch('[a-f0-9]{32}',rel[3]) and rel[4]=='workspace'
                need(stat.S_ISDIR(mode) or stat.S_ISREG(mode) or (user_link and stat.S_ISLNK(mode)),
                     'unsupported Design snapshot entry')


def running_roles(rows):
    return {r['Config']['Labels']['com.docker.compose.service']:r['Id'] for r in rows if r['State']['Running']}


def check_agent_layout(module, old_image, new_image):
    def state_env(image):
        cfg = module.inspect_image(image)['Config']
        return {k:v for k,_,v in (item.partition('=') for item in cfg.get('Env') or []) if k in AGENT_STATE_ENV}
    need(state_env(old_image)==state_env(new_image), 'changing OpenCode state paths requires a separate compatibility migration')


def agent_idle(module, root, compose, roles, *, require_db=False):
    agents = [r for r in dynamic_resources(root,compose) if r['State']['Running']]
    if postgres := roles.get('postgres'):
        sql = ('export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; '
               'exec psql -XAt --no-password -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"')
        result = module.run(['docker','exec',postgres,'sh','-ec',sql,'design-activity',BUSY_SQL],timeout=20).strip()
        need(result=='f', 'Design has unresolved Assistant requests; finish them before switching')
    else:
        need(not require_db and not agents, 'start the original AI Design workspace before upgrading')
    for agent in agents:
        result = module.run(['docker','exec',agent['Id'],'node','--input-type=module','-e',NATIVE_IDLE],timeout=20).strip()
        need(result=='idle', 'Design has active or unverified OpenCode work; close terminals and finish prompts before switching')


def quiesce_agents(module, root, compose, rows):
    roles = running_roles(rows)
    agent_idle(module,root,compose,roles)
    # Fence public requests first, then sandbox provisioning, before the second
    # idle check. If a request raced the fence, retain the running agents and
    # leave the journal recoverable, rather than cancelling unknown work.
    for role in ('web','platform-api','agent-bridge'):
        if role in roles:
            module.run(['docker','container','stop','--time','45',roles[role]],timeout=65)
    agent_idle(module,root,compose,roles)
    agents = dynamic_resources(root,compose)
    for row in agents:
        if row['State']['Running']:
            module.run(['docker','container','stop','--time','45',row['Id']],timeout=65)
    need(all(r['State']['Status'] in ('exited','created') and r['State']['ExitCode'] not in (137,)
             for r in dynamic_resources(root,compose)), 'OpenCode sandboxes did not stop cleanly')


def stopped(module, root, state, compose, *, detach=False, check_databases=False):
    rows = module.owned_resources(compose, state)
    prefix = module.compose_command(root, state)
    if state.get('ai') and (not detach or running_roles(rows)):
        quiesce_agents(module,root,compose,rows)
    if any(row['State']['Running'] for row in rows):
        module.run([*prefix, 'stop', '--timeout', '45'], timeout=180)
        rows = module.owned_resources(compose, state)
    need(all(row['State']['Status'] in ('exited','created') for row in rows), 'Design services did not quiesce')
    if check_databases:
        pg = {r['Config']['Labels']['com.docker.compose.service']:r['State'] for r in rows
              if r['Config']['Labels']['com.docker.compose.service'] in ('postgres','penpot-postgres')}
        need(set(pg)=={'postgres','penpot-postgres'} and all(s['Status']=='exited' and s['ExitCode']==0 for s in pg.values()),
             'both Design databases must stop cleanly before copying')
    if detach:
        if state.get('ai'):
            agents = dynamic_resources(root,compose)
            need(all(r['State']['Status'] in ('exited','created') for r in agents), 'owned sandboxes are not stopped')
            if agents:
                module.run(['docker','container','rm',*[r['Id'] for r in agents]],timeout=90)
        if rows:
            module.run([*prefix,'down','--timeout','45'],timeout=180)
        need(not module.owned_resources(compose,state), 'owned Design containers did not detach')
    write_json(root/'readiness.json',dict(status='stopped',dataRetained=True))


def transition(module, args, root, state):
    target=args.target_root.absolute()
    engine=Path(state['engineRoot']) if state.get('engineRoot') else None
    ai = state.get('ai',False)
    need(engine and 'baselineRoot' not in state, 'switches require the original Design instance on its dedicated engine')
    need(target==target.resolve() and target.parent==root.parent and target!=root, 'candidate must be a different sibling directory')
    old=checked_compose(root,state)
    roles=module.IMAGE_ROLES | (AI_IMAGES if ai else set())
    record=journal(root,state)
    if args.action=='upgrade':
        need((not record or record['phase']=='rolled-back') and not target.exists(),
             'a switch is active or candidate path is occupied; all data preserved')
        rows=module.owned_resources(old,state)
        need(bool(args.assistant_model_release)==ai and (not ai or args.model_release_sha256==state.get('modelChecksum')),
             'AI upgrade requires the original verified model release; model or profile changes are not supported')
        images=module.reused_images(args.reuse_images,args.images_sha256,ai=ai)
        old_images={role:old['services'][role]['image'] for role in roles-{'agent-sandbox'}}
        if ai:
            old_images['agent-sandbox']=read_json(within(root,'config/agent-controller.json'))['image']
            module.verify_agent_image(images['agent-sandbox'])
            if images['agent-sandbox']!=old_images['agent-sandbox']:
                check_agent_layout(module,old_images['agent-sandbox'],images['agent-sandbox'])
                def binary(image):
                    return module.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
                        '--security-opt','no-new-privileges','--user','65532:65532','--entrypoint','sha256sum',
                        image,'/opt/opencode/opencode'],timeout=90).strip().split()[0]
                need(binary(images['agent-sandbox'])==binary(old_images['agent-sandbox']),
                     'changing the OpenCode binary requires a separate compatibility migration')
        need(images!=old_images and all(images[r]==old_images[r] for r in ('postgres','penpot-postgres')),
             'upgrade requires a new image set and the same two database images')
        for image in set(old_images.values()):
            module.inspect_image(image)
        generation=uuid.uuid4()
        candidate={**state,'root':str(target),'slotId':str(generation),'project':'teamaibox-design-'+generation.hex,
                   'baselineRoot':str(root),'sourceIdentity':module.source_identity(module.ROOT),'reuseChecksum':args.images_sha256}
        candidate.pop('composeSha256')
        model=within(target,'assets/assistant-model') if ai else None
        _, files, _, _ = module.render(module.ROOT,target,candidate,images,model)
        old_catalog=read_json(within(root,'config/application-catalog.json'))
        new_catalog=files['config/application-catalog.json']
        need([x['manifest'] for x in old_catalog['applications']]==[x['manifest'] for x in new_catalog['applications']],
             'Design application manifest changed; this switch supports compatible image generations only')
        if ai:
            agent_idle(module,root,old,running_roles(rows),require_db=True)
        target.mkdir(mode=0o700)
        write_json(target/'design-state.json',candidate)
        record=dict(schemaVersion=1,baseline=str(root),candidate=str(target),slotId=candidate['slotId'],
                    installationId=state['installationId'],engineId=state['engineId'],
                    baselineComposeSha256=state['composeSha256'],phase='preparing')
        write_json(root/JOURNAL,record)
        with within(target,'design.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if ai:
                # Copy and verify the immutable, already deployed weights while
                # the baseline is still up, before touching any writable state.
                model=module.checked_model(args.assistant_model_release,args.model_release_sha256,target,
                                           deployed_source=within(root,'assets/assistant-model'))
            stopped(module,root,state,old,check_databases=True)
            safe_snapshot(root,ai=ai)
            for leaf in SNAPSHOT:
                module.run(['cp','-a','--reflink=auto','--',within(root,leaf),target/leaf],timeout=7200)
            module.run(['sync','-f',target],timeout=600)
            stopped(module,root,state,old,detach=True)
            pipeline=module.Pipeline(within(target,'build'),candidate['sourceIdentity'],target)
            try:
                _, compose=module.configuration(target,candidate,images,pipeline,model)
                candidate['composeSha256']=digest(target/'compose.json')
                write_json(target/'design-state.json',candidate)
                write_json(target/'image-map.json',dict(schemaVersion=1,images=images,reused=True,
                           installerSourceIdentity=candidate['sourceIdentity']))
                origin=module.start_configured(target,candidate,compose)
            finally:
                pipeline.lock.close()
            write_json(root/JOURNAL,{**record,'phase':'upgraded'})
        print('Design candidate ready: '+origin+'; the pre-upgrade data directory is retained.')
        return
    need(record and record['candidate']==str(target) and record['phase']!='rolled-back',
         'no matching active or incomplete Design switch')
    private_root(target)
    with within(target,'design.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        candidate=read_json(within(target,'design-state.json'))
        check_identity(target,candidate)
        need(candidate.get('baselineRoot')==str(root) and candidate['slotId']==record['slotId']
             and candidate.get('engineId')==state['engineId'] and candidate['installationId']==state['installationId']
             and candidate.get('ai',False)==ai and candidate.get('modelChecksum')==state.get('modelChecksum'),
             'candidate generation does not match this baseline')
        for role in roles-{'agent-sandbox'}:
            module.inspect_image(old['services'][role]['image'])
        if ai:
            module.inspect_image(read_json(within(root,'config/agent-controller.json'))['image'])
        if candidate.get('composeSha256'):
            compose=checked_compose(target,candidate)
            # If a previous attempt already detached the candidate, the
            # remaining containers may only be the checked baseline.
            ids=module.run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+candidate['project']]).strip()
            if ids:
                if ai:
                    agent_idle(module,target,compose,running_roles(module.owned_resources(compose,candidate)))
                write_json(root/JOURNAL,{**record,'phase':'rolling-back'})
                stopped(module,target,candidate,compose,detach=True)
        write_json(root/JOURNAL,{**record,'phase':'rolling-back'})
        origin=module.start_configured(root,state,old)
        write_json(root/JOURNAL,{**record,'phase':'rolled-back'})
    print('Pre-upgrade Design generation restored: '+origin+'; candidate data retained, not merged.')

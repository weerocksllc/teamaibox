"""Connect microphone transcription to this installation's resident ASR."""
from factory_services import bind


def realtime(compose, add):
    add('config/realtime.json', dict(schemaVersion=1, connectionGraceMilliseconds=30000,
        retryAfterSeconds=3, reconcileIntervalMilliseconds=5000,
        speechTransport=dict(origin='@@OFFICE_ENV.ASR_WORKER_ORIGIN@@', model='@@OFFICE_ENV.ASR_SERVED_MODEL@@',
                             maximumChunkBytes=8388608, maximumResponseBytes=8388608, timeoutMilliseconds=60000),
        placements=[dict(capability='asr', model='local/realtime-asr', nodeKey='localhost',
            modelProfileKey='@@PROFILE_KEY.asr@@', route='local',
            resources=dict(cpuMillis=8000, unifiedMemoryBytes=1428910080, acceleratorUnits=0,
                           codecSessions=0, storageBytes=0, networkBitsPerSecond=100000000),
            codecDirections=dict(encodeSessions=0, decodeSessions=0), latencyBudgetMilliseconds=5000,
            observedLatencyMilliseconds=None, warm=False,
            protectedResident=dict(setId='@@OFFICE_SET_ID@@', workerId='@@ID.asr@@', maintenanceGeneration=1))]))
    api = compose['services']['platform-api']
    api['environment']['PLATFORM_REALTIME_PLACEMENT_CONFIG_FILE'] = '/run/config/realtime.json'
    api['volumes'].append(bind('@@ROOT@@/config/realtime.json', '/run/config/realtime.json'))

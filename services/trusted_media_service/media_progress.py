"""Fixed, content-free counters for the authenticated private health API."""
from collections.abc import Mapping

COUNTERS = ('videoReceived', 'audioReceived', 'browserVideoPushed', 'browserAudioPushed',
            'browserVideoEncoded', 'browserConnections', 'browserEncoders',
            'audioIngressObserved', 'audioTimestampDiscarded', 'audioBufferLimit', 'browserAudioEncoded',
            'sourceWidth', 'sourceHeight', 'displayWidth', 'displayHeight',
            'decodedWidth', 'decodedHeight', 'pixelAspectNumerator', 'pixelAspectDenominator')
STATES = ('waiting', 'receiving', 'ended', 'failed', 'closed', 'publishing', 'absent')
HDMI_COUNTERS = ('videoPushed', 'audioPushed', 'videoRendered', 'audioRendered',
                 'videoDropped', 'audioDropped', 'audioQueued', 'audioQueueLimit',
                 'audioQueueOverruns', 'videoTimelineResets', 'audioTimelineResets',
                 'audioSignalBuffers', 'audioSilentBuffers', 'audioInvalidBuffers')
HDMI_OFFSETS = ('videoScheduleSkewMs', 'audioScheduleSkewMs',
                'videoInitialCorrectionMs', 'audioInitialCorrectionMs')


def validate_progress(value):
    fields = set(COUNTERS) | {'videoState', 'audioState', 'browserState'}
    if (not isinstance(value, Mapping) or set(value) - {'sourceState', 'sourceStateRevision', 'hdmi'} != fields
            or (('sourceState' in value) != ('sourceStateRevision' in value))
            or ('sourceState' in value and value['sourceState'] not in ('waiting', 'connected', 'disconnected', 'unknown'))
            or ('sourceStateRevision' in value and (type(value['sourceStateRevision']) is not int
                or not 1 <= value['sourceStateRevision'] <= 2**53-1))
            or any(type(value[k]) is not int or not 0 <= value[k] <= 2**53-1 for k in COUNTERS)
            or any(value[k] > 8192 for k in ('sourceWidth', 'sourceHeight', 'displayWidth', 'displayHeight'))
            or any(value[k] > 1920 for k in ('decodedWidth', 'decodedHeight'))
            or any(value[k] > 65535 for k in ('pixelAspectNumerator', 'pixelAspectDenominator'))
            or any(value[k] not in STATES for k in ('videoState', 'audioState', 'browserState'))):
        raise ValueError('cast_runtime_progress_invalid')
    if 'hdmi' in value:
        hdmi = value['hdmi']
        if (not isinstance(hdmi, Mapping) or set(hdmi) != set(HDMI_COUNTERS + HDMI_OFFSETS)
                or any(type(hdmi[k]) is not int or not 0 <= hdmi[k] <= 2**53-1 for k in HDMI_COUNTERS)
                or any(type(hdmi[k]) is not int or abs(hdmi[k]) > 2**53-1 for k in HDMI_OFFSETS)):
            raise ValueError('cast_runtime_progress_invalid')
    return dict(value)


def project_progress(ingress, browser, geometry=None, source_state=None, source_state_revision=None, hdmi=None):
    # Explicit projection: no caps, times, peer labels, URLs or credentials.
    tracks = ingress.get('tracks', {})
    video, audio = tracks.get('video', {}), tracks.get('audio', {})
    pushed = browser.get('pushedSamples', {})
    caps, geometry = video.get('caps') or {}, geometry or {}
    extra = {'sourceState': source_state} if source_state is not None else {}
    if source_state_revision is not None:
        extra['sourceStateRevision'] = source_state_revision
    if hdmi is not None:
        # Only counts and relative clock differences; no samples, absolute
        # timestamps, device names, sender labels, PINs or arbitrary diagnostics.
        extra['hdmi'] = {
            **{media+key: hdmi.get(field, {}).get(media, 0)
               for media in ('video', 'audio')
               for key, field in (('Pushed', 'pushedSamples'), ('Rendered', 'renderedBuffers'),
                                  ('Dropped', 'droppedBuffers'), ('TimelineResets', 'timelineResets'),
                                  ('ScheduleSkewMs', 'scheduleSkewMs'), ('InitialCorrectionMs', 'initialCorrectionMs'))},
            'audioQueued': hdmi.get('queuedSamples', {}).get('audio', 0),
            'audioQueueLimit': hdmi.get('maximumQueuedSamples', {}).get('audio', 0),
            'audioSignalBuffers': hdmi.get('audioSignal', {}).get('signalBuffers', 0),
            'audioSilentBuffers': hdmi.get('audioSignal', {}).get('silentBuffers', 0),
            'audioInvalidBuffers': hdmi.get('audioSignal', {}).get('invalidBuffers', 0),
            'audioQueueOverruns': hdmi.get('audioQueueOverruns', 0)}
    return validate_progress(dict(**extra, videoReceived=video.get('receivedFrames', 0),
        audioReceived=audio.get('receivedFrames', 0), videoState=video.get('state', 'absent'),
        audioState=audio.get('state', 'absent'), browserState=browser.get('state', 'absent'),
        browserVideoPushed=pushed.get('video', 0), browserAudioPushed=pushed.get('audio', 0),
        browserVideoEncoded=browser.get('encodedVideoBuffers', 0),
        audioIngressObserved=audio.get('observedFrames', 0),
        audioTimestampDiscarded=audio.get('timestampDiscarded', 0),
        audioBufferLimit=ingress.get('maximumQueuedSamples', {}).get('audio', 0),
        browserAudioEncoded=browser.get('encodedAudioBuffers', 0),
        sourceWidth=geometry.get('sourceWidth', 0), sourceHeight=geometry.get('sourceHeight', 0),
        displayWidth=geometry.get('displayWidth', 0), displayHeight=geometry.get('displayHeight', 0),
        decodedWidth=caps.get('width', 0), decodedHeight=caps.get('height', 0),
        pixelAspectNumerator=caps.get('pixelAspectNumerator', 0),
        pixelAspectDenominator=caps.get('pixelAspectDenominator', 0),
        browserConnections=browser.get('activeSfuConnections', 0),
        browserEncoders=browser.get('activeVideoEncoders', 0)))

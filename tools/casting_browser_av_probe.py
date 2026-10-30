"""Browser-only casting timing source and conservative recording analysis.

The source is a synthetic MP4 with a single muxed A/V timeline, not receiver
injection. An offline source check never accepts Apple/browser playback.
Recordings stay local. Missing/ambiguous pulses and unknown camera A/V bias
remain explicit; no internal timestamp or silent stream can substitute for sound.
"""
import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

import numpy as np
import casting_av_calibration as base

FPS, RATE, DURATION = 30, 48000, 32
# Non-periodic intervals distinguish an actual matching sequence from a
# one-pulse phase shift. Complete capture includes two seconds at both ends.
PULSES = [2, 4, 7, 9, 12, 16, 18, 21, 25, 28]
BUDGETS = {
    'glassP95Ms': 500, 'glassMaxMs': 750,
    'soundMinusPictureMinMs': -45, 'soundMinusPictureMaxMs': 100,
    'opticalBracketMaxMs': 50,
    'viewerCounts': [1, 8],
}


def need(ok, code):
    if not ok:
        raise ValueError(code)


def manifest(path):
    return dict(kind='browser-casting-av-source', version=1,
                clipSha256=base.sha(path), width=1920, height=1080, fps=FPS,
                sampleRate=RATE, durationSeconds=DURATION, pulseSeconds=PULSES,
                pulseDurationMs=100, frequencyHz=1000,
                opticalRoi=[288, 270, 1344, 540], budgets=BUDGETS,
                actualAppleSourceAccepted=False, browserAvSyncAccepted=False,
                fullTaskAccepted=False)


def generate(path):
    need(not path.exists() and not path.with_suffix('.json').exists(), 'output_occupied')
    need(shutil.which('ffmpeg') is not None, 'existing_ffmpeg_required')
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='teamaibox-browser-av-source-') as scratch:
        wav = Path(scratch) / 'source.wav'
        signal = np.zeros(DURATION * RATE, dtype=np.float64)
        t = np.arange(RATE // 10) / RATE
        # Short edge fades avoid clicks while retaining a detectable onset.
        tone = .25 * np.sin(2 * np.pi * 1000 * t) * np.minimum(1, np.minimum(t / .002, (.1 - t) / .002))
        for second in PULSES:
            signal[second * RATE:second * RATE + len(tone)] = tone
        pcm = np.repeat((signal * 32767).astype('<i2')[:, None], 2, axis=1)
        with wave.open(str(wav), 'wb') as output:
            output.setnchannels(2)
            output.setsampwidth(2)
            output.setframerate(RATE)
            output.writeframes(pcm.tobytes())
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-n',
                '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', '640x360',
                '-framerate', str(FPS), '-i', 'pipe:0', '-i', str(wav),
                '-vf', 'scale=1920:1080:flags=neighbor,format=yuv420p',
                '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
                '-crf', '18', '-bf', '0', '-g', '30', '-c:a', 'aac', '-b:a', '192k',
                '-ar', str(RATE), '-movflags', '+faststart', '-t', str(DURATION), str(path)]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for index in range(DURATION * FPS):
                frame = np.full((360, 640), 24, dtype=np.uint8)
                flashing = any(s * FPS <= index < s * FPS + 3 for s in PULSES)
                frame[90:270, 96:544] = 235 if flashing else 36
                for offset, number in enumerate(f'{index:04d}'):
                    base.digit(frame, 250 + offset * 36, 15, int(number))
                # Every frame has a moving footer so a frozen source is obvious.
                x = 32 + index % 550
                frame[320:338, x:x + 24] = 200
                process.stdin.write(frame.tobytes())
            process.stdin.close()
            process.stdin = None
            _, error = process.communicate(timeout=90)
            need(process.returncode == 0, 'source_encode_failed:' + error.decode()[:160])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    value = manifest(path)
    base.write_json_new(path.with_suffix('.json'), value)
    return value


def validate_manifest(path):
    value = json.loads(path.with_suffix('.json').read_text())
    need(value == manifest(path), 'source_manifest_changed')
    return value


def sequence(events):
    need(len(events) == len(PULSES), 'complete_ten_pulse_sequence_required')
    expected = np.diff(PULSES)
    actual = np.diff([e['estimate'] for e in events])
    need(np.all(np.abs(actual - expected) <= .15), 'pulse_sequence_or_phase_mismatch')


def checked_pairs(source, target, minimum, maximum):
    sequence(source)
    sequence(target)
    return base.match_events(source, target, min_offset=minimum, max_offset=maximum)


def budget_result(glass, av, camera_bias_ms, camera_uncertainty_ms, distance_m):
    for number in (camera_bias_ms, camera_uncertainty_ms, distance_m):
        need(number is None or (isinstance(number, (int, float)) and math.isfinite(number)), 'nonfinite_calibration')
    need(camera_uncertainty_ms is None or camera_uncertainty_ms >= 0, 'negative_camera_uncertainty')
    need(distance_m is None or distance_m >= 0, 'negative_sound_distance')
    # Positive bias means a simultaneous physical sound appears late in this
    # camera recording. Positive A/V skew means the browser sound is late.
    calibrated = camera_bias_ms is not None and camera_uncertainty_ms is not None and distance_m is not None
    correction = camera_bias_ms + distance_m / 343 * 1000 if calibrated else None
    intervals = []
    if calibrated:
        for p in av['perPulse']:
            intervals.append(dict(lowerMs=p['lowerMs'] - correction - camera_uncertainty_ms,
                                  upperMs=p['upperMs'] - correction + camera_uncertainty_ms,
                                  estimateMs=p['estimateMs'] - correction))
    # Evaluate upper uncertainty bounds, not just a flattering median.
    glass_upper = [p['upperMs'] for p in glass['perPulse']]
    glass_pass = (np.percentile(glass_upper, 95) <= BUDGETS['glassP95Ms']
                  and max(glass_upper) <= BUDGETS['glassMaxMs']
                  and min(p['lowerMs'] for p in glass['perPulse']) >= 0
                  and glass['measurementBracketMaxWidthMs'] <= BUDGETS['opticalBracketMaxMs'])
    av_pass = calibrated and all(p['lowerMs'] >= BUDGETS['soundMinusPictureMinMs']
                                and p['upperMs'] <= BUDGETS['soundMinusPictureMaxMs'] for p in intervals)
    return dict(glassBudgetPassed=bool(glass_pass), browserAvBudgetPassed=bool(av_pass),
                cameraBiasKnown=calibrated, correctedSoundMinusPicture=intervals,
                browserAvSyncAccepted=False, fullTaskAccepted=False)


def self_test(path):
    reference = validate_manifest(path)
    info, video = base.metadata(path)
    need(video['width'] == 1920 and video['height'] == 1080 and video['r_frame_rate'] == '30/1', 'source_video_format')
    audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
    need(audio['sample_rate'] == '48000' and audio['channels'] == 2, 'source_audio_format')
    light, stats = base.optical(path, reference['opticalRoi'])
    sound = base.acoustic(path)
    sequence(light)
    sequence(sound)
    need(stats['frameCount'] == DURATION * FPS, 'source_frame_count')
    need(all(abs(e['hi'] - s) < .00001 for e, s in zip(light, PULSES)), 'source_flash_pts_misaligned')
    offsets = [dict(lowerMs=(e['lo'] - s) * 1000, upperMs=(e['hi'] - s) * 1000) for e, s in zip(sound, PULSES)]
    need(all(abs(o['lowerMs']) <= 2 and abs(o['upperMs']) <= 2 for o in offsets), 'source_sound_pts_misaligned')
    return dict(kind='browser-casting-av-source-check', status='passed', source=reference,
                decodedFrames=stats['frameCount'], decodedAudioOnsetBoundsMs=offsets,
                actualAppleSourceAccepted=False, browserAvSyncAccepted=False,
                glassToGlassLatencyMeasured=False, fullTaskAccepted=False)


def analyze(path, source_roi, browser_roi, camera_bias_ms=None, camera_uncertainty_ms=None, distance_m=None):
    source, source_stats = base.optical(path, source_roi)
    browser, browser_stats = base.optical(path, browser_roi)
    sound = base.acoustic(path)
    # Wide identification bounds are NOT the acceptance budget. An actual
    # 1.4-second delay is reported as a failing measurement, not cropped away.
    glass = checked_pairs(source, browser, -.5, 3)
    av = checked_pairs(browser, sound, -2, 2)
    verdict = budget_result(glass, av, camera_bias_ms, camera_uncertainty_ms, distance_m)
    return dict(kind='browser-casting-av-recording', recordingSha256=base.sha(path),
                sourceVideo=source_stats, browserVideo=browser_stats, budgets=BUDGETS,
                sourceToBrowser=glass, observedSoundMinusBrowser=av,
                cameraAvBiasMs=camera_bias_ms, cameraAvUncertaintyMs=camera_uncertainty_ms,
                speakerToMicrophoneMetres=distance_m, **verdict,
                limitations=['Intervals include camera frame sampling, not unmeasured rolling shutter or display scanout.',
                             'Without independent camera A/V calibration, observed audio skew is not absolute browser A/V acceptance.',
                             'Recording analysis alone does not bind the deployed receiver, browser authorization or viewer count.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    generate_parser = sub.add_parser('generate')
    generate_parser.add_argument('--output', type=Path, required=True)
    check = sub.add_parser('check-source')
    check.add_argument('--clip', type=Path, required=True)
    check.add_argument('--output', type=Path, required=True)
    recording = sub.add_parser('analyze')
    recording.add_argument('--recording', type=Path, required=True)
    recording.add_argument('--source-roi', type=base.roi, required=True)
    recording.add_argument('--browser-roi', type=base.roi, required=True)
    recording.add_argument('--camera-bias-ms', type=float)
    recording.add_argument('--camera-uncertainty-ms', type=float)
    recording.add_argument('--speaker-distance-m', type=float)
    recording.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'generate':
        value = generate(args.output)
    else:
        need(not args.output.exists(), 'output_occupied')
        if args.mode == 'check-source':
            value = self_test(args.clip)
        else:
            value = analyze(args.recording, args.source_roi, args.browser_roi,
                            args.camera_bias_ms, args.camera_uncertainty_ms, args.speaker_distance_m)
        base.write_json_new(args.output, value)
    print(json.dumps(value))


if __name__ == '__main__':
    main()

package com.teamaibox.phonemediatest;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.AudioFormat;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Synthetic-only moving canvas and short tones. No network/device permissions. */
public final class MainActivity extends Activity {
    private final Handler timer = new Handler();
    private AudioTrack tones;
    private int audioWrittenSamples;
    private long start, frames, touches, keys, toneRequests;
    private boolean active;
    private Pattern pattern;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        short[] wave = new short[96000];
        for (int i=0; i<9600; i++) {
            double ramp = Math.min(1.0, Math.min(i/480.0, (9600-i)/480.0));
            wave[i]=(short)(12000 * ramp * Math.sin(2*Math.PI*880*i/48000));
        }
        tones = new AudioTrack(AudioManager.STREAM_MUSIC,48000,AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,wave.length*2,AudioTrack.MODE_STATIC);
        if (tones.getState()!=AudioTrack.STATE_NO_STATIC_DATA) throw new IllegalStateException("audio_init_failed");
        audioWrittenSamples=tones.write(wave,0,wave.length);
        if (audioWrittenSamples!=wave.length || tones.setLoopPoints(0,wave.length,-1)!=AudioTrack.SUCCESS)
            throw new IllegalStateException("audio_write_failed");
        start = SystemClock.elapsedRealtime();
        pattern = new Pattern(); setContentView(pattern);
    }
    private final Runnable frame = new Runnable() {
        public void run() { if (active) { pattern.invalidate(); timer.postDelayed(this, 33); } }
    };
    private final Runnable sample = new Runnable() {
        public void run() {
            if (!active) return;
            long elapsed = SystemClock.elapsedRealtime() - start;
            toneRequests=tones.getPlaybackHeadPosition()/96000;
            try {
                JSONObject data = new JSONObject();
                data.put("syntheticOnly", true); data.put("elapsedMs", elapsed);
                data.put("drawnFrames", frames); data.put("touches", touches); data.put("keys", keys);
                data.put("toneRequests", toneRequests); data.put("width", pattern.getWidth()); data.put("height", pattern.getHeight());
                data.put("audioWrittenSamples", audioWrittenSamples); data.put("audioFramesPlayed", tones.getPlaybackHeadPosition());
                data.put("audioPlaying", tones.getPlayState()==AudioTrack.PLAYSTATE_PLAYING);
                data.put("wallClockMs", System.currentTimeMillis());
                File pending = new File(getFilesDir(), "sample.pending");
                try (FileOutputStream file = new FileOutputStream(pending)) {
                    file.write(data.toString().getBytes(StandardCharsets.UTF_8)); file.getFD().sync();
                }
                pending.renameTo(new File(getFilesDir(), "sample.json"));
            } catch (Exception ignored) { /* Missing sample fails the external test; no fabricated success. */ }
            timer.postDelayed(this, 1000);
        }
    };
    @Override public void onResume() { super.onResume(); active = true; tones.play(); timer.post(frame); timer.post(sample); }
    @Override public void onPause() { active = false; timer.removeCallbacks(frame); timer.removeCallbacks(sample); tones.pause(); super.onPause(); }
    @Override public void onDestroy() { timer.removeCallbacksAndMessages(null); tones.release(); super.onDestroy(); }
    private final class Pattern extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Pattern() { super(MainActivity.this); setFocusableInTouchMode(true); requestFocus(); }
        @Override protected void onDraw(Canvas canvas) {
            frames++; long elapsed = SystemClock.elapsedRealtime() - start;
            canvas.drawColor(Color.rgb(12, 22, 40));
            float scale = getWidth() / 720f; canvas.save(); canvas.scale(scale, scale);
            paint.setColor(Color.WHITE); paint.setTextSize(38);
            canvas.drawText("LOCAL ANDROID MEDIA TEST", 26, 90, paint);
            paint.setTextSize(28); canvas.drawText("Elapsed " + elapsed + " ms", 26, 145, paint);
            canvas.drawText("Frames " + frames, 26, 190, paint);
            canvas.drawText("Touch " + touches + " / Key " + keys, 26, 235, paint);
            canvas.drawText("Short beep every 2 seconds", 26, 280, paint);
            canvas.drawText("" + System.currentTimeMillis(), 26, 325, paint);
            float x = 80 + (elapsed % 2000) * 560f / 2000;
            paint.setColor((elapsed / 2000) % 2 == 0 ? Color.CYAN : Color.YELLOW);
            canvas.drawCircle(x, 520, 55, paint);
            paint.setColor(Color.rgb(80, 180, 100)); canvas.drawRect(26, 660, 26 + (frames % 300) * 2, 715, paint);
            canvas.restore();
        }
        @Override public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_DOWN) { touches++; requestFocus(); invalidate(); }
            return true;
        }
        @Override public boolean onKeyDown(int code, KeyEvent event) {
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_HOME || code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) return super.onKeyDown(code,event);
            keys++; invalidate(); return true;
        }
    }
}

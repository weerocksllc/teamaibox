package com.teamaibox.phonecameradynamic;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.*;
import android.media.Image;
import android.media.MediaRecorder;
import android.media.MediaMetadataRetriever;
import android.media.ImageReader;
import android.view.Surface;
import android.view.TextureView;
import android.view.WindowManager;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** Standard Camera2 preview + JPEG capture, on a new synthetic-only guest. */
public final class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
  private HandlerThread worker; private Handler handler;
  private TextureView view; private CameraDevice camera; private CameraCaptureSession session;
  private ImageReader yuv,jpeg; private Surface preview;
  private final JSONObject report=new JSONObject();
  private int frames; private boolean taking; private int dark,bright;
  private int positive,negative,transitions,lastPolarity;
  private MediaRecorder recorder; private boolean recording;
  private void save() {
    try (FileOutputStream out=new FileOutputStream(new File(getFilesDir(),"sample.pending"))) {
      report.put("syntheticOnly",true);report.put("previewFrames",frames);
      out.write(report.toString().getBytes("UTF-8"));out.getFD().sync();
      new File(getFilesDir(),"sample.pending").renameTo(new File(getFilesDir(),"sample.json"));
    } catch(Exception ignored) {}
  }
  private void fail(String reason) {try {report.put("error",reason);save();}catch(Exception ignored){}}
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    worker=new HandlerThread("camera-fixture");worker.start();handler=new Handler(worker.getLooper());
    // This is the host input fixture, created before opening any camera. It is
    // never counted as an Android camera result; the independent JPEG reader is.
    try {
      Bitmap input=Bitmap.createBitmap(640,480,Bitmap.Config.ARGB_8888);
      for(int y=0;y<480;y++)for(int x=0;x<640;x++)input.setPixel(x,y,((x<320)==(y<240))?0xff000000:0xffffffff);
      try(FileOutputStream out=new FileOutputStream(new File(getFilesDir(),"source.jpg"))){input.compress(Bitmap.CompressFormat.JPEG,95,out);}
      input.recycle();
    }catch(Exception e){fail("fixture_creation_failed");}
    view=new TextureView(this);view.setSurfaceTextureListener(this);setContentView(view);
  }
  @Override public void onSurfaceTextureAvailable(SurfaceTexture texture,int w,int h){handler.post(()->open(texture));}
  private void open(SurfaceTexture texture) {
    try {
      CameraManager manager=(CameraManager)getSystemService(CAMERA_SERVICE);String selected=null;
      for(String id:manager.getCameraIdList()) {
        Integer facing=manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
        if(facing!=null && facing==CameraCharacteristics.LENS_FACING_EXTERNAL){selected=id;break;}
      }
      if(selected==null){handler.postDelayed(()->open(texture),500);return;}
      report.put("externalCameraId",selected);save();
      texture.setDefaultBufferSize(640,480);preview=new Surface(texture);
      yuv=ImageReader.newInstance(640,480,ImageFormat.YUV_420_888,2);
      jpeg=ImageReader.newInstance(640,480,ImageFormat.JPEG,2);
      yuv.setOnImageAvailableListener(reader->{
        try(Image image=reader.acquireLatestImage()) {
          if(image==null)return;frames++;
          Image.Plane plane=image.getPlanes()[0];ByteBuffer b=plane.getBuffer();
          int row=plane.getRowStride(),pixel=plane.getPixelStride();
          int[] points={b.get(120*row+160*pixel)&255,b.get(120*row+480*pixel)&255,
            b.get(360*row+160*pixel)&255,b.get(360*row+480*pixel)&255};
          if(points[0]<30)dark++;if(points[0]>225)bright++;
          report.put("darkFrames",dark);report.put("brightFrames",bright);
          // Camera2 Y can be limited-range after codec conversion. Identify
          // the checker by opposite spatial contrast, not an RGB white value.
          // Neutral frames have zero contrast and never count as motion.
          int polarity=points[0]-points[1]>120 && points[3]-points[2]>120?1:
            points[1]-points[0]>120 && points[2]-points[3]>120?-1:0;
          if(polarity>0)positive++;if(polarity<0)negative++;
          if(polarity!=0){if(lastPolarity!=0&&polarity!=lastPolarity)transitions++;lastPolarity=polarity;}
          report.put("positiveFrames",positive);report.put("negativeFrames",negative);report.put("patternTransitions",transitions);
          report.put("previewY",new org.json.JSONArray(points));report.put("width",image.getWidth());report.put("height",image.getHeight());
          if(frames%10==0)save();
          if(frames>=30&&!taking&&session!=null){taking=true;capture();}
        }catch(Exception e){fail("preview_failed_"+e.getClass().getSimpleName());}
      },handler);
      jpeg.setOnImageAvailableListener(reader->{
        try(Image image=reader.acquireNextImage()) {
          if(image==null)return;ByteBuffer buffer=image.getPlanes()[0].getBuffer();byte[] bytes=new byte[buffer.remaining()];buffer.get(bytes);
          Bitmap photo=BitmapFactory.decodeByteArray(bytes,0,bytes.length);
          if(photo==null){fail("captured_jpeg_invalid");return;}
          report.put("jpegBytes",bytes.length);report.put("jpegWidth",photo.getWidth());report.put("jpegHeight",photo.getHeight());
          report.put("photoRgb",new org.json.JSONArray(new int[]{photo.getPixel(photo.getWidth()/4,photo.getHeight()/4)&255,
            photo.getPixel(photo.getWidth()*3/4,photo.getHeight()/4)&255,photo.getPixel(photo.getWidth()/4,photo.getHeight()*3/4)&255,
            photo.getPixel(photo.getWidth()*3/4,photo.getHeight()*3/4)&255}));
          report.put("jpegCaptured",true);photo.recycle();save();
          if(getIntent().getBooleanExtra("record",false))handler.post(this::record);
        }catch(Exception e){fail("capture_failed_"+e.getClass().getSimpleName());}
      },handler);
      manager.openCamera(selected,new CameraDevice.StateCallback(){
        @Override public void onOpened(CameraDevice device){camera=device;configure();}
        @Override public void onDisconnected(CameraDevice device){device.close();fail("camera_disconnected");}
        @Override public void onError(CameraDevice device,int error){device.close();fail("camera_error_"+error);}
      },handler);
    }catch(Exception e){fail("camera_open_"+e.getClass().getSimpleName());}
  }
  private void configure() {
    try {camera.createCaptureSession(Arrays.asList(preview,yuv.getSurface(),jpeg.getSurface()),new CameraCaptureSession.StateCallback(){
      @Override public void onConfigured(CameraCaptureSession current){
        session=current;
        try {CaptureRequest.Builder request=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
          request.addTarget(preview);request.addTarget(yuv.getSurface());current.setRepeatingRequest(request.build(),null,handler);
        }catch(Exception e){fail("preview_configuration_failed");}
      }
      @Override public void onConfigureFailed(CameraCaptureSession current){fail("session_configuration_failed");}
    },handler);}catch(Exception e){fail("session_creation_failed");}
  }
  private void record() {
    try {
      session.stopRepeating();session.close();
      recorder=new MediaRecorder();recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
      recorder.setVideoSize(640,480);recorder.setVideoFrameRate(15);recorder.setVideoEncodingBitRate(1000000);
      recorder.setOutputFile(new File(getFilesDir(),"synthetic-camera.mp4").getAbsolutePath());recorder.prepare();
      Surface input=recorder.getSurface();
      camera.createCaptureSession(Arrays.asList(input,yuv.getSurface()),new CameraCaptureSession.StateCallback(){
        @Override public void onConfigured(CameraCaptureSession current){
          session=current;
          try {
            CaptureRequest.Builder q=camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            q.addTarget(input);q.addTarget(yuv.getSurface());current.setRepeatingRequest(q.build(),null,handler);
            recorder.start();recording=true;handler.postDelayed(MainActivity.this::finishRecording,4200);
          }catch(Exception e){fail("record_start_"+e.getClass().getSimpleName());}
        }
        @Override public void onConfigureFailed(CameraCaptureSession current){fail("record_configuration_failed");}
      },handler);
    }catch(Exception e){fail("record_prepare_"+e.getClass().getSimpleName());}
  }
  private void finishRecording(){
    try {
      session.stopRepeating();recorder.stop();recording=false;recorder.release();recorder=null;
      File file=new File(getFilesDir(),"synthetic-camera.mp4");
      MediaMetadataRetriever m=new MediaMetadataRetriever();m.setDataSource(file.getAbsolutePath());
      report.put("recordBytes",file.length());report.put("recordMilliseconds",Long.parseLong(m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)));
      report.put("recordWidth",Integer.parseInt(m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)));
      report.put("recordHeight",Integer.parseInt(m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)));
      report.put("recordHasAudio",m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)!=null);
      org.json.JSONArray values=new org.json.JSONArray();
      for(long t=300000;t<3500000;t+=400000){
        Bitmap frame=m.getFrameAtTime(t,MediaMetadataRetriever.OPTION_CLOSEST);
        if(frame==null)throw new IllegalStateException("frame_missing");
        values.put(frame.getPixel(frame.getWidth()/4,frame.getHeight()/4)&255);frame.recycle();
      }
      m.release();report.put("recordFrameRgb",values);report.put("recorded",true);save();
    }catch(Exception e){fail("record_finish_"+e.getClass().getSimpleName());}
  }
  private void capture() {
    try {CaptureRequest.Builder request=camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
      request.addTarget(jpeg.getSurface());session.capture(request.build(),new CameraCaptureSession.CaptureCallback(){
        @Override public void onCaptureFailed(CameraCaptureSession s,CaptureRequest q,CaptureFailure f){fail("still_capture_failed_"+f.getReason());}
      },handler);
    }catch(Exception e){fail("still_capture_request_failed");}
  }
  @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h){}
  @Override public void onSurfaceTextureUpdated(SurfaceTexture t){}
  @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t){return true;}
  @Override public void onDestroy(){if(recorder!=null){try{if(recording)recorder.stop();}catch(Exception ignored){}recorder.release();recorder=null;}if(session!=null)session.close();if(camera!=null)camera.close();if(yuv!=null)yuv.close();if(jpeg!=null)jpeg.close();if(preview!=null)preview.release();worker.quitSafely();super.onDestroy();}
}

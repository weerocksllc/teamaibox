package com.teamaibox.phonecamerarecord;

import android.app.Activity;
import android.os.*;
import android.graphics.*;
import android.hardware.camera2.*;
import android.media.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** Physical-camera test: no photo/video file and no microphone permission.
 * Private numeric samples live only in this disposable encrypted guest.
 * The host compares them in memory and retains only aggregate error/counts. */
public final class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
  private HandlerThread worker; private Handler handler;
  private CameraDevice camera; private CameraCaptureSession session;
  private ImageReader yuv,jpeg; private Surface preview;
  private final JSONObject report=new JSONObject();
  private int frames; private boolean taking;
  private MediaRecorder recorder; private boolean recording;
  private FileDescriptor recordingMemory;
  private void save() {
    try (FileOutputStream out=new FileOutputStream(new File(getFilesDir(),"sample.pending"))) {
      report.put("physicalInputTest",true);report.put("mediaSaved",false);
      report.put("previewFrames",frames);
      out.write(report.toString().getBytes("UTF-8"));
      out.getFD().sync();
      if(!new File(getFilesDir(),"sample.pending").renameTo(new File(getFilesDir(),"sample.json")))
        android.util.Log.e("PhoneUsbTest","sample_rename_failed");
    } catch(Exception error) {android.util.Log.e("PhoneUsbTest","sample_write_failed_"+error.getClass().getSimpleName());}
  }
  private void fail(String code) {try {report.put("error",code);save();}catch(Exception ignored){}}
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    worker=new HandlerThread("usb-camera-test");worker.start();handler=new Handler(worker.getLooper());
    save();
    TextureView view=new TextureView(this);view.setSurfaceTextureListener(this);setContentView(view);
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
          int row=plane.getRowStride(),pixel=plane.getPixelStride();JSONArray grid=new JSONArray();
          for(int y=30;y<480;y+=60)for(int x=40;x<640;x+=80)grid.put(b.get(y*row+x*pixel)&255);
          report.put("previewGrid",grid);report.put("width",image.getWidth());report.put("height",image.getHeight());
          if(frames%5==0)save();
          if(frames>=30&&!taking&&session!=null){taking=true;capture();}
        }catch(Exception e){fail("preview_failed_"+e.getClass().getSimpleName());}
      },handler);
      jpeg.setOnImageAvailableListener(reader->{
        try(Image image=reader.acquireNextImage()) {
          if(image==null)return;ByteBuffer b=image.getPlanes()[0].getBuffer();byte[] bytes=new byte[b.remaining()];b.get(bytes);
          Bitmap photo=BitmapFactory.decodeByteArray(bytes,0,bytes.length);
          if(photo==null){fail("jpeg_decode_failed");return;}
          report.put("jpegWidth",photo.getWidth());report.put("jpegHeight",photo.getHeight());
          JSONArray grid=new JSONArray();
          for(int y=30;y<480;y+=60)for(int x=40;x<640;x+=80){
            int rgb=photo.getPixel(x,y);grid.put((299*Color.red(rgb)+587*Color.green(rgb)+114*Color.blue(rgb)+500)/1000);
          }
          report.put("photoGrid",grid);report.put("jpegCaptured",true);
          photo.recycle();Arrays.fill(bytes,(byte)0);save();
          if(getIntent().getBooleanExtra("record",false))handler.post(this::record);
        }catch(Exception e){fail("photo_failed_"+e.getClass().getSimpleName());}
      },handler);
      manager.openCamera(selected,new CameraDevice.StateCallback(){
        @Override public void onOpened(CameraDevice device){camera=device;configure();}
        @Override public void onDisconnected(CameraDevice device){device.close();fail("camera_disconnected");}
        @Override public void onError(CameraDevice device,int error){device.close();fail("camera_error_"+error);}
      },handler);
    }catch(Exception e){fail("open_failed_"+e.getClass().getSimpleName());}
  }
  private void configure() {
    try {camera.createCaptureSession(Arrays.asList(preview,yuv.getSurface(),jpeg.getSurface()),new CameraCaptureSession.StateCallback(){
      @Override public void onConfigured(CameraCaptureSession current){
        session=current;
        try {CaptureRequest.Builder r=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
          r.addTarget(preview);r.addTarget(yuv.getSurface());current.setRepeatingRequest(r.build(),null,handler);
        }catch(Exception e){fail("preview_configuration_failed");}
      }
      @Override public void onConfigureFailed(CameraCaptureSession current){fail("session_configuration_failed");}
    },handler);}catch(Exception e){fail("session_creation_failed");}
  }

  private void closeMemory() {
    if(recordingMemory!=null){try{android.system.Os.close(recordingMemory);}catch(Exception ignored){}recordingMemory=null;}
  }
  private void record() {
    try {
      session.stopRepeating();session.close();
      recordingMemory=android.system.Os.memfd_create("camera-test",0);
      recorder=new MediaRecorder();recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
      recorder.setVideoSize(640,480);recorder.setVideoFrameRate(15);recorder.setVideoEncodingBitRate(1000000);
      recorder.setOutputFile(recordingMemory);recorder.prepare();
      Surface input=recorder.getSurface();
      camera.createCaptureSession(Arrays.asList(input,yuv.getSurface()),new CameraCaptureSession.StateCallback(){
        @Override public void onConfigured(CameraCaptureSession current){
          session=current;
          try{
            CaptureRequest.Builder q=camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            q.addTarget(input);q.addTarget(yuv.getSurface());current.setRepeatingRequest(q.build(),null,handler);
            recorder.start();recording=true;handler.postDelayed(MainActivity.this::finishRecording,4200);
          }catch(Exception e){fail("record_start_"+e.getClass().getSimpleName());}
        }
        @Override public void onConfigureFailed(CameraCaptureSession current){fail("record_configuration_failed");}
      },handler);
    }catch(Exception e){closeMemory();fail("record_prepare_"+e.getClass().getSimpleName());}
  }
  private void finishRecording(){
    MediaMetadataRetriever metadata=null;
    try{
      session.stopRepeating();recorder.stop();recording=false;recorder.release();recorder=null;
      metadata=new MediaMetadataRetriever();metadata.setDataSource(recordingMemory);
      report.put("recordBytes",android.system.Os.fstat(recordingMemory).st_size);
      report.put("recordMilliseconds",Long.parseLong(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)));
      report.put("recordWidth",Integer.parseInt(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)));
      report.put("recordHeight",Integer.parseInt(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)));
      report.put("recordHasAudio",metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)!=null);
      JSONArray variances=new JSONArray();
      for(long t=300000;t<3500000;t+=400000){
        Bitmap frame=metadata.getFrameAtTime(t,MediaMetadataRetriever.OPTION_CLOSEST);
        if(frame==null)throw new IllegalStateException("frame_missing");
        double sum=0,squares=0;int count=0;
        for(int y=30;y<480;y+=60)for(int x=40;x<640;x+=80){
          int rgb=frame.getPixel(x,y);double v=(299*Color.red(rgb)+587*Color.green(rgb)+114*Color.blue(rgb))/1000.0;
          sum+=v;squares+=v*v;count++;
        }
        variances.put(squares/count-(sum/count)*(sum/count));frame.recycle();
      }
      metadata.release();metadata=null;closeMemory();
      report.put("recordFrameVariances",variances);report.put("recordStorage","anonymous-memory");
      report.put("recordMemoryReleased",true);report.put("recorded",true);save();
    }catch(Exception e){fail("record_finish_"+e.getClass().getSimpleName());}
    finally{if(metadata!=null){try{metadata.release();}catch(Exception ignored){}}closeMemory();}
  }

  private void capture() {
    try {CaptureRequest.Builder r=camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
      r.addTarget(jpeg.getSurface());session.capture(r.build(),new CameraCaptureSession.CaptureCallback(){
        @Override public void onCaptureFailed(CameraCaptureSession s,CaptureRequest q,CaptureFailure f){
          try {report.put("captureFailureReason",f.getReason());report.put("captureFailureFrame",f.getFrameNumber());report.put("captureImageCaptured",f.wasImageCaptured());}catch(Exception ignored){}
          fail("photo_capture_failed");
        }
      },handler);
    }catch(Exception e){fail("photo_request_failed");}
  }
  @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h){}
  @Override public void onSurfaceTextureUpdated(SurfaceTexture t){}
  @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t){return true;}
  @Override public void onDestroy(){if(recorder!=null){try{if(recording)recorder.stop();}catch(Exception ignored){}recorder.release();}closeMemory();if(session!=null)session.close();if(camera!=null)camera.close();if(yuv!=null)yuv.close();if(jpeg!=null)jpeg.close();if(preview!=null)preview.release();worker.quitSafely();super.onDestroy();}
}

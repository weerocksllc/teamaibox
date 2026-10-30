package com.teamaibox.camerageometry;

import android.app.Activity;
import android.os.*;
import android.graphics.*;
import android.hardware.camera2.*;
import android.media.Image;
import android.media.ImageReader;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.*;
import org.json.*;

/** Read-only preview diagnostic: no photos, video, microphone, or account access.
 * Optional synthetic telemetry decodes only a checked test marker and sequence.
 */
public final class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
  TextureView view; FrameLayout stage; TextView label;
  HandlerThread thread; Handler worker; CameraDevice camera; CameraCaptureSession session;
  Surface surface; ImageReader reader; int orientation, width=640, height=480, frames;
  long firstFrame; boolean destroyed; final JSONObject report=new JSONObject();
  final JSONArray samples=new JSONArray();
  void save() {
    try (FileOutputStream f=openFileOutput("metrics.json",MODE_PRIVATE)) {
      report.put("frames",frames);report.put("elapsedMs",SystemClock.elapsedRealtime()-firstFrame);
      report.put("samples",samples);report.put("contentRecorded",false);
      f.write(report.toString().getBytes("UTF-8"));
    } catch(Exception ignored) {}
  }
  void fail(String code) {try {report.put("error",code);save();}catch(Exception ignored){} runOnUiThread(()->label.setText(code));}
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    thread=new HandlerThread("camera-geometry");thread.start();worker=new Handler(thread.getLooper());
    LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.BLACK);
    label=new TextView(this);label.setText("摄像头比例诊断 · 不拍照、不录制");label.setTextColor(Color.WHITE);label.setPadding(18,18,18,18);root.addView(label);
    stage=new FrameLayout(this);root.addView(stage,new LinearLayout.LayoutParams(-1,0,1));
    view=new TextureView(this);stage.addView(view,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
    view.setSurfaceTextureListener(this);stage.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->layout());
    setContentView(root);
  }
  void layout() {
    if(stage.getWidth()==0||stage.getHeight()==0)return;
    // Sensor 0 on an external landscape camera must NOT be treated as 90.
    int rotation=(orientation-getWindowManager().getDefaultDisplay().getRotation()*90+360)%360;
    boolean swap=rotation==90||rotation==270;
    double bw=swap?height:width,bh=swap?width:height;
    double scale=Math.min(stage.getWidth()/bw,stage.getHeight()/bh);
    int outW=(int)Math.round(bw*scale),outH=(int)Math.round(bh*scale);
    FrameLayout.LayoutParams p=new FrameLayout.LayoutParams(outW,outH,Gravity.CENTER);view.setLayoutParams(p);
    Matrix transform=new Matrix();
    if(swap){transform.setScale((float)outH/outW,(float)outW/outH,outW/2f,outH/2f);}
    transform.postRotate(rotation,outW/2f,outH/2f);view.setTransform(transform);
    try {report.put("sensorOrientation",orientation);report.put("displayRotation",getWindowManager().getDefaultDisplay().getRotation()*90);
      report.put("bufferWidth",width);report.put("bufferHeight",height);report.put("previewWidth",outW);report.put("previewHeight",outH);
      report.put("rotation",rotation);save();}catch(Exception ignored){}
  }
  @Override public void onSurfaceTextureAvailable(SurfaceTexture texture,int w,int h){worker.post(()->open(texture));}
  void open(SurfaceTexture texture) {
    try {
      CameraManager m=(CameraManager)getSystemService(CAMERA_SERVICE);String id=null;
      for(String c:m.getCameraIdList())if(m.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING)==CameraCharacteristics.LENS_FACING_EXTERNAL){id=c;break;}
      if(id==null){fail("external_camera_missing");return;}
      orientation=m.getCameraCharacteristics(id).get(CameraCharacteristics.SENSOR_ORIENTATION);runOnUiThread(this::layout);
      texture.setDefaultBufferSize(width,height);surface=new Surface(texture);
      reader=ImageReader.newInstance(width,height,ImageFormat.YUV_420_888,2);
      reader.setOnImageAvailableListener(r->{try(Image im=r.acquireLatestImage()){
        if(im==null)return;if(frames++==0)firstFrame=SystemClock.elapsedRealtime();
        // Enable only while a synthetic pattern source is supplied; no private
        // frame is copied or written, even if a caller accidentally enables it.
        if(getIntent().getBooleanExtra("synthetic",false)&&samples.length()<1200){
          Image.Plane plane=im.getPlanes()[0];ByteBuffer b=plane.getBuffer();int row=plane.getRowStride(),px=plane.getPixelStride();
          int magic=0,value=0,check=0;
          for(int i=0;i<16;i++)magic=(magic<<1)|((b.get(40*row+(10+i*20)*px)&255)>128?1:0);
          if(magic==0xa65c){
            for(int i=0;i<16;i++)value=(value<<1)|((b.get(80*row+(10+i*20)*px)&255)>128?1:0);
            for(int i=0;i<16;i++)check=(check<<1)|((b.get(120*row+(10+i*20)*px)&255)>128?1:0);
            if((value^check)==65535)samples.put(new JSONObject().put("sequence",value).put("atElapsedNs",SystemClock.elapsedRealtimeNanos()).put("sensorNs",im.getTimestamp()));
          }
        }
        if(frames%15==0){save();runOnUiThread(()->label.setText("640 × 480 · 等比例完整显示 · "+frames+" 帧\n不拍照、不录制"));}
      }catch(Exception e){fail("sample_"+e.getClass().getSimpleName());}},worker);
      m.openCamera(id,new CameraDevice.StateCallback(){
        public void onOpened(CameraDevice c){camera=c;configure();}
        public void onDisconnected(CameraDevice c){c.close();fail("disconnected");}
        public void onError(CameraDevice c,int code){c.close();fail("camera_error_"+code);}
      },worker);
    }catch(Exception e){fail("open_"+e.getClass().getSimpleName());}
  }
  void configure(){try {camera.createCaptureSession(Arrays.asList(surface,reader.getSurface()),new CameraCaptureSession.StateCallback(){
    public void onConfigured(CameraCaptureSession s){session=s;try {CaptureRequest.Builder q=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);q.addTarget(surface);q.addTarget(reader.getSurface());
      int requested=getIntent().getIntExtra("fps",15);
      if(requested!=15&&requested!=30)throw new IllegalArgumentException("fps");
      CameraManager manager=(CameraManager)getSystemService(CAMERA_SERVICE);
      android.util.Range<Integer>[] ranges=manager.getCameraCharacteristics(camera.getId()).get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
      JSONArray available=new JSONArray();android.util.Range<Integer> selected=null;
      for(android.util.Range<Integer> range:ranges){available.put(new JSONArray().put(range.getLower()).put(range.getUpper()));
        if(range.getUpper()==requested&&(selected==null||range.getLower()>selected.getLower()))selected=range;}
      report.put("availableFpsRanges",available);report.put("requestedFps",requested);
      if(selected==null)throw new IllegalStateException("requested_fps_unavailable");
      q.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,selected);
      s.setRepeatingRequest(q.build(),null,worker);}catch(Exception e){fail("repeat_"+e.getClass().getSimpleName());}}
    public void onConfigureFailed(CameraCaptureSession s){fail("configure_failed");}
  },worker);}catch(Exception e){fail("session_failed");}}
  public void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h){}
  public void onSurfaceTextureUpdated(SurfaceTexture t){}
  public boolean onSurfaceTextureDestroyed(SurfaceTexture t){return true;}
  @Override public void onDestroy(){destroyed=true;if(session!=null)session.close();if(camera!=null)camera.close();if(reader!=null)reader.close();if(surface!=null)surface.release();thread.quitSafely();super.onDestroy();}
}

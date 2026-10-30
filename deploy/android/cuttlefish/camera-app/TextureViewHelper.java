package com.android.camera;

import android.graphics.Matrix;
import android.graphics.RectF;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.view.TextureView;
import com.android.camera.app.CameraProvider;

/** Compile-time patch facade, NOT a replacement for the full AOSP class.
 * The builder copies only the two wrappers and fitExternalPreview into the
 * exact stock class; every original method, field and UI resource is retained.
 * AOSP upstream equivalent: call fitExternalPreview after each preview update.
 */
class TextureViewHelper {
    private TextureView mPreview;
    private CameraProvider mCameraProvider;
    private CaptureLayoutHelper mCaptureLayoutHelper;
    private float mAspectRatio;
    private boolean mAutoAdjustTransform;
    private boolean updateTransformLegacy(){throw new AssertionError("compile-only");}
    public void updateTransformLegacy(Matrix matrix){throw new AssertionError("compile-only");}
    private void updatePreviewArea(Matrix matrix){throw new AssertionError("compile-only");}

    private boolean updateTransform(){
        boolean updated=updateTransformLegacy();
        if(updated && mAutoAdjustTransform)fitExternalPreview();
        return updated;
    }
    public void updateTransform(Matrix matrix){
        updateTransformLegacy(matrix);
        fitExternalPreview();
    }
    private void fitExternalPreview(){
        if(mPreview==null || mCameraProvider==null || mCaptureLayoutHelper==null || mAspectRatio<=0)return;
        try {
            CameraManager manager=mPreview.getContext().getSystemService(CameraManager.class);
            if(manager==null)return;
            com.android.camera.device.CameraId key=mCameraProvider.getCurrentCameraId();
            String id;
            if(key!=null)id=key.getValue();
            else {
                // CaptureModule does not populate the legacy CameraProvider.
                // Only infer the device when Android exposes exactly one;
                // never guess which camera a multi-camera app is displaying.
                String[] ids=manager.getCameraIdList();
                if(ids.length!=1)return;
                id=ids[0];
            }
            CameraCharacteristics info=manager.getCameraCharacteristics(id);
            Integer lens=info.get(CameraCharacteristics.LENS_FACING);
            Integer sensor=info.get(CameraCharacteristics.SENSOR_ORIENTATION);
            // This correction is for the validated unrotated external input.
            // Never change built-in front/back cameras or unknown metadata.
            if(lens==null || lens!=CameraCharacteristics.LENS_FACING_EXTERNAL || sensor==null || sensor!=0)return;
            if(mPreview.getDisplay()==null)return;
            int degrees=mPreview.getDisplay().getRotation()*90;
            RectF bounds=mCaptureLayoutHelper.getPreviewRect();
            float[] values=ExternalPreviewGeometry.matrix(mPreview.getWidth(),mPreview.getHeight(),
                mAspectRatio,-degrees,bounds.left,bounds.top,bounds.width(),bounds.height());
            if(values==null)return;
            Matrix corrected=new Matrix();corrected.setValues(values);
            mPreview.setTransform(corrected);updatePreviewArea(corrected);
        } catch(android.hardware.camera2.CameraAccessException | IllegalArgumentException ignored) {
            // Camera closed or removed during a layout change: leave the
            // original app behavior, rather than crashing or changing input.
        }
    }
}

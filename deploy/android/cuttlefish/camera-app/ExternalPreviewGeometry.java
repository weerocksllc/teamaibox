package com.android.camera;

/** The TextureView first stretches its buffer to the view. Undo that stretch,
 * rotate the source, then fit it uniformly inside the available preview area.
 * No input pixels, camera metadata, capture size or other app is modified. */
public final class ExternalPreviewGeometry {
    public static float[] matrix(float viewWidth, float viewHeight, float aspect,
            int rotation, float left, float top, float width, float height) {
        if (!(viewWidth>0 && viewHeight>0 && aspect>0 && width>0 && height>0)
                || !Float.isFinite(aspect) || rotation%90!=0) return null;
        rotation=(rotation%360+360)%360;
        int cos=rotation==0?1:rotation==180?-1:0;
        int sin=rotation==90?1:rotation==270?-1:0;
        float rotatedWidth=cos==0?1:aspect,rotatedHeight=cos==0?aspect:1;
        float minX=rotation==90?-1:rotation==180?-aspect:0;
        float minY=rotation==180?-1:rotation==270?-aspect:0;
        float scale=Math.min(width/rotatedWidth,height/rotatedHeight);
        return new float[]{scale*cos*aspect/viewWidth,-scale*sin/viewHeight,
            left+(width-scale*rotatedWidth)/2-scale*minX,
            scale*sin*aspect/viewWidth,scale*cos/viewHeight,
            top+(height-scale*rotatedHeight)/2-scale*minY,0,0,1};
    }
    private ExternalPreviewGeometry(){}
}

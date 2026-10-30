import com.android.camera.ExternalPreviewGeometry;
public class GeometryTest {
    static void close(float a,float b){if(Math.abs(a-b)>.01)throw new AssertionError(a+" != "+b);}
    public static void main(String[] args){
        for(int rotation:new int[]{0,90,180,270})for(float[] view:new float[][]{{720,1280},{1280,720},{480,480}}){
            float[] m=ExternalPreviewGeometry.matrix(view[0],view[1],4f/3,rotation,10,20,600,800);
            // One original source pixel has the same displayed length along
            // both axes, including after rotating portrait/landscape.
            float sx=view[0]/640,sy=view[1]/480;
            close((float)Math.hypot(m[0]*sx,m[3]*sx),(float)Math.hypot(m[1]*sy,m[4]*sy));
            for(float x:new float[]{0,view[0]})for(float y:new float[]{0,view[1]}){
                float px=m[0]*x+m[1]*y+m[2],py=m[3]*x+m[4]*y+m[5];
                if(px<9.99||px>610.01||py<19.99||py>820.01)throw new AssertionError("cropped");
            }
        }
        if(ExternalPreviewGeometry.matrix(0,10,1,0,0,0,10,10)!=null)throw new AssertionError();
        System.out.println("12 aspect/rotation cases and invalid dimensions passed");
    }
}

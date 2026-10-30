import java.io.File;
import java.util.*;
import com.android.tools.smali.dexlib2.*;
import com.android.tools.smali.dexlib2.iface.*;
import com.android.tools.smali.dexlib2.immutable.*;
import com.android.tools.smali.dexlib2.writer.pool.DexPool;

/** Narrow bytecode packaging of source-compiled preview methods. No smali
 * textual replacement, resource rebuild, signature bypass or stub deployment. */
public class PatchCameraDex {
    public static void main(String[] args) throws Exception {
        String type="Lcom/android/camera/TextureViewHelper;";
        String geometry="Lcom/android/camera/ExternalPreviewGeometry;";
        DexFile original=DexFileFactory.loadDexFile(new File(args[0]),null);
        DexFile patch=DexFileFactory.loadDexFile(new File(args[1]),null);
        ClassDef facade=null,helper=null;
        for(ClassDef c:patch.getClasses()) {
            if(c.getType().equals(type))facade=c;
            if(c.getType().equals(geometry))helper=c;
        }
        if(facade==null || helper==null)throw new AssertionError("compiled classes missing");
        ArrayList<ClassDef> classes=new ArrayList<>();int changed=0,renamed=0,added=0;
        for(ClassDef c:original.getClasses()) {
            if(c.getType().equals(geometry))throw new AssertionError("already patched");
            if(!c.getType().equals(type)){classes.add(c);continue;}
            changed++;
            List<Method> methods=new ArrayList<>();
            for(Method m:c.getMethods()) {
                if(m.getName().equals("updateTransform")) {
                    renamed++;
                    methods.add(new ImmutableMethod(m.getDefiningClass(),"updateTransformLegacy",m.getParameters(),
                        m.getReturnType(),m.getAccessFlags(),m.getAnnotations(),m.getHiddenApiRestrictions(),m.getImplementation()));
                } else methods.add(m);
            }
            for(Method m:facade.getMethods())if(m.getName().equals("updateTransform") || m.getName().equals("fitExternalPreview")) {
                methods.add(m);added++;
            }
            classes.add(new ImmutableClassDef(c.getType(),c.getAccessFlags(),c.getSuperclass(),c.getInterfaces(),
                c.getSourceFile(),c.getAnnotations(),c.getFields(),methods));
        }
        if(changed!=1 || renamed!=2 || added!=3)throw new AssertionError("unexpected stock methods");
        classes.add(helper);
        DexPool.writeTo(args[2],new ImmutableDexFile(original.getOpcodes(),classes));
        DexFile verify=DexFileFactory.loadDexFile(new File(args[2]),null);
        if(verify.getClasses().size()!=original.getClasses().size()+1)throw new AssertionError("class drift");
        System.out.println("Retained all stock classes; wrapped two methods; added one geometry helper");
    }
}

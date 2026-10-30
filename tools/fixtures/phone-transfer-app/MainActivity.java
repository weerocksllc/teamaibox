package com.teamaibox.phonefixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        text.setTextSize(24);
        text.setPadding(24, 48, 24, 24);
        try {
            File proof = new File(getFilesDir(), "proof.txt");
            if (!proof.exists()) {
                try (FileOutputStream stream = new FileOutputStream(proof)) {
                    stream.write("synthetic-phone-app-data-v1\n".getBytes(StandardCharsets.UTF_8));
                    stream.getFD().sync();
                }
            }
            text.setText("Phone transfer check\nAPK installed; app data saved.");
        } catch (Exception error) {
            text.setText("Phone transfer check\nApp data write failed.");
        }
        setContentView(text);
    }
}

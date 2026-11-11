package cc.colorc.lofa;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** PIN ciphertext is device-bound and excluded from Android backup. Never exposed to JS. */
final class AttendanceStore {
    private static final String KEY = "lofa_attendance_pin_v1";
    private final Context context;
    final SharedPreferences prefs;

    AttendanceStore(Context context) {
        this.context = context.getApplicationContext();
        prefs = context.getSharedPreferences("attendance", Context.MODE_PRIVATE);
    }

    boolean enabled() { return prefs.getBoolean("enabled", false); }
    int days() { return prefs.getInt("days", AttendancePlan.WEEKDAYS) & 127; }
    int time(int slot) { return prefs.getInt("time_" + slot, AttendancePlan.DEFAULT_TIMES[slot]); }
    boolean blocked() { return prefs.getBoolean("pin_blocked", false); }
    private AtomicFile pinFile() { return new AtomicFile(new File(context.getNoBackupFilesDir(), "attendance-pin.bin")); }
    boolean hasPin() { return pinFile().getBaseFile().exists(); }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    void savePin(char[] pin) throws Exception {
        if (pin.length < 4 || pin.length > 16) throw new IllegalArgumentException("请输入 4–16 位数字 PIN");
        for (char value : pin) if (value < '0' || value > '9') throw new IllegalArgumentException("仅支持数字 PIN");
        byte[] plain = new byte[pin.length];
        for (int i = 0; i < pin.length; i++) plain[i] = (byte) pin[i];
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(plain);
            byte[] iv = cipher.getIV();
            ByteBuffer data = ByteBuffer.allocate(1 + iv.length + encrypted.length);
            data.put((byte) iv.length).put(iv).put(encrypted);
            AtomicFile file = pinFile();
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(data.array());
                file.finishWrite(output);
            } catch (Exception error) {
                if (output != null) file.failWrite(output);
                throw error;
            }
            prefs.edit().putBoolean("pin_blocked", false).commit();
        } finally { Arrays.fill(plain, (byte) 0); }
    }

    char[] loadPin() throws Exception {
        byte[] data = pinFile().readFully();
        int length = data[0] & 255;
        if (length != 12 || data.length <= length + 17) throw new IllegalStateException("PIN storage unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(data, 1, length + 1)));
        byte[] plain = cipher.doFinal(data, length + 1, data.length - length - 1);
        try {
            char[] pin = new char[plain.length];
            for (int i = 0; i < plain.length; i++) pin[i] = (char) plain[i];
            return pin;
        } finally { Arrays.fill(plain, (byte) 0); }
    }

    void clearPin() {
        pinFile().delete();
        prefs.edit().putBoolean("enabled", false).putBoolean("pin_blocked", false).commit();
    }

    synchronized void record(String message) {
        String stamp = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).format(new Date());
        String history = stamp + "  " + message + "\n" + prefs.getString("history", "");
        String[] lines = history.split("\n");
        if (lines.length > 20) history = android.text.TextUtils.join("\n", Arrays.copyOf(lines, 20));
        prefs.edit().putString("history", history).commit();
    }
}

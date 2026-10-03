package team.anthill.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;

/**
 * Мелочи оболочки, которых нет в готовых плагинах (ТЗ-9).
 *
 * `pushAvailable` — есть ли Firebase в этой сборке. Без `google-services.json`
 * FirebaseApp не поднимается, а `PushNotifications.register()` тогда не возвращает
 * ошибку в JS, а роняет весь процесс (Capacitor 8 перебрасывает исключение плагина
 * как RuntimeException). Первый выпуск ровно так и закрывался сразу после входа.
 * Спрашиваем заранее — через отражение, чтобы не тянуть Firebase в зависимости
 * приложения: он приходит вместе с плагином push, если приходит вообще.
 *
 * `canInstall` / `installUpdate` — обновление изнутри приложения. Магазинов у нас нет
 * намеренно (D-03), и до сих пор обновление выглядело так: открыть браузер, скачать
 * файл, найти его в загрузках, разрешить установку, нажать. Половина людей на этом
 * пути теряется и остаётся на старой сборке. Теперь приложение скачивает APK само,
 * сверяет его с контрольной суммой из latest.json и отдаёт системному установщику —
 * человеку остаётся одно нажатие в системном окне.
 */
@CapacitorPlugin(name = "AnthillNative")
public class AnthillNativePlugin extends Plugin {

    /**
     * Куда идёт звук созвона (задача #1464): «как в Телеграме» — в разговорный динамик у
     * уха, а громкая связь — кнопкой.
     *
     * Chromium, на котором работает WebView, при звонке сам включает громкую связь, если
     * нет гарнитуры, — поэтому звук всегда шёл в громкий динамик. Веб повлиять на это не
     * может: маршрут звука выбирает только ОС. route: earpiece | speaker | normal.
     * Подключены проводные или Bluetooth-наушники — звук идёт в них, а не к уху.
     * normal — вернуть как было после созвона.
     */
    @PluginMethod
    public void setAudioRoute(PluginCall call) {
        String route = call.getString("route", "earpiece");
        JSObject r = new JSObject();
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if ("normal".equals(route)) {
                if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
                am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
                r.put("route", "normal");
                call.resolve(r);
                return;
            }
            boolean speaker = "speaker".equals(route);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            String applied = speaker ? "speaker" : "earpiece";
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo headset = null, wanted = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                        || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                        || t == AudioDeviceInfo.TYPE_BLE_HEADSET) headset = d;
                    if (t == (speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)) wanted = d;
                }
                AudioDeviceInfo target = (!speaker && headset != null) ? headset : wanted;
                if (target != null) am.setCommunicationDevice(target);
                if (!speaker && headset != null) applied = "headset";
            } else {
                am.setSpeakerphoneOn(speaker);
            }
            r.put("route", applied);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Не удалось переключить звук: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pushAvailable(PluginCall call) {
        boolean available;
        try {
            Class<?> firebase = Class.forName("com.google.firebase.FirebaseApp");
            Object apps = firebase.getMethod("getApps", Context.class).invoke(null, getContext());
            available = apps instanceof List && !((List<?>) apps).isEmpty();
        } catch (Throwable t) {
            available = false;
        }
        JSObject result = new JSObject();
        result.put("available", available);
        call.resolve(result);
    }

    /**
     * Умеет ли эта оболочка ставить обновление сама и разрешено ли ей это сейчас.
     *
     * supported — Android (на iOS приложение ставится не так); allowed — человек уже
     * разрешил установку из нашего приложения. Разрешение спрашиваем не заранее, а в тот
     * момент, когда он нажал «Обновить»: просьба без повода выглядит подозрительно.
     */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", true);
        r.put("allowed", allowedToInstall());
        call.resolve(r);
    }

    /** Открыть системную настройку «разрешить установку приложений из этого источника». */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("нет такой настройки: " + t.getMessage());
        }
    }

    /**
     * Скачать APK и отдать его системному установщику.
     *
     * Качаем в свой каталог на внешней памяти — туда можно без разрешений, и оттуда
     * FileProvider отдаёт установщику временный доступ ровно к этому файлу. Сумму
     * считаем на лету: битый или подменённый файл до установщика не доходит.
     *
     * Ответ не «поставили», а «установщик открыт»: решение всё равно за человеком, и
     * система покажет ему, что именно ставится.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256", "");
        final String version = call.getString("version", "new");
        if (url == null || url.isEmpty()) {
            call.reject("не указан адрес обновления");
            return;
        }
        if (!allowedToInstall()) {
            call.resolve(status("needs_permission", null));
            return;
        }
        // Отдельный поток: качаем десятки мегабайт, а главный поток рисует экран.
        new Thread(() -> {
            try {
                File file = download(url, sha256, version);
                launchInstaller(file);
                call.resolve(status("installing", null));
            } catch (Throwable t) {
                call.resolve(status("failed", String.valueOf(t.getMessage())));
            }
        }, "anthill-update").start();
    }

    private JSObject status(String status, String message) {
        JSObject r = new JSObject();
        r.put("status", status);
        if (message != null) r.put("message", message);
        return r;
    }

    private boolean allowedToInstall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        try {
            return getContext().getPackageManager().canRequestPackageInstalls();
        } catch (Throwable t) {
            return false;
        }
    }

    private File download(String url, String expected, String version) throws Exception {
        File dir = new File(getContext().getExternalFilesDir(null), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("некуда сохранить обновление");
        File out = new File(dir, "anthill-" + version.replaceAll("[^0-9A-Za-z.]", "") + ".apk");

        // Этот выпуск уже скачан и сходится с суммой — отдаём его установщику сразу.
        // Повторное «Установить» после потерянного окна установки (Android сначала спросил
        // разрешение и вернул человека к нам) не должно снова качать двадцать мегабайт.
        if (out.exists() && expected != null && !expected.isEmpty() && expected.equalsIgnoreCase(sha256Of(out))) {
            progress(out.length(), out.length());
            return out;
        }

        // Прошлые загрузки не копим: каждая весит больше двадцати мегабайт.
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                if (!f.delete()) f.deleteOnExit();
            }
        }

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(60_000);
        conn.connect();
        int code = conn.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) throw new IllegalStateException("сервер ответил " + code);

        int total = conn.getContentLength();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long done = 0;
        long shown = 0;
        try (InputStream in = conn.getInputStream(); FileOutputStream file = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                file.write(buf, 0, n);
                digest.update(buf, 0, n);
                done += n;
                // Полоску двигаем не на каждый кусок: событий в JS было бы тысячи.
                if (done - shown >= 512 * 1024) {
                    shown = done;
                    progress(done, total);
                }
            }
        } finally {
            conn.disconnect();
        }
        progress(done, total);

        if (expected != null && !expected.isEmpty()) {
            StringBuilder sum = new StringBuilder();
            for (byte b : digest.digest()) sum.append(String.format(Locale.US, "%02x", b));
            if (!sum.toString().equalsIgnoreCase(expected)) {
                if (!out.delete()) out.deleteOnExit();
                throw new IllegalStateException("файл скачался повреждённым");
            }
        }
        return out;
    }

    private String sha256Of(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
            StringBuilder sum = new StringBuilder();
            for (byte x : digest.digest()) sum.append(String.format(Locale.US, "%02x", x));
            return sum.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private void launchInstaller(File file) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private void progress(long loaded, long total) {
        JSObject e = new JSObject();
        e.put("loaded", loaded);
        e.put("total", total);
        notifyListeners("updateProgress", e);
    }
}

package team.anthill.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Обновление веб-части по воздуху (ТЗ-34, этап D) — без нового APK и без чужих сервисов.
 *
 * Как устроено. Капаситор сам умеет брать веб-часть не из assets, а из каталога на
 * устройстве: при запуске Bridge читает `serverBasePath` из `CapWebViewSettings` и, если
 * каталог есть, отдаёт файлы оттуда (а на новом APK сбрасывает путь — встроенный бандл
 * всегда свежее). Мы только кладём туда проверенный бандл и решаем, какой путь записать.
 *
 * Состояние — в своих настройках `QevoBundles`:
 *   stable  — подтверждённый бандл («живой»), пусто = встроенный в APK;
 *   pending — скачан и распакован, ждёт применения (следующий запуск или уход в фон);
 *   trial   — применён, но ещё не сказал «живой»; trialStarted — его уже запускали;
 *   bad     — версии, которые не подтвердились: больше не ставим.
 *
 * Откат. Новый бандл должен вызвать `bundleReady` за 15 с после старта. Не вызвал, пока
 * приложение на экране, — плагин сразу возвращает прежний бандл; приложение закрыли
 * раньше — возврат при следующем запуске (`prepareLaunch`, до старта моста).
 * На устройстве — не больше двух бандлов: подтверждённый и новый.
 */
final class BundleUpdater {
    static final String PREFS = "QevoBundles";
    /** Те же имена, что у com.getcapacitor.plugin.WebView: их читает Bridge при запуске. */
    private static final String CAP_PREFS = "CapWebViewSettings";
    private static final String CAP_PATH = "serverBasePath";
    static final long CONFIRM_MS = 15_000;

    private static final long MAX_ZIP_BYTES = 80L * 1024 * 1024;
    private static final long MAX_UNZIPPED_BYTES = 250L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10_000;
    private static final Pattern VERSION = Pattern.compile("^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private BundleUpdater() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    static File root(Context c) {
        return new File(c.getFilesDir(), "bundles");
    }

    private static File dirOf(Context c, String version) {
        return new File(root(c), version);
    }

    private static boolean usable(Context c, String version) {
        return version != null && !version.isEmpty() && new File(dirOf(c, version), "index.html").isFile();
    }

    static String nativeName(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return p.versionName != null ? p.versionName : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static String nativeId(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return p.getLongVersionCode() + "/" + p.versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** Записать путь, который Bridge возьмёт при запуске. "" — встроенный бандл из APK. */
    private static void setCapPath(Context c, String path) {
        c.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE).edit().putString(CAP_PATH, path).commit();
    }

    private static Set<String> bad(SharedPreferences p) {
        return new HashSet<>(p.getStringSet("bad", new HashSet<>()));
    }

    /** Путь подтверждённого бандла или null — встроенный. */
    private static String stablePath(Context c, SharedPreferences p) {
        String stable = p.getString("stable", "");
        return usable(c, stable) ? dirOf(c, stable).getAbsolutePath() : null;
    }

    /**
     * До старта моста (MainActivity.onCreate, до super): откатить неподтвердившийся бандл
     * и применить скачанный. commit, а не apply: процесс может умереть сразу после.
     */
    static synchronized void prepareLaunch(Context c) {
        try {
            SharedPreferences p = prefs(c);
            String nid = nativeId(c);
            if (!nid.equals(p.getString("native", null))) {
                // Новый APK: Bridge сам вернётся на встроенный бандл — он новее скачанных.
                // Чужие для этой оболочки бандлы и пометки стираем.
                deleteTree(root(c));
                p.edit().clear().putString("native", nid).commit();
                return;
            }
            String trial = p.getString("trial", null);
            if (trial != null) {
                if (p.getBoolean("trialStarted", false)) rollbackLocked(c, p, trial);
                else p.edit().putBoolean("trialStarted", true).commit();
            }
            String pending = p.getString("pending", null);
            if (pending != null && p.getString("trial", null) == null) {
                if (!bad(p).contains(pending) && usable(c, pending)) {
                    setCapPath(c, dirOf(c, pending).getAbsolutePath());
                    p.edit().putString("trial", pending).putBoolean("trialStarted", true).remove("pending").commit();
                } else {
                    p.edit().remove("pending").commit();
                }
            }
            // Bridge подхватит путь, только если каталог есть; иначе — встроенный. Сверяем.
            String stable = p.getString("stable", "");
            if (p.getString("trial", null) == null && !stable.isEmpty() && !usable(c, stable)) {
                p.edit().putString("stable", "").commit();
                setCapPath(c, "");
            }
        } catch (Throwable t) {
            // Обновление по воздуху не должно мешать запуску: в худшем случае — встроенный бандл.
            setCapPath(c, "");
        }
    }

    private static void rollbackLocked(Context c, SharedPreferences p, String trial) {
        Set<String> bad = bad(p);
        bad.add(trial);
        String path = stablePath(c, p);
        setCapPath(c, path != null ? path : "");
        p.edit().putStringSet("bad", bad).remove("trial").remove("trialStarted").commit();
        deleteTree(dirOf(c, trial));
    }

    /** Бандл, который сейчас идёт на пробу (уже запущен), или null. */
    static synchronized String runningTrial(Context c) {
        SharedPreferences p = prefs(c);
        return p.getBoolean("trialStarted", false) ? p.getString("trial", null) : null;
    }

    /**
     * Откатить пробный бандл прямо сейчас. Возвращает путь, на который вернуться, ""
     * — встроенный, null — откатывать нечего (бандл уже подтвердился).
     */
    static synchronized String rollbackNow(Context c, String trial) {
        SharedPreferences p = prefs(c);
        if (trial == null || !trial.equals(p.getString("trial", null))) return null;
        rollbackLocked(c, p, trial);
        String path = stablePath(c, p);
        return path != null ? path : "";
    }

    /** Бандл сказал «живой»: он становится подтверждённым, лишнее удаляется. */
    static synchronized boolean confirm(Context c, String version) {
        SharedPreferences p = prefs(c);
        String trial = p.getString("trial", null);
        if (trial == null || !trial.equals(version)) return false;
        p.edit().putString("stable", trial).remove("trial").remove("trialStarted").commit();
        prune(c, p);
        return true;
    }

    /** Применить скачанный бандл сейчас: путь для Bridge или null, если нечего. */
    static synchronized String applyPending(Context c) {
        SharedPreferences p = prefs(c);
        String pending = p.getString("pending", null);
        if (pending == null || p.getString("trial", null) != null) return null;
        if (bad(p).contains(pending) || !usable(c, pending)) {
            p.edit().remove("pending").commit();
            return null;
        }
        String path = dirOf(c, pending).getAbsolutePath();
        setCapPath(c, path);
        p.edit().putString("trial", pending).putBoolean("trialStarted", true).remove("pending").commit();
        return path;
    }

    static synchronized String get(Context c, String key) {
        return prefs(c).getString(key, null);
    }

    static synchronized List<String> badList(Context c) {
        return new ArrayList<>(bad(prefs(c)));
    }

    /**
     * Скачать, проверить и распаковать бандл. Возвращает статус: ready (ждёт применения),
     * current (он уже стоит), bad (помечен битым), busy (идёт проба другого).
     */
    static String download(Context c, String version, String url, String sha256, String signature, String publicKey) throws Exception {
        if (version == null || !VERSION.matcher(version).matches()) throw new IllegalArgumentException("плохая версия бандла");
        String expected = sha256 == null ? "" : sha256.trim().toLowerCase(Locale.US);
        if (!SHA256.matcher(expected).matches()) throw new IllegalArgumentException("нет контрольной суммы");
        if (!allowedUrl(url)) throw new IllegalArgumentException("бандл только с нашего домена по https");
        boolean signed = publicKey != null && !publicKey.trim().isEmpty();
        if (signed && (signature == null || signature.isEmpty())) throw new SecurityException("бандл без подписи");

        synchronized (BundleUpdater.class) {
            SharedPreferences p = prefs(c);
            if (bad(p).contains(version)) return "bad";
            if (p.getString("trial", null) != null) return "busy";
            if (version.equals(p.getString("stable", "")) && usable(c, version)) return "current";
            if (version.equals(p.getString("pending", null)) && usable(c, version)) return "ready";
        }

        File zip = new File(c.getCacheDir(), "bundle-download.zip");
        try {
            String got = fetch(url, zip);
            if (!got.equals(expected)) throw new SecurityException("бандл скачался повреждённым");
            if (signed && !verify(publicKey, version + "\n" + expected, signature)) throw new SecurityException("подпись бандла не сходится");

            File tmp = new File(root(c), version + ".tmp");
            deleteTree(tmp);
            unzip(zip, tmp);
            if (!new File(tmp, "index.html").isFile()) {
                deleteTree(tmp);
                throw new IllegalStateException("в бандле нет index.html");
            }
            synchronized (BundleUpdater.class) {
                SharedPreferences p = prefs(c);
                if (p.getString("trial", null) != null) {
                    deleteTree(tmp);
                    return "busy";
                }
                File dir = dirOf(c, version);
                deleteTree(dir);
                if (!tmp.renameTo(dir)) {
                    deleteTree(tmp);
                    throw new IllegalStateException("не удалось сохранить бандл");
                }
                p.edit().putString("pending", version).commit();
                prune(c, p);
            }
            return "ready";
        } finally {
            if (!zip.delete()) zip.deleteOnExit();
        }
    }

    static boolean allowedUrl(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
            return "https".equals(u.getScheme()) && u.getUserInfo() == null
                && (host.equals("qevo.one") || host.endsWith(".qevo.one") || host.equals("anthill.team") || host.endsWith(".anthill.team"));
        } catch (Exception e) {
            return false;
        }
    }

    private static String fetch(String url, File out) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        // Переадресация не нужна и опасна: с https на чужой адрес ушли бы молча.
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(60_000);
        try {
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IllegalStateException("сервер ответил " + code);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long done = 0;
            try (InputStream in = new BufferedInputStream(conn.getInputStream()); FileOutputStream file = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    done += n;
                    if (done > MAX_ZIP_BYTES) throw new IllegalStateException("бандл слишком большой");
                    file.write(buf, 0, n);
                    digest.update(buf, 0, n);
                }
            }
            return hex(digest.digest());
        } finally {
            conn.disconnect();
        }
    }

    /** ECDSA P-256 (SHA256withECDSA), ключ — X.509 DER в base64: есть на любом Android. */
    private static boolean verify(String publicKeyB64, String message, String signatureB64) {
        try {
            byte[] der = Base64.decode(publicKeyB64.trim(), Base64.DEFAULT);
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(message.getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.decode(signatureB64.trim(), Base64.DEFAULT));
        } catch (Exception e) {
            return false;
        }
    }

    /** Распаковка с защитой от zip-slip: ни один файл не выходит за пределы каталога. */
    private static void unzip(File zip, File target) throws Exception {
        if (!target.mkdirs() && !target.isDirectory()) throw new IllegalStateException("некуда распаковать бандл");
        String base = target.getCanonicalPath() + File.separator;
        long total = 0;
        int entries = 0;
        try (ZipInputStream in = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = in.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) throw new SecurityException("в бандле слишком много файлов");
                String name = e.getName();
                if (name.startsWith("/") || name.startsWith("\\") || name.contains("..") || name.indexOf('\0') >= 0) {
                    throw new SecurityException("недопустимый путь в бандле: " + name);
                }
                File out = new File(target, name);
                if (!out.getCanonicalPath().startsWith(base)) throw new SecurityException("путь вне каталога бандла: " + name);
                if (e.isDirectory()) {
                    if (!out.mkdirs() && !out.isDirectory()) throw new IllegalStateException("не создать каталог " + name);
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) throw new IllegalStateException("не создать каталог для " + name);
                try (FileOutputStream f = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_UNZIPPED_BYTES) throw new SecurityException("бандл распаковывается слишком большим");
                        f.write(buf, 0, n);
                    }
                }
            }
        } catch (Exception ex) {
            deleteTree(target);
            throw ex;
        }
    }

    /** Оставить только подтверждённый, пробный и скачанный — остальное удалить. */
    private static void prune(Context c, SharedPreferences p) {
        Set<String> keep = new HashSet<>();
        for (String k : new String[] { "stable", "trial", "pending" }) {
            String v = p.getString(k, null);
            if (v != null && !v.isEmpty()) keep.add(v);
        }
        File[] all = root(c).listFiles();
        if (all == null) return;
        for (File f : all) if (!keep.contains(f.getName())) deleteTree(f);
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        if (!f.delete()) f.deleteOnExit();
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }
}

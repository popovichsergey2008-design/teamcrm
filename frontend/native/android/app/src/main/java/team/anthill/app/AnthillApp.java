package team.anthill.app;

import android.app.Application;
import android.os.Build;

import org.json.JSONObject;

import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Последний свидетель падения (ТЗ-9, волна 12).
 *
 * Приложение закрылось при запуске — до входа, до того, как заработал JS, и на телефоне
 * у человека нет ни logcat, ни Android Studio. Единственный, кто видел причину, — сам
 * процесс в последнюю секунду жизни. Поэтому необработанное исключение уходит на наш
 * сервер (стек, версия, модель, Android) до того, как процесс умрёт, а потом отдаётся
 * системному обработчику — телефон покажет обычное «приложение остановлено».
 *
 * Сеть — в отдельном потоке с коротким ожиданием: на главном потоке Android сеть
 * запрещает, а ждать вечно нельзя, иначе падение превратится в зависание.
 */
public class AnthillApp extends Application {
    private static final String CRASH_URL = "https://anthill.team/api/mobile/crash";
    private static final int WAIT_MS = 4000;
    private static final int MAX_STACK = 15000;

    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                report(error);
            } catch (Throwable ignored) {
                // отчёт о падении не должен падать сам
            }
            if (previous != null) previous.uncaughtException(thread, error);
            else System.exit(2);
        });
    }

    private void report(Throwable error) throws InterruptedException {
        final String body = payload(error);
        Thread sender = new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(CRASH_URL).openConnection();
                c.setConnectTimeout(2500);
                c.setReadTimeout(2500);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode();
            } catch (Throwable ignored) {
                // нет сети — что ж, падение не станет от этого хуже
            } finally {
                if (c != null) c.disconnect();
            }
        }, "anthill-crash-report");
        sender.setDaemon(true);
        sender.start();
        sender.join(WAIT_MS);
    }

    private String payload(Throwable error) {
        String version;
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable t) {
            version = "unknown";
        }
        StringWriter sw = new StringWriter();
        error.printStackTrace(new PrintWriter(sw));
        String stack = sw.toString();
        if (stack.length() > MAX_STACK) stack = stack.substring(0, MAX_STACK);

        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));

        JSONObject json = new JSONObject();
        try {
            json.put("appVersion", version == null ? "unknown" : version);
            json.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            json.put("os", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
            json.put("stack", stack);
            json.put("at", iso.format(new Date()));
        } catch (Throwable ignored) {
            // JSONObject.put бросает только на NaN — здесь их нет
        }
        return json.toString();
    }
}

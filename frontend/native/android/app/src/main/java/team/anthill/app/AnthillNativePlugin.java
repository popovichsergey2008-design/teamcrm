package team.anthill.app;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Мелочи оболочки, которых нет в готовых плагинах (ТЗ-9).
 *
 * `pushAvailable` — есть ли Firebase в этой сборке. Без `google-services.json`
 * FirebaseApp не поднимается, а `PushNotifications.register()` тогда не возвращает
 * ошибку в JS, а роняет весь процесс (Capacitor 8 перебрасывает исключение плагина
 * как RuntimeException). Первый выпуск ровно так и закрывался сразу после входа.
 * Спрашиваем заранее — через отражение, чтобы не тянуть Firebase в зависимости
 * приложения: он приходит вместе с плагином push, если приходит вообще.
 */
@CapacitorPlugin(name = "AnthillNative")
public class AnthillNativePlugin extends Plugin {

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
}

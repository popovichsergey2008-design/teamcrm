package team.anthill.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой плагин регистрируется до моста: иначе JS его не увидит.
        registerPlugin(AnthillNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

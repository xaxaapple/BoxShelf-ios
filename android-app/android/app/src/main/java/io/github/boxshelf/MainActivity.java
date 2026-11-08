package io.github.boxshelf;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Boxshelf on Android (AYN Thor). The shared UI runs in Capacitor's WebView; this activity only makes it feel like a
 * console front end: full screen with the system bars hidden, screen kept on, and controller buttons left to the
 * page's Gamepad API instead of Android turning B into "Back" and closing the app.
 */
public class MainActivity extends BridgeActivity {
    private long lastPadButton = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BoxshelfNativePlugin.class); // folders, emulator detection, launching (must come before super.onCreate)
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        hideSystemBars();
        pinRefreshRate();

        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null) {
            wv.getSettings().setMediaPlaybackRequiresUserGesture(false); // menu sounds play without a touch first
            wv.getSettings().setUseWideViewPort(true);      // the page's <meta viewport width=1440> sets the layout size…
            wv.getSettings().setLoadWithOverviewMode(true); // …and it's scaled to fill the screen, like the TV layout
            wv.getSettings().setSupportZoom(false);
            wv.setBackgroundColor(0xFF0B0B14);
        }

        // System back (gesture / nav bar) becomes Esc on the page, so it steps back through Boxshelf's screens instead of
        // closing the app. Skipped right after a controller button, which the page already read through the Gamepad API.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (SystemClock.uptimeMillis() - lastPadButton < 200) return;
                sendKey("Escape", 27);
            }
        });
    }

    /**
     * Boxshelf runs at 60 Hz, like the Windows build on a TV. The Thor's main screen runs at 120 Hz, which asked the phone
     * GPU to draw the 3D shelf and the museum twice as often as a PC does, and any frame that missed the 8 ms budget showed
     * as a stutter. Only this window asks for it: games and emulators launched from Boxshelf keep the screen's full rate.
     */
    private void pinRefreshRate() {
        try {
            Display d = getWindowManager().getDefaultDisplay();
            Display.Mode cur = d.getMode(), best = null;
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() != cur.getPhysicalWidth() || m.getPhysicalHeight() != cur.getPhysicalHeight()) continue;
                float hz = m.getRefreshRate();
                if (hz > 58f && hz < 62f) { best = m; break; }
            }
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            if (best != null) lp.preferredDisplayModeId = best.getModeId();
            lp.preferredRefreshRate = 60f;
            getWindow().setAttributes(lp);
        } catch (Throwable ignored) {
            // a screen without a 60 Hz mode simply keeps its own rate
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars(); // bars come back after a swipe or returning from another app
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int src = e.getSource();
        boolean pad = (src & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (src & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
        if (pad && (KeyEvent.isGamepadButton(e.getKeyCode()) || e.getKeyCode() == KeyEvent.KEYCODE_BACK)) {
            lastPadButton = SystemClock.uptimeMillis();
            super.dispatchKeyEvent(e); // the WebView still sees it, which feeds navigator.getGamepads()
            return true;               // but Android doesn't turn an unused B into Back and close the app
        }
        return super.dispatchKeyEvent(e);
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void sendKey(String key, int code) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String ev = "{key:'" + key + "',code:'" + key + "',keyCode:" + code + ",which:" + code + ",bubbles:true,cancelable:true}";
        String js = "(function(){var t=document.activeElement||document.body;"
                + "t.dispatchEvent(new KeyboardEvent('keydown'," + ev + "));"
                + "t.dispatchEvent(new KeyboardEvent('keyup'," + ev + "));})();";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}

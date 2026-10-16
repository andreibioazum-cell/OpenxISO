package com.cb4;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * The emulator in a WebView.
 *
 * The x86-64 emulator is the web application in assets/emulator (see
 * emulator/README.md in the repository); this activity only gives it a window,
 * the file picker and the storage it needs:
 *
 *   - the pages are served over http://127.0.0.1 by {@link EmulatorServer}, so
 *     WebAssembly, service workers and IndexedDB behave like in a browser,
 *   - "attach ISO / disk image" opens the system file picker
 *     (onShowFileChooser below), which can reach Downloads, an SD card or a USB
 *     stick through the storage access framework,
 *   - the app keeps the screen on while a guest is running.
 *
 * Nothing of the emulator itself is implemented here: everything the user sees
 * is the same HTML application that runs in a desktop browser.
 */
public final class EmulatorActivity extends Activity {

    /** Directory inside the APK that holds the emulator (index.html at its top). */
    private static final String APP_DIRECTORY = "emulator";
    private static final String START_PAGE = "index.html";

    private static final int REQUEST_FILE_CHOOSER = 7001;

    private EmulatorServer server;
    private WebView web_view;
    private ValueCallback<Uri[]> file_callback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        try {
            server = new EmulatorServer(this, APP_DIRECTORY);
            server.start();
        } catch (Exception error) {
            show_message("Не удалось запустить встроенный сервер эмулятора: " + error.getMessage());
            return;
        }

        FrameLayout root = new FrameLayout(this);
        web_view = new WebView(this);
        root.addView(web_view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = web_view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setTextZoom(100);

        web_view.setWebViewClient(new LocalClient());
        web_view.setWebChromeClient(new ChromeClient());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web_view.loadUrl(server.base_url() + START_PAGE);
    }

    /** Everything inside the local server stays in the WebView, the rest opens outside. */
    private final class LocalClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (server != null && url.toString().startsWith(server.base_url())) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (Exception ignored) {
                // nothing installed that can open this link
            }
            return true;
        }
    }

    /** The part that makes <input type="file"> work: without it a WebView ignores file pickers. */
    private final class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (file_callback != null) {
                file_callback.onReceiveValue(null);
            }
            file_callback = callback;

            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            // the emulator asks for .iso, .hdd, .img and .flp images
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "application/x-iso9660-image", "application/octet-stream", "*/*" });
            try {
                startActivityForResult(Intent.createChooser(intent, "Образ ISO или диска"),
                    REQUEST_FILE_CHOOSER);
                return true;
            } catch (Exception error) {
                file_callback = null;
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == REQUEST_FILE_CHOOSER) {
            Uri[] uris = null;
            if (result == RESULT_OK && data != null) {
                Uri single = data.getData();
                if (single != null) {
                    uris = new Uri[] { single };
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    uris = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            if (file_callback != null) {
                file_callback.onReceiveValue(uris);
                file_callback = null;
            }
            return;
        }
        super.onActivityResult(request, result, data);
    }

    private void show_message(String message) {
        TextView view = new TextView(this);
        view.setText(message);
        view.setPadding(48, 48, 48, 48);
        setContentView(view);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web_view != null) {
            // the guest keeps running while the app is in the background;
            // timers are slowed down by the system, which is fine for a VM
            web_view.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web_view != null) {
            web_view.onResume();
        }
    }

    @Override
    public void onBackPressed() {
        if (web_view != null && web_view.canGoBack()) {
            web_view.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
        if (web_view != null) {
            web_view.destroy();
            web_view = null;
        }
        super.onDestroy();
    }

    /** The volume keys stay with the system, everything else goes to the guest. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.onKeyDown(keyCode, event);
        }
        return super.onKeyDown(keyCode, event);
    }

    /** Show the emulator window without the system bars, like a full screen app. */
    @SuppressWarnings("unused")
    private void hide_system_bars(View decor) {
        decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
}

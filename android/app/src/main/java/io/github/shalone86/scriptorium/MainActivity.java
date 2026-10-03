package io.github.shalone86.scriptorium;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Shows the Scriptorium web app full-screen. Everything the app does lives on the website, so
 * updates show up here without reinstalling. This wrapper adds what a plain WebView lacks:
 * microphone (voice notes), file picking (images, imports), saving downloads, the share sheet,
 * and "Share to Scriptorium" from other apps (save an article from Google News or Chrome).
 */
public class MainActivity extends Activity {
    static final String HOST = "shalone86.github.io";
    static final String PATH = "/quickstart";
    static final String HOME = "https://" + HOST + PATH + "/";
    static final int REQ_FILES = 1, REQ_MIC = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(intent, REQ_FILES);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() { @Override public void run() {
                    boolean wantsMic = false;
                    for (String r : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                    if (!wantsMic) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                } });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith(PATH)) return false;
                // Links in notes, GitHub token page, share links… open in the normal browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(this), "AndroidApp");
        setContentView(web);
        String shared = sharedUrl(getIntent());
        if (shared != null) web.loadUrl(shared);
        else if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(HOME);
    }

    /** Text or a link shared from another app becomes ?share=1&… which the web app saves as a note. */
    private String sharedUrl(Intent intent) {
        if (intent == null) return null;
        // A note link from Daily (or anywhere): https://shalone86.github.io/quickstart/#/note/…
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri u = intent.getData();
            if (HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith(PATH)) return u.toString();
            return null;
        }
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null) return null;
        return HOME + "?share=1&text=" + Uri.encode(text) + (title != null ? "&title=" + Uri.encode(title) : "");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String shared = sharedUrl(intent);
        if (shared != null) web.loadUrl(shared);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILES && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_MIC && pendingPermission != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingPermission.deny();
            pendingPermission = null;
        }
    }

    /** Methods the web page can call as window.AndroidApp.* (static so it has no hidden outer reference). */
    static class Bridge {
        private final MainActivity a;
        Bridge(MainActivity activity) { a = activity; }

        /** Android's share sheet for a note's text. */
        @JavascriptInterface
        public void shareText(final String title, final String text) {
            a.runOnUiThread(new Runnable() { @Override public void run() {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_SUBJECT, title);
                send.putExtra(Intent.EXTRA_TEXT, text);
                a.startActivity(Intent.createChooser(send, title));
            } });
        }

        /** Saves a download (note export, backup zip, writing-replay video) into Downloads/Scriptorium. */
        @JavascriptInterface
        public boolean saveFile(final String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Scriptorium");
                    Uri uri = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    OutputStream out = a.getContentResolver().openOutputStream(uri);
                    try { out.write(bytes); } finally { out.close(); }
                } else {
                    File dir = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Scriptorium");
                    dir.mkdirs();
                    FileOutputStream out = new FileOutputStream(new File(dir, name));
                    try { out.write(bytes); } finally { out.close(); }
                }
                a.toast("Saved to Downloads/Scriptorium/" + name);
                return true;
            } catch (Exception e) {
                a.toast("Couldn't save: " + e.getMessage());
                return false;
            }
        }
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() { @Override public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show(); } });
    }

    @Override
    public void onBackPressed() {
        // The page closes an open sheet or goes back a screen first; only then does Back leave the app.
        web.evaluateJavascript("window.handleBack ? String(handleBack()) : 'false'", new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) { if (!"\"true\"".equals(value)) finish(); }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        web.onPause(); // lets the page save and sync before the app goes to the background
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}

package com.selamatku.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "SelamatKu";
    private static final int PERMISSION_REQUEST_CODE = 100;
    private static final int FILE_CHOOSER_CODE = 101;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorText;
    private AssetServer assetServer;
    private ValueCallback<Uri[]> filePathCallback;
    private int serverPort = -1;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress_bar);
        errorText = findViewById(R.id.error_text);

        setupWebView();

        // Request permissions FIRST, then start server & load page
        // This ensures geolocation works when the web app requests it
        requestPermissionsAndStart();
    }

    /** Try to start the asset server, return port or -1 on failure */
    private int startServer() {
        int[] ports = {8765, 8766, 8767, 9876, 9877};
        for (int port : ports) {
            try {
                Log.d(TAG, "Trying port " + port + "...");
                assetServer = new AssetServer(this, port);
                assetServer.start(NanoHTTPD.SOCKET_READ_TIMEOUT);
                Log.d(TAG, "Server started on port " + port);
                return port;
            } catch (Exception e) {
                Log.w(TAG, "Port " + port + " failed: " + e.getMessage());
                try { if (assetServer != null) assetServer.stop(); } catch (Exception ignored) {}
            }
        }
        Log.e(TAG, "All ports failed!");
        return -1;
    }

    private void showServerError() {
        errorText.setVisibility(View.VISIBLE);
        errorText.setText("Gagal memuat aplikasi.\n\n" +
                "Server internal tidak bisa dimulai.\n" +
                "Coba tutup dan buka lagi aplikasi.");
        webView.setVisibility(View.GONE);
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Show error text initially (hidden once server starts)
        errorText.setVisibility(View.VISIBLE);
        errorText.setText("Memuat...");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                String host = uri.getHost();

                // Let localhost load in WebView
                if ("localhost".equals(host) || "127.0.0.1".equals(host)) {
                    return false;
                }

                // Handle special schemes
                if (scheme != null) {
                    switch (scheme) {
                        case "tel":
                        case "sms":
                        case "mailto":
                            try {
                                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                            } catch (Exception e) {
                                Toast.makeText(MainActivity.this, "Tidak bisa membuka: " + uri, Toast.LENGTH_SHORT).show();
                            }
                            return true;

                        case "https":
                        case "http":
                            try {
                                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                            } catch (Exception e) {
                                view.loadUrl(uri.toString());
                            }
                            return true;

                        default:
                            try {
                                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                                return true;
                            } catch (Exception e) {
                                return false;
                            }
                    }
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                Log.d(TAG, "Geolocation requested: " + origin);
                callback.invoke(origin, true, false);
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                final JsResult fr = result;
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int w) { fr.confirm(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface d) { fr.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                final JsResult fr = result;
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int w) { fr.confirm(); }
                        })
                        .setNegativeButton("Batal", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int w) { fr.cancel(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface d) { fr.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_CODE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * Request permissions first, then start the server and load the page.
     * This ensures geolocation permissions are already granted when
     * the web app calls navigator.geolocation.getCurrentPosition().
     */
    private void requestPermissionsAndStart() {
        List<String> perms = new ArrayList<>();
        boolean locationGranted = ContextCompat.checkSelfPermission(this,
                Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;

        if (!locationGranted) {
            perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (perms.isEmpty()) {
            // All permissions already granted — start immediately
            startServerAndLoad();
        } else {
            // Show "waiting" state while permission dialog is shown
            errorText.setVisibility(View.VISIBLE);
            errorText.setText("Menunggu izin lokasi...");
            ActivityCompat.requestPermissions(this,
                    perms.toArray(new String[0]), PERMISSION_REQUEST_CODE);
            // Start server regardless — user can still use the app
            // without location if they deny
            startServerAndLoad();
        }
    }

    private volatile boolean serverStarted = false;

    private synchronized void startServerAndLoad() {
        if (serverStarted) return;
        serverStarted = true;

        new Thread(() -> {
            int port = startServer();
            if (port > 0) {
                runOnUiThread(() -> {
                    serverPort = port;
                    errorText.setVisibility(View.GONE);
                    webView.loadUrl("http://localhost:" + port + "/");
                });
            } else {
                runOnUiThread(() -> showServerError());
            }
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE) {
            boolean locationGranted = false;
            for (int i = 0; i < permissions.length; i++) {
                if (permissions[i].equals(Manifest.permission.ACCESS_FINE_LOCATION)
                        && grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                    locationGranted = true;
                }
            }
            Log.d(TAG, "Location permission granted: " + locationGranted);

            if (!locationGranted && serverPort > 0) {
                // Reload page so geolocation retry works with updated permission state
                runOnUiThread(() -> {
                    Toast.makeText(this, "Izin lokasi tidak diberikan. Fitur peta terbatas.",
                            Toast.LENGTH_LONG).show();
                });
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_CODE && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getDataString() != null) {
                results = new Uri[]{Uri.parse(data.getDataString())};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    protected void onDestroy() {
        if (assetServer != null) {
            try { assetServer.stop(); } catch (Exception ignored) {}
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}

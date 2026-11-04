package com.selamatku.app;

import android.content.Context;
import android.util.Log;

import fi.iki.elonen.NanoHTTPD;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Local HTTP server that serves web app files from Android assets.
 */
public class AssetServer extends NanoHTTPD {

    private static final String TAG = "AssetServer";
    private final Context context;

    public AssetServer(Context context, int port) {
        super(port);
        this.context = context;
    }

    /** Subclass to access protected Response constructor */
    private static class AssetResponse extends Response {
        AssetResponse(Response.Status status, String mimeType, InputStream data, long totalBytes) {
            super(status, mimeType, data, totalBytes);
        }
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();

        if (uri == null || uri.equals("/") || uri.isEmpty()) {
            uri = "/index.html";
        }
        String assetPath = uri.startsWith("/") ? uri.substring(1) : uri;
        String mimeType = getMimeType(assetPath);

        try {
            InputStream inputStream = context.getAssets().open(assetPath);
            byte[] content = readBytes(inputStream);
            inputStream.close();

            AssetResponse response = new AssetResponse(
                    Response.Status.OK, mimeType, new ByteArrayInputStream(content), content.length);
            response.addHeader("Cache-Control",
                    isStaticAsset(assetPath) ? "public, max-age=86400" : "no-cache");
            response.addHeader("Access-Control-Allow-Origin", "*");

            return response;

        } catch (IOException e) {
            Log.w(TAG, "Asset not found: " + assetPath);

            // Fallback to index.html for extension-less paths (SPA routing)
            if (!assetPath.contains(".")) {
                try {
                    InputStream is = context.getAssets().open("index.html");
                    byte[] content = readBytes(is);
                    is.close();
                    return new AssetResponse(
                            Response.Status.OK, "text/html; charset=utf-8",
                            new ByteArrayInputStream(content), content.length);
                } catch (IOException ignored) {}
            }

            byte[] msg = ("Not Found: " + assetPath).getBytes();
            return new AssetResponse(
                    Response.Status.NOT_FOUND, "text/plain",
                    new ByteArrayInputStream(msg), msg.length);
        }
    }

    private boolean isStaticAsset(String path) {
        return path.endsWith(".js") || path.endsWith(".css")
                || path.endsWith(".png") || path.endsWith(".json")
                || path.endsWith(".svg") || path.endsWith(".woff2");
    }

    private String getMimeType(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".css"))  return "text/css; charset=utf-8";
        if (path.endsWith(".js"))   return "application/javascript; charset=utf-8";
        if (path.endsWith(".json")) return "application/json; charset=utf-8";
        if (path.endsWith(".png"))  return "image/png";
        if (path.endsWith(".svg"))  return "image/svg+xml";
        if (path.endsWith(".ico"))  return "image/x-icon";
        if (path.endsWith(".woff")) return "font/woff";
        if (path.endsWith(".woff2"))return "font/woff2";
        return "application/octet-stream";
    }

    private byte[] readBytes(InputStream is) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int len;
        while ((len = is.read(buffer)) != -1) {
            bos.write(buffer, 0, len);
        }
        return bos.toByteArray();
    }
}

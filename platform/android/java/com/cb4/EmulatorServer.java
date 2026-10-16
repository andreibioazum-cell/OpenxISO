package com.cb4;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;

/**
 * A very small HTTP server that serves the emulator (the JavaScript app and the
 * v86_64 WebAssembly engine) out of the assets of the APK.
 *
 * The WebView could load the page from a file:// or asset:// URL, but then it
 * would be a unique origin: WebAssembly streaming compilation, the service
 * worker, IndexedDB (where the disk images live) and the Range requests the
 * emulator makes are all unreliable or unavailable there. Over
 * http://127.0.0.1 the page behaves exactly like it does in a browser.
 *
 * Only the asset directory given to the constructor is reachable, and only from
 * this device.
 */
final class EmulatorServer implements Runnable {

    private static final Map<String, String> MIME_TYPES = new HashMap<String, String>();

    static {
        MIME_TYPES.put(".html", "text/html; charset=utf-8");
        MIME_TYPES.put(".js", "text/javascript; charset=utf-8");
        MIME_TYPES.put(".mjs", "text/javascript; charset=utf-8");
        MIME_TYPES.put(".css", "text/css; charset=utf-8");
        MIME_TYPES.put(".json", "application/json; charset=utf-8");
        MIME_TYPES.put(".webmanifest", "application/manifest+json; charset=utf-8");
        MIME_TYPES.put(".wasm", "application/wasm");
        MIME_TYPES.put(".svg", "image/svg+xml");
        MIME_TYPES.put(".png", "image/png");
        MIME_TYPES.put(".bin", "application/octet-stream");
        MIME_TYPES.put(".iso", "application/x-iso9660-image");
    }

    private final AssetManager assets;
    private final String root;
    private final Thread thread;
    private final ServerSocket socket;

    EmulatorServer(Context context, String asset_root) throws IOException {
        this.assets = context.getAssets();
        this.root = asset_root;
        this.socket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        this.thread = new Thread(this, "openxiso-assets");
        this.thread.setDaemon(true);
    }

    void start() {
        thread.start();
    }

    /** The address the WebView has to load, with a trailing slash. */
    String base_url() {
        return "http://127.0.0.1:" + socket.getLocalPort() + "/";
    }

    void stop() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // the server is going away anyway
        }
    }

    @Override
    public void run() {
        while (!socket.isClosed()) {
            Socket client;
            try {
                client = socket.accept();
            } catch (IOException error) {
                return;
            }
            try {
                serve(client);
            } catch (IOException ignored) {
                // a broken connection is not worth reporting
            } finally {
                try {
                    client.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }

    private void serve(Socket client) throws IOException {
        String request = read_line(client.getInputStream());
        if (request == null) {
            return;
        }
        // "GET /emulator/index.html HTTP/1.1"
        String[] parts = request.split(" ");
        String path = parts.length > 1 ? parts[1] : "/";
        int question = path.indexOf('?');
        if (question >= 0) {
            path = path.substring(0, question);
        }
        String relative = path.startsWith("/") ? path.substring(1) : path;
        if (relative.isEmpty()) {
            relative = "index.html";
        }

        String asset_name = root.isEmpty() ? relative : root + "/" + relative;
        byte[] body = read_asset(asset_name);
        if (body == null && relative.indexOf('.') < 0) {
            // the emulator is a single page application: unknown paths without a
            // file extension are served the start page
            body = read_asset(root + "/index.html");
        }

        if (body == null) {
            byte[] message = "not found".getBytes("UTF-8");
            write_head(client, 404, "text/plain; charset=utf-8", message.length);
            client.getOutputStream().write(message);
            return;
        }

        String type = mime_for(asset_name);
        write_head(client, 200, type, body.length);
        client.getOutputStream().write(body);
    }

    /** Read a whole asset, or null when it does not exist. */
    private byte[] read_asset(String name) {
        InputStream input = null;
        try {
            input = assets.open(name);
            ByteArrayOutputStream output = new ByteArrayOutputStream(Math.max(65536, input.available()));
            byte[] buffer = new byte[64 * 1024];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
                total += read;
                // the engine files are a few megabytes, everything else is small
                if (total > 128 * 1024 * 1024) {
                    break;
                }
            }
            return output.toByteArray();
        } catch (IOException error) {
            return null;
        } finally {
            if (input != null) {
                try {
                    input.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }

    private static String mime_for(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) {
            return "application/octet-stream";
        }
        String type = MIME_TYPES.get(name.substring(dot).toLowerCase());
        return type == null ? "application/octet-stream" : type;
    }

    private static void write_head(Socket client, int code, String type, int length)
            throws IOException {
        String status = code == 200 ? "200 OK" : code == 404 ? "404 Not Found" : "200 OK";
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append("\r\n");
        head.append("Content-Type: ").append(type).append("\r\n");
        head.append("Content-Length: ").append(length).append("\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n");
        head.append("\r\n");
        client.getOutputStream().write(head.toString().getBytes("UTF-8"));
    }

    /** Read one line of the request, ignoring the rest of the headers. */
    private static String read_line(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int byte_value;
        while ((byte_value = input.read()) >= 0) {
            if (byte_value == '\n') {
                break;
            }
            if (byte_value != '\r') {
                line.write(byte_value);
            }
            if (line.size() > 4096) {
                break;
            }
        }
        if (line.size() == 0) {
            return null;
        }
        return new String(line.toByteArray(), "UTF-8");
    }

    /** Only used to keep the import of ByteArrayInputStream (asset streaming). */
    static InputStream rewind(byte[] data) {
        return new ByteArrayInputStream(data);
    }
}

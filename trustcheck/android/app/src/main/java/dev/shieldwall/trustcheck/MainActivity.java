package dev.shieldwall.trustcheck;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
    private EditText server, shop, feedbackDetails;
    private LinearLayout body;
    private TextView status;
    private String currentDomain;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this);
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(32, 28, 32, 32);
        scroll.addView(body); setContentView(scroll);
        title("BeforeYouBuy");
        text("Share a shop link from Chrome or paste it below. Checks cover the domain and server data; this app does not scan the shop page.");
        server = input("Server URL", getPreferences(0).getString("server", "http://127.0.0.1:8787"));
        shop = input("Shop URL", "");
        button("Check seller", v -> check());
        status = text("");
        readShared(getIntent());
        if (!shop.getText().toString().isEmpty()) check();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); readShared(intent); check();
    }

    private void readShared(Intent intent) {
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null) {
                java.util.regex.Matcher match = java.util.regex.Pattern.compile("https?://[^\\s]+", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(shared);
                if (match.find()) shop.setText(match.group());
            }
        }
    }

    private void check() {
        final String base = server.getText().toString().trim().replaceAll("/+$", "");
        final String link = shop.getText().toString().trim();
        final String origin;
        if (!allowedServer(base)) { status.setText("Use an HTTPS server, or local HTTP for USB beta testing."); return; }
        try {
            Uri uri = Uri.parse(link);
            if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null) throw new Exception();
            origin = uri.getScheme() + "://" + uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort()) + "/";
        } catch (Exception e) { status.setText("Share a complete shop URL, beginning with https://"); return; }
        getPreferences(0).edit().putString("server", base).apply();
        status.setText("Checking seller…");
        worker.execute(() -> {
            try {
                JSONObject result = request("GET", base + "/v1/mobile-check?url=" + URLEncoder.encode(origin, "UTF-8"), null, null);
                runOnUiThread(() -> showResult(base, result));
            } catch (Exception e) { runOnUiThread(() -> status.setText("Check unavailable: " + e.getMessage())); }
        });
    }

    private boolean allowedServer(String value) {
        try {
            Uri uri = Uri.parse(value);
            return "https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) &&
                ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost())));
        } catch (Exception e) { return false; }
    }

    private void showResult(String base, JSONObject report) {
        body.removeViews(6, body.getChildCount() - 6);
        currentDomain = report.optString("domain", "");
        status.setText("");
        title(currentDomain + " — " + report.optString("verdictLabel", "Unverified"));
        text("BeforeYouBuy score: " + report.optInt("score") + "/100 · " + report.optString("confidence", "low") + " confidence");
        text(report.optString("summary"));
        text(report.optString("analysisScope"));
        JSONArray history = report.optJSONArray("history");
        if (history != null) for (int i = 0; i < history.length(); i++) text("• " + history.optString(i));
        JSONArray signals = report.optJSONArray("signals");
        if (signals != null) for (int i = 0; i < signals.length(); i++) {
            JSONObject signal = signals.optJSONObject(i);
            if (signal != null && !"info".equals(signal.optString("status"))) text("• " + signal.optString("label"));
        }
        JSONObject votes = report.optJSONObject("buyerOutcomes");
        if (votes != null) text("Buyer feedback, last 30 days: " + votes.optInt("ok") + " good, " + votes.optInt("problem") + " problems, " + votes.optInt("never") + " never arrived. Self-reported unless marked otherwise.");
        button("Read reviews on Trustpilot", v -> open("https://www.trustpilot.com/review/" + currentDomain));
        title("How did this seller do?");
        text("One tap sends an anonymous experience report. You can update your choice later.");
        feedbackDetails = input("Add details (optional, 300 characters)", "");
        feedbackDetails.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(300) });
        text("Omit personal and payment details. Written feedback is reviewed before public use.");
        button("Good experience", v -> feedback(base, "ok"));
        button("Problem", v -> feedback(base, "problem"));
        button("Never arrived", v -> feedback(base, "never"));
    }

    private void feedback(String base, String outcome) {
        final String domain = currentDomain;
        final String details = feedbackDetails == null ? "" : feedbackDetails.getText().toString().trim();
        status.setText("Sending feedback…");
        worker.execute(() -> {
            try {
                String install = getPreferences(0).getString("install", "");
                String token = getPreferences(0).getString("token", "");
                String credentialServer = getPreferences(0).getString("credentialServer", "");
                if (install.isEmpty() || token.isEmpty() || !base.equals(credentialServer)) {
                    JSONObject credential = request("POST", base + "/v1/register", new JSONObject(), null);
                    install = credential.getString("installId"); token = credential.getString("token");
                    getPreferences(0).edit().putString("install", install).putString("token", token).putString("credentialServer", base).apply();
                }
                JSONObject payload = new JSONObject().put("installId", install).put("domain", domain)
                    .put("outcome", outcome).put("tags", new JSONArray()).put("details", details);
                request("POST", base + "/v1/report", payload, token);
                runOnUiThread(() -> status.setText("Thanks — your feedback was sent."));
            } catch (Exception e) { runOnUiThread(() -> status.setText("Could not send: " + e.getMessage())); }
        });
    }

    private JSONObject request(String method, String endpoint, JSONObject payload, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
        conn.setConnectTimeout(7000); conn.setReadTimeout(15000); conn.setRequestMethod(method);
        if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
        if (payload != null) {
            conn.setDoOutput(true); conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = conn.getOutputStream()) { out.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
        }
        int code = conn.getResponseCode();
        InputStream stream = code < 400 ? conn.getInputStream() : conn.getErrorStream();
        String json;
        try (InputStream in = stream; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int n;
            while ((n = in.read(buffer)) != -1) bytes.write(buffer, 0, n);
            json = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        }
        conn.disconnect();
        if (code >= 400) throw new Exception(new JSONObject(json).optString("error", "HTTP " + code));
        return new JSONObject(json);
    }

    private void open(String url) { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
    private TextView text(String value) { TextView t = new TextView(this); t.setText(value); t.setTextSize(15); t.setPadding(0, 8, 0, 8); body.addView(t); return t; }
    private void title(String value) { TextView t = text(value); t.setTextSize(22); t.setTextColor(Color.rgb(20, 28, 40)); }
    private EditText input(String hint, String value) { EditText e = new EditText(this); e.setSingleLine(true); e.setHint(hint); e.setText(value); body.addView(e); return e; }
    private void button(String label, View.OnClickListener action) { Button b = new Button(this); b.setText(label); b.setOnClickListener(action); body.addView(b); }
}

# BeforeYouBuy Android share-to-check beta

This is a native Android app, separate from the desktop extension. Share a shop URL from Chrome (Share → BeforeYouBuy Beta), or paste a URL. It calls `/v1/mobile-check` on the BeforeYouBuy server for domain history, security and community signals. It does **not** inspect Chrome tabs, page content, checkout forms, or purchases. Mobile feedback is self-reported.
The app sends only the shared shop's origin to the server, omitting paths and query strings that may contain private checkout data.

Build with Android Studio (JDK 17, Android SDK 35): open this `android/` directory, sync Gradle, then run `app` on an Android 8+ device. There is no Gradle wrapper checked in; Android Studio can use its configured Gradle installation. The app has not yet been compiled in this workspace because the Android SDK and Gradle are unavailable here.

For a USB-connected local beta, run the BeforeYouBuy backend (`node server/server.js` in `trustcheck/`), then `adb reverse tcp:8787 tcp:8787`. Keep the app's server URL at `http://127.0.0.1:8787`. For a public beta use an HTTPS server URL. The app accepts cleartext HTTP only for loopback testing.

Check the result against the desktop extension on the same seller. The mobile result intentionally has fewer signals because it cannot read the shop page. Feedback is one tap and is hidden from public aggregate results until the server's minimum-report threshold is met.

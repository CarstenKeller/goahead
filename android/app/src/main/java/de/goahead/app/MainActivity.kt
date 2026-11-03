package de.goahead.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import java.io.File

/**
 * GoAhead als App: zeigt die Web-App (GitHub Pages) bildschirmfüllend in einer WebView.
 *
 * Die Web-App erkennt die App an window.GoAheadNative (siehe Bridge unten) und überlässt dann
 * die Aufzeichnung dem TrackingService – der läuft auch bei ausgeschaltetem Bildschirm weiter.
 * Kommt die App wieder in den Vordergrund, holt die Web-App die Punkte ab.
 *
 * Daten (IndexedDB, Einstellungen) liegen im Speicher dieser WebView – getrennt von Chrome.
 * Umziehen: in Chrome „Sicherung“, hier „Wiederherstellen“ (Einstellungen der Web-App).
 */
class MainActivity : Activity() {

    companion object {
        const val START_URL = "https://carstenkeller.github.io/goahead/"
        private const val REQ_PERMS = 1
        private const val REQ_FILES = 2
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var geoPending: Pair<String, GeolocationPermissions.Callback>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString GoAheadApp/${appVersion()}"
        }
        web.addJavascriptInterface(Bridge(), "GoAheadNative")

        web.webViewClient = object : WebViewClient() {
            // Eigene Seiten in der App, alles andere (z. B. Links in der Quellenangabe) im Browser
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == Uri.parse(START_URL).host && (u.path ?: "").startsWith("/goahead")) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: ActivityNotFoundException) { }
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, true)
                } else {
                    geoPending = origin to callback
                    askPermissions()
                }
            }

            // Dateiauswahl für <input type="file">: alle Dateitypen, da Android .gpx/.zip-Typen oft nicht kennt
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                                           params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Dateien wählen"), REQ_FILES)
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(START_URL)
        askPermissions()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // Web-App: Punkte abholen, die bei ausgeschaltetem Bildschirm aufgezeichnet wurden
        web.evaluateJavascript("window.GOAHEAD_NATIVE_RESUME && window.GOAHEAD_NATIVE_RESUME()", null)
    }

    override fun onPause() {
        web.onPause()   // WebView ruht (auch ihr GPS) – die Aufzeichnung übernimmt der TrackingService
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // App nicht beenden, nur in den Hintergrund – die Oberfläche bleibt erhalten
        moveTaskToBack(true)
    }

    private fun hasLocation() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun askPermissions() {
        val want = mutableListOf<String>()
        if (!hasLocation()) {
            want += Manifest.permission.ACCESS_FINE_LOCATION
            want += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            want += Manifest.permission.POST_NOTIFICATIONS
        }
        if (want.isNotEmpty()) requestPermissions(want.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        geoPending?.let { (origin, cb) -> cb.invoke(origin, hasLocation(), hasLocation()) }
        geoPending = null
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILES) return
        val cb = fileCallback ?: return
        fileCallback = null
        if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
        else data.data?.let { uris += it }
        cb.onReceiveValue(uris.toTypedArray())
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (e: Exception) { "?" }

    private fun service(action: String) {
        val i = Intent(this, TrackingService::class.java).setAction(action)
        if (action == TrackingService.ACTION_STOP) {
            // läuft der Dienst nicht, genügt es, den Zustand zu löschen
            if (TrackingService.state(this) == "off") return
            startService(i)
        } else {
            startForegroundService(i)
        }
    }

    /**
     * Schnittstelle für die Web-App: window.GoAheadNative.
     * Methoden laufen in einem eigenen Thread der WebView; Oberflächen-Aufrufe daher über runOnUiThread.
     */
    inner class Bridge {
        private val ctx: Context get() = this@MainActivity

        @JavascriptInterface fun appVersion(): String = this@MainActivity.appVersion()

        /** "off" | "rec" | "pause" */
        @JavascriptInterface fun recordingState(): String = TrackingService.state(ctx)

        /** Neue Aufzeichnung (fresh = true löscht alte Punkte) bzw. nach einer Pause weiter. */
        @JavascriptInterface fun startRecording(fresh: Boolean) {
            if (fresh) TrackStore.clear(ctx)
            runOnUiThread { service(TrackingService.ACTION_START) }
        }

        @JavascriptInterface fun pauseRecording() {
            runOnUiThread { service(TrackingService.ACTION_PAUSE) }
        }

        /** Aufzeichnung beenden und Punkte löschen (erst aufrufen, wenn die Web-App sie gespeichert hat). */
        @JavascriptInterface fun stopRecording() {
            runOnUiThread {
                service(TrackingService.ACTION_STOP)
                TrackStore.clear(ctx)
            }
        }

        @JavascriptInterface fun pointCount(): Int = TrackStore.count(ctx)

        /** Punkte ab Index [from]: JSON [[lat, lon, höhe|null, zeit ms, genauigkeit m], …] */
        @JavascriptInterface fun getPoints(from: Int): String = TrackStore.since(ctx, from)

        /** Abbiegungen für die Vibration bei ausgeschaltetem Bildschirm: JSON [[lat, lon, "l"|"r"], …] */
        @JavascriptInterface fun setTurns(json: String, warnM: Int) = TrackingService.setTurns(json, warnM)

        /** true, wenn Android die App beim Akku noch „optimiert“ (dann droht ein Abbruch im Hintergrund). */
        @JavascriptInterface fun batteryOptimized(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return !pm.isIgnoringBatteryOptimizations(packageName)
        }

        /** Systemdialog „Akku-Optimierung für GoAhead ausschalten?“ */
        @SuppressLint("BatteryLife")
        @JavascriptInterface fun requestBatteryExemption() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")))
                } catch (e: ActivityNotFoundException) {
                    openAppSettings()
                }
            }
        }

        /** App-Infos in den Systemeinstellungen (Samsung: dort „Akku“ → „Nicht eingeschränkt“). */
        @JavascriptInterface fun openAppSettings() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName")))
                } catch (e: ActivityNotFoundException) { }
            }
        }

        /** Datei in „Downloads“ speichern. Rückgabe: true bei Erfolg. */
        @JavascriptInterface fun saveFile(name: String, mime: String, text: String): Boolean {
            return try {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) } ?: return false
                true
            } catch (e: Exception) {
                false
            }
        }

        /** Datei über das Teilen-Menü von Android weitergeben (echte .gpx-Datei, z. B. an WhatsApp). */
        @JavascriptInterface fun shareFile(name: String, mime: String, text: String, subject: String, message: String): Boolean {
            return try {
                val dir = File(cacheDir, "share").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }   // alte Freigaben aufräumen
                val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
                val f = File(dir, safe)
                f.writeText(text, Charsets.UTF_8)
                val uri = FileProvider.getUriForFile(ctx, "$packageName.files", f)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, subject)
                    putExtra(Intent.EXTRA_TEXT, message)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread { startActivity(Intent.createChooser(send, "Teilen")) }
                true
            } catch (e: Exception) {
                false
            }
        }
    }
}

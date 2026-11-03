package de.goahead.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONArray

/**
 * Vordergrunddienst (Typ "location"): zeichnet die GPS-Position auch bei ausgeschaltetem
 * Bildschirm auf. Android verlangt dafür eine dauerhaft sichtbare Benachrichtigung.
 *
 * Gestartet wird er nur aus der sichtbaren App (Knopf „Los geht's“ bzw. „Weiter“) –
 * dann genügt die Standort-Erlaubnis „Während der Nutzung der App“; eine Erlaubnis
 * „Immer“ (Standort im Hintergrund) ist nicht nötig.
 *
 * Zusätzlich vibriert der Dienst vor Abbiegungen (von der Web-App mit setTurns übergeben),
 * damit das auch bei ausgeschaltetem Bildschirm in der Tasche funktioniert.
 */
class TrackingService : Service() {

    companion object {
        const val ACTION_START = "de.goahead.app.START"
        const val ACTION_PAUSE = "de.goahead.app.PAUSE"
        const val ACTION_STOP = "de.goahead.app.STOP"
        private const val CHANNEL = "tracking"
        private const val NOTIFY_ID = 1
        private const val PREFS = "tracking"
        private const val MAX_ACCURACY = 50f   // wie nav.js: ungenauere Positionen nicht aufzeichnen
        private const val MIN_STEP = 5f        // wie nav.js: Mindestabstand zwischen zwei Punkten (m)

        /** "off" | "rec" | "pause" – überlebt einen Neustart der App (SharedPreferences). */
        fun state(ctx: Context): String =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state", "off") ?: "off"

        private fun setState(ctx: Context, s: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("state", s).apply()
        }

        // Abbiegungen: [[lat, lon, "l"|"r"], ...] in Reihenfolge der Route
        @Volatile private var turns: List<Triple<Double, Double, Boolean>> = emptyList()
        @Volatile private var nextTurn = 0
        @Volatile private var warnM = 20f

        fun setTurns(json: String, warn: Int) {
            val out = ArrayList<Triple<Double, Double, Boolean>>()
            try {
                val arr = JSONArray(json)
                for (i in 0 until arr.length()) {
                    val t = arr.getJSONArray(i)
                    out.add(Triple(t.getDouble(0), t.getDouble(1), t.getString(2) == "l"))
                }
            } catch (e: Exception) { /* leer lassen */ }
            turns = out
            nextTurn = 0
            warnM = warn.toFloat().coerceIn(5f, 500f)
        }
    }

    private var locationManager: LocationManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var last: Location? = null
    private var paused = false

    private val listener = object : LocationListener {
        override fun onLocationChanged(loc: Location) = onFix(loc)
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Neustart durch das System nach einem Absturz (intent == null): gespeicherten Zustand fortsetzen
        val action = intent?.action ?: when (state(this)) {
            "rec" -> ACTION_START
            "pause" -> ACTION_PAUSE
            else -> ACTION_STOP
        }
        try {
            return handle(action)
        } catch (e: Exception) {
            // z. B. ForegroundServiceStartNotAllowedException, wenn Android den Start aus dem Hintergrund verbietet.
            // Der Zustand bleibt gespeichert; die Web-App startet die Aufzeichnung beim nächsten Öffnen neu.
            stopSelf()
            return START_NOT_STICKY
        }
    }

    private fun handle(action: String): Int {
        when (action) {
            ACTION_STOP -> {
                stopEverything()
                setState(this, "off")
                return START_NOT_STICKY
            }
            ACTION_PAUSE -> {
                startForegroundNow("Pause")
                paused = true
                setState(this, "pause")
                releaseWakeLock()
                stopUpdates()
            }
            else -> {   // ACTION_START
                startForegroundNow("Aufnahme läuft")
                paused = false
                last = null
                setState(this, "rec")
                acquireWakeLock()
                startUpdates()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopUpdates()
        releaseWakeLock()
        super.onDestroy()
    }

    private fun onFix(loc: Location) {
        if (paused) return
        if (loc.hasAccuracy() && loc.accuracy > MAX_ACCURACY) return
        val prev = last
        if (prev != null && prev.distanceTo(loc) < MIN_STEP) return
        last = loc
        TrackStore.add(this, loc.latitude, loc.longitude, if (loc.hasAltitude()) loc.altitude else null,
            loc.time, if (loc.hasAccuracy()) loc.accuracy else 0f)
        checkTurn(loc)
    }

    // Luftlinie zur nächsten Abbiegung (Näherung; die Web-App rechnet entlang der Route)
    private fun checkTurn(loc: Location) {
        val list = turns
        var i = nextTurn
        val end = minOf(list.size, nextTurn + 3)   // nur die nächsten Abbiegungen prüfen
        while (i < end) {
            val t = list[i]
            val res = FloatArray(1)
            Location.distanceBetween(loc.latitude, loc.longitude, t.first, t.second, res)
            if (res[0] <= warnM) {
                vibrate(t.third)
                nextTurn = i + 1
                return
            }
            i++
        }
    }

    private fun vibrate(left: Boolean) {
        // wie nav.js: links zwei kurze, rechts ein langer Impuls
        val pattern = if (left) longArrayOf(0, 150, 120, 150) else longArrayOf(0, 450)
        val vib: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        vib?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }

    @Suppress("MissingPermission")
    private fun startUpdates() {
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        locationManager = lm
        try {
            lm.removeUpdates(listener)
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, listener, Looper.getMainLooper())
        } catch (e: SecurityException) {
            // Keine Standort-Erlaubnis: Dienst beenden, die Web-App zeigt „warte auf GPS“
            stopEverything()
            setState(this, "off")
        } catch (e: IllegalArgumentException) {
            // Gerät ohne GPS-Anbieter
        }
    }

    private fun stopUpdates() {
        try { locationManager?.removeUpdates(listener) } catch (e: Exception) { }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GoAhead:tracking").apply {
            setReferenceCounted(false)
            acquire(12 * 60 * 60 * 1000L)   // höchstens 12 h, danach gibt Android sie frei
        }
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (e: Exception) { }
        wakeLock = null
    }

    private fun stopEverything() {
        stopUpdates()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundNow(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Aufzeichnung", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n: Notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("GoAhead")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFY_ID, n)
        }
    }
}

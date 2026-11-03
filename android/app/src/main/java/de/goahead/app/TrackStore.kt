package de.goahead.app

import android.content.Context
import org.json.JSONArray
import java.io.File

/**
 * Aufgezeichnete Punkte der laufenden Tour.
 *
 * Jeder Punkt wird sofort als eine Zeile an eine Datei im App-Speicher angehängt
 * (track.jsonl). So gehen keine Punkte verloren, wenn Android die Web-Oberfläche oder
 * die ganze App beendet. Die Web-App holt die Punkte mit getPoints(ab) ab
 * und baut daraus die gewanderte Strecke; beim Beenden der Tour wird die Datei geleert.
 *
 * Punkt: [lat, lon, höhe|null, zeit (ms), genauigkeit (m)]
 */
object TrackStore {
    private const val FILE = "track.jsonl"
    private var points: MutableList<String>? = null

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)

    @Synchronized
    private fun load(ctx: Context): MutableList<String> {
        points?.let { return it }
        val f = file(ctx)
        val list = if (f.exists()) f.readLines().filter { it.isNotBlank() }.toMutableList() else mutableListOf()
        points = list
        return list
    }

    @Synchronized
    fun add(ctx: Context, lat: Double, lon: Double, alt: Double?, time: Long, acc: Float) {
        val arr = JSONArray()
        arr.put(Math.round(lat * 1e6) / 1e6)
        arr.put(Math.round(lon * 1e6) / 1e6)
        if (alt != null) arr.put(Math.round(alt * 10) / 10.0) else arr.put(JSONArray.NULL)
        arr.put(time)
        arr.put(Math.round(acc).toInt())
        val line = arr.toString()
        load(ctx).add(line)
        file(ctx).appendText(line + "\n")
    }

    @Synchronized
    fun count(ctx: Context): Int = load(ctx).size

    /** Punkte ab Index [from] als JSON-Feld (Text). */
    @Synchronized
    fun since(ctx: Context, from: Int): String {
        val list = load(ctx)
        val start = from.coerceIn(0, list.size)
        val sb = StringBuilder("[")
        for (i in start until list.size) {
            if (i > start) sb.append(',')
            sb.append(list[i])
        }
        return sb.append(']').toString()
    }

    @Synchronized
    fun clear(ctx: Context) {
        points = mutableListOf()
        file(ctx).delete()
    }
}

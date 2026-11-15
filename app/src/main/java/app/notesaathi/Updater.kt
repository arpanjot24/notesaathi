package app.notesaathi

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Checks GitHub Releases for a newer build and downloads its APK. */
object Updater {

    /** Returns {available, version, notes, url}. Never throws: a failed check just means "no update". */
    fun check(): JSONObject {
        val out = JSONObject().put("available", false)
        try {
            val c = URL("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest")
                .openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", "NoteSaathi-Android")
            if (c.responseCode != 200) {
                c.disconnect()
                return out
            }
            val json = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            c.disconnect()

            val tag = json.optString("tag_name", "")
            val latest = tag.substringAfterLast('.').toIntOrNull() ?: return out
            var apkUrl = ""
            val assets = json.optJSONArray("assets")
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    if (a.optString("name").endsWith(".apk")) apkUrl = a.optString("browser_download_url")
                }
            }
            if (latest > BuildConfig.VERSION_CODE && apkUrl.startsWith("https://")) {
                out.put("available", true)
                    .put("version", tag.removePrefix("v"))
                    .put("notes", json.optString("body", "").take(600))
                    .put("url", apkUrl)
            }
        } catch (e: Exception) {
            // offline or GitHub unreachable: stay quiet
        }
        return out
    }

    fun download(ctx: Context, url: String, onProgress: (Int) -> Unit): File {
        val dir = File(ctx.cacheDir, "update").apply { mkdirs() }
        val target = File(dir, "NoteSaathi.apk")
        val tmp = File(dir, "NoteSaathi.apk.part")
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 30_000
            c.readTimeout = 60_000
            c.setRequestProperty("User-Agent", "NoteSaathi-Android")
            if (c.responseCode != 200) throw IllegalStateException("Download failed (error ${c.responseCode}).")
            val total = c.contentLength.toLong()
            var done = 0L
            var lastPct = -1
            c.inputStream.use { input ->
                tmp.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                onProgress(pct)
                            }
                        }
                    }
                }
            }
            if (total > 0 && done != total) throw IllegalStateException("Download was cut short. Try again.")
            target.delete()
            if (!tmp.renameTo(target)) throw IllegalStateException("Could not save the update.")
            return target
        } finally {
            c.disconnect()
        }
    }
}

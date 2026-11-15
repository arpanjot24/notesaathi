package app.notesaathi

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * The screen is a WebView showing the bundled pages in assets/. Everything that needs the phone
 * (camera, files, PDF pages, network calls, printing, updates) happens here and is exposed to the
 * page as the `Android` object.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var pages: Pages
    private lateinit var prefs: SharedPreferences
    private val io = Executors.newFixedThreadPool(3)
    @Volatile private var updateUrl: String = ""

    private val cameraLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = prefs.getString(KEY_PENDING_PHOTO, null)
        prefs.edit().remove(KEY_PENDING_PHOTO).apply()
        if (path != null) {
            val f = File(path)
            if (ok && f.length() > 0) {
                importing("Adding photo…") {
                    pages.addImageBytes(f.readBytes())
                    f.delete()
                    null
                }
            } else {
                f.delete()
            }
        }
    }

    private val galleryLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            importing("Adding pictures…") {
                uris.forEach { pages.addImageUri(it) }
                null
            }
        }
    }

    private val pdfLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            importing("Opening PDF…") {
                val total = pages.addPdf(uri, pdfProgress)
                if (total > Pages.MAX_PDF_PAGES) {
                    "This PDF has $total pages. Only the first ${Pages.MAX_PDF_PAGES} were added; split the PDF to do the rest."
                } else null
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("notesaathi", Context.MODE_PRIVATE)
        pages = Pages(this)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.textZoom = 100
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                return loader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: Exception) {
                    // no browser installed
                }
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        setContentView(web)
        web.loadUrl("https://$APP_HOST/assets/index.html")
        if (savedInstanceState == null) handleShared(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.onBack && window.onBack()) ? 1 : 0") { handled ->
                    if (handled != "1") finish()
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShared(intent)
    }

    /** Pictures or PDFs sent here from another app's Share / Open-with menu. */
    private fun handleShared(intent: Intent?) {
        if (intent == null) return
        val uris = ArrayList<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND ->
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
            Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
            else -> return
        }
        if (uris.isEmpty()) return
        val hint = intent.type ?: ""
        emit("shared", JSONObject())
        importing("Adding shared pages…") {
            var note: String? = null
            for (uri in uris) {
                val type = contentResolver.getType(uri) ?: hint
                val isPdf = type == "application/pdf" || uri.toString().lowercase().endsWith(".pdf")
                if (isPdf) {
                    val total = pages.addPdf(uri, pdfProgress)
                    if (total > Pages.MAX_PDF_PAGES) {
                        note = "This PDF has $total pages. Only the first ${Pages.MAX_PDF_PAGES} were added; split the PDF to do the rest."
                    }
                } else {
                    pages.addImageUri(uri)
                }
            }
            note
        }
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    private fun emit(event: String, data: JSONObject) {
        val js = "window.onNative && window.onNative(${JSONObject.quote(event)}, $data)"
        runOnUiThread { web.evaluateJavascript(js, null) }
    }

    private val pdfProgress: (Int, Int) -> Unit = { done, total ->
        emit("busy", JSONObject().put("on", true).put("text", "Opening PDF… page $done of $total"))
    }

    private fun emitError(message: String) = emit("error", JSONObject().put("message", message))

    /** Runs an import in the background; the block may return a note to show the user. */
    private fun importing(label: String, block: () -> String?) {
        emit("busy", JSONObject().put("on", true).put("text", label))
        io.execute {
            var note: String? = null
            try {
                note = block()
            } catch (e: OutOfMemoryError) {
                note = "That file is too large for this phone's memory."
            } catch (e: Exception) {
                note = e.message ?: "Could not add that file."
            }
            emit("busy", JSONObject().put("on", false))
            val data = JSONObject().put("count", pages.count())
            if (note != null) data.put("message", note)
            emit("pages", data)
        }
    }

    private fun settings(): JSONObject = try {
        JSONObject(prefs.getString(KEY_SETTINGS, "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    inner class Bridge {

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun getSettings(): String = settings()
            .put("defaultGeminiModel", Ai.DEFAULT_GEMINI_MODEL)
            .put("defaultClaudeModel", Ai.DEFAULT_CLAUDE_MODEL)
            .put("defaultDeepseekModel", Ai.DEFAULT_DEEPSEEK_MODEL)
            .put("defaultOpenrouterModel", Ai.DEFAULT_OPENROUTER_MODEL)
            .toString()

        @JavascriptInterface
        fun saveSettings(json: String) {
            try {
                val clean = JSONObject(json)
                clean.remove("defaultGeminiModel")
                clean.remove("defaultClaudeModel")
                clean.remove("defaultDeepseekModel")
                clean.remove("defaultOpenrouterModel")
                prefs.edit().putString(KEY_SETTINGS, clean.toString()).apply()
            } catch (e: Exception) {
                emitError("Could not save settings.")
            }
        }

        @JavascriptInterface
        fun takePhoto() = runOnUiThread {
            try {
                val dir = File(cacheDir, "camera").apply { mkdirs() }
                val f = File(dir, "shot_${System.currentTimeMillis()}.jpg")
                prefs.edit().putString(KEY_PENDING_PHOTO, f.absolutePath).apply()
                cameraLauncher.launch(FileProvider.getUriForFile(this@MainActivity, "$packageName.files", f))
            } catch (e: Exception) {
                emitError("Could not open the camera on this phone. Use Gallery instead.")
            }
        }

        @JavascriptInterface
        fun pickImages() = runOnUiThread {
            try {
                galleryLauncher.launch("image/*")
            } catch (e: Exception) {
                emitError("Could not open the gallery.")
            }
        }

        @JavascriptInterface
        fun pickPdf() = runOnUiThread {
            try {
                pdfLauncher.launch(arrayOf("application/pdf"))
            } catch (e: Exception) {
                emitError("Could not open the file picker.")
            }
        }

        @JavascriptInterface
        fun pageCount(): Int = pages.count()

        /** Notes and the in-progress run are kept as files so their size is not limited. */
        @JavascriptInterface
        fun loadData(name: String): String = try {
            val f = File(filesDir, dataFile(name))
            if (f.exists()) f.readText() else ""
        } catch (e: Exception) {
            ""
        }

        @JavascriptInterface
        fun saveData(name: String, json: String): Boolean = try {
            val f = File(filesDir, dataFile(name))
            if (json.isEmpty()) {
                f.delete()
            } else {
                val tmp = File(filesDir, dataFile(name) + ".tmp")
                tmp.writeText(json)
                f.delete()
                tmp.renameTo(f)
            }
            true
        } catch (e: Exception) {
            false
        }

        private fun dataFile(name: String): String = if (name == "job") "job.json" else "notes.json"

        /** Keeps the screen on while a long run is working, so the phone does not pause it. */
        @JavascriptInterface
        fun keepAwake(on: Boolean) = runOnUiThread {
            val flag = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            if (on) window.addFlags(flag) else window.clearFlags(flag)
        }

        @JavascriptInterface
        fun thumb(index: Int): String = try {
            pages.thumb(index)
        } catch (e: Throwable) {
            ""
        }

        @JavascriptInterface
        fun removePage(index: Int) {
            pages.remove(index)
        }

        @JavascriptInterface
        fun clearPages() {
            pages.clear()
        }

        /** Groups pages into topics with one story each. Answers with "topicsDone": {id, ok, data | error}. */
        @JavascriptInterface
        fun makeTopics(id: String, digestJson: String) {
            io.execute {
                val out = JSONObject().put("id", id)
                try {
                    out.put("ok", true).put("data", Ai.makeTopics(settings(), org.json.JSONArray(digestJson)))
                } catch (e: Exception) {
                    out.put("ok", false).put("error", e.message ?: "Could not write the memory stories.")
                }
                emit("topicsDone", out)
            }
        }

        /** Looks up current prices and exchange rates. Answers with a "prices" event. */
        @JavascriptInterface
        fun fetchPrices(provider: String, model: String) {
            io.execute {
                val out = try {
                    Prices.fetch(provider, model)
                } catch (e: Exception) {
                    JSONObject()
                }
                emit("prices", out.put("model", model))
            }
        }

        /** Reads the DeepSeek balance. Answers with a "balance" event: {tag, ok, amount, currency}. */
        @JavascriptInterface
        fun deepseekBalance(tag: String) {
            io.execute {
                val out = JSONObject().put("tag", tag)
                try {
                    val b = Prices.deepseekBalance(settings().optString("deepseekKey", "").trim())
                    out.put("ok", true).put("amount", b.getDouble("amount")).put("currency", b.getString("currency"))
                } catch (e: Exception) {
                    out.put("ok", false)
                }
                emit("balance", out)
            }
        }

        /** Checks the key typed in Settings. Answers with a "keyTest" event: {provider, ok, message}. */
        @JavascriptInterface
        fun testKey(json: String) {
            io.execute {
                val out = JSONObject()
                try {
                    val s = JSONObject(json)
                    out.put("provider", s.optString("provider"))
                    out.put("ok", true).put("message", Ai.testKey(s))
                } catch (e: Exception) {
                    out.put("ok", false).put("message", e.message ?: "Could not check the key.")
                }
                emit("keyTest", out)
            }
        }

        /** Answers later with a "pageDone" event: {index, ok, data | error}. */
        @JavascriptInterface
        fun transcribe(index: Int) {
            io.execute {
                val out = JSONObject().put("index", index)
                try {
                    val s = settings()
                    val notes = if (s.optString("provider", "offline") == "offline") {
                        Offline.makeNotes(pages.file(index))
                    } else {
                        Ai.makeNotes(s, pages.file(index))
                    }
                    out.put("ok", true).put("data", notes)
                } catch (e: Ai.AiException) {
                    out.put("ok", false).put("error", e.message)
                } catch (e: OutOfMemoryError) {
                    out.put("ok", false).put("error", "This picture is too large for the phone's memory.")
                } catch (e: Exception) {
                    out.put("ok", false).put("error", e.message ?: "Something went wrong with this page.")
                }
                emit("pageDone", out)
            }
        }

        @JavascriptInterface
        fun print(title: String) = runOnUiThread {
            try {
                val pm = getSystemService(Context.PRINT_SERVICE) as PrintManager
                val attrs = PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build()
                pm.print(title, web.createPrintDocumentAdapter(title), attrs)
            } catch (e: Exception) {
                emitError("Could not open the print / save-as-PDF screen.")
            }
        }

        /** Answers with an "update" event: {available, version, notes}. */
        @JavascriptInterface
        fun checkUpdate() {
            io.execute {
                val info = Updater.check()
                updateUrl = info.optString("url", "")
                info.remove("url")
                emit("update", info)
            }
        }

        @JavascriptInterface
        fun installUpdate() {
            val url = updateUrl
            if (url.isEmpty()) return
            io.execute {
                try {
                    val apk = Updater.download(this@MainActivity, url) { pct ->
                        emit("updateProgress", JSONObject().put("pct", pct))
                    }
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", apk)
                    val intent = Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    runOnUiThread {
                        try {
                            startActivity(intent)
                        } catch (e: Exception) {
                            emit("updateError", JSONObject().put("message", "Could not open the installer."))
                        }
                    }
                    emit("updateProgress", JSONObject().put("pct", 100).put("done", true))
                } catch (e: Exception) {
                    emit("updateError", JSONObject().put("message", e.message ?: "Update download failed."))
                }
            }
        }
    }

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val KEY_SETTINGS = "settings"
        private const val KEY_PENDING_PHOTO = "pendingPhoto"
    }
}

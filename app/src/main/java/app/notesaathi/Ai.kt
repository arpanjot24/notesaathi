package app.notesaathi

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException

/** Sends one page picture to Gemini or Claude and gets back structured notes as JSON. */
object Ai {

    const val DEFAULT_GEMINI_MODEL = "gemini-flash-latest"
    const val DEFAULT_CLAUDE_MODEL = "claude-opus-5-5"

    // Claude models that accept the server-side refusal fallback.
    private val CLAUDE_FALLBACK_MODELS = setOf(
        "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"
    )

    class AiException(message: String) : Exception(message)

    private const val SYSTEM_PROMPT = """You turn a photo or scan of one page of study notes into clean, easy-to-read English notes.

The page may be handwritten or printed, and may be in any language (often Hindi, Punjabi or another Indian language, sometimes mixed with English). The reader is a student who wants to revise quickly.

Do this:
1. Read everything on the page carefully, including headings, side notes, labels on diagrams and anything underlined or boxed.
2. Write it in simple, clear English. Keep technical terms, names and formulae exact. If the original-language word matters, give it once in brackets after the English.
3. Rewrite it as short pointers grouped under clear headings. One idea per pointer. Keep every fact from the page; do not add facts that are not on the page and do not drop any.
4. Mark what matters most, sparingly (at most one or two marks in a pointer, and not in every pointer):
   [[k:...]] around a key term or the single most important phrase
   [[d:...]] around a definition, rule, law or formula
   [[n:...]] around an important number, date, name or place
   [[u:...]] around a word you could not read clearly, containing your best guess
5. Write a summary of 2 to 4 short lines covering the whole page.
6. Write one mnemonic that makes this page easy to remember, built as a short story from India. STYLE_LINE The story must be 3 to 6 short sentences, vivid and a little funny, and each character, object or event in it must stand for one key point from the page, in the same order as the notes. Then list how each story element maps to the fact it stands for. Be respectful towards religious and historical figures.

Reply with one JSON object only, no markdown fences and no other text, in exactly this shape:
{
  "title": "short title for this page",
  "language": "language(s) the page was written in",
  "sections": [ { "heading": "...", "points": ["...", "..."] } ],
  "summary": ["...", "..."],
  "mnemonic": { "title": "...", "story": "...", "links": ["story element = fact it stands for", "..."] }
}

If the picture has no readable notes (blank, too blurry, or not notes at all), reply instead with:
{ "unreadable": true, "reason": "one short sentence saying what is wrong and how to retake the photo" }"""

    private fun systemPrompt(settings: JSONObject): String {
        val style = when (settings.optString("mnemonicStyle", "mix")) {
            "traditional" -> "Base it on a well-known traditional story: Panchatantra, Akbar-Birbal, Tenali Rama, Jataka tales, Vikram-Betal, or an episode from the Ramayana or Mahabharata."
            "madeup" -> "Make up a new story set in everyday India: a village, a bazaar, a train journey, a cricket match, a chai stall, a wedding, a school."
            else -> "Use either a well-known traditional story (Panchatantra, Akbar-Birbal, Tenali Rama, Jataka tales, Vikram-Betal, Ramayana or Mahabharata episodes) or a made-up story set in everyday India (village, bazaar, train, cricket match, chai stall), whichever fits the content best."
        }
        return SYSTEM_PROMPT.replace("STYLE_LINE", style)
    }

    private fun userText(settings: JSONObject): String {
        val subject = settings.optString("subject", "").trim()
        return if (subject.isEmpty()) "Here is the page. Make the notes."
        else "Here is the page. The subject is: $subject. Make the notes."
    }

    fun makeNotes(settings: JSONObject, image: File): JSONObject {
        val b64 = Base64.encodeToString(image.readBytes(), Base64.NO_WRAP)
        val text = if (settings.optString("provider", "gemini") == "claude") {
            claude(settings, b64)
        } else {
            gemini(settings, b64)
        }
        return parseJson(text)
    }

    // ---------------------------------------------------------------- Gemini

    private fun gemini(settings: JSONObject, b64: String): String {
        val key = settings.optString("geminiKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your Gemini API key in Settings first.")
        val model = settings.optString("geminiModel", "").trim().ifEmpty { DEFAULT_GEMINI_MODEL }

        val body = JSONObject()
            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", systemPrompt(settings)))))
            .put("contents", JSONArray().put(
                JSONObject().put("role", "user").put("parts", JSONArray()
                    .put(JSONObject().put("inlineData", JSONObject().put("mimeType", "image/jpeg").put("data", b64)))
                    .put(JSONObject().put("text", userText(settings))))
            ))
            .put("generationConfig", JSONObject().put("responseMimeType", "application/json"))

        val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent"
        val res = postWithRetry(url, mapOf("x-goog-api-key" to key), body.toString(), "Gemini")
        val json = JSONObject(res)

        val candidates = json.optJSONArray("candidates")
        if (candidates == null || candidates.length() == 0) {
            val reason = json.optJSONObject("promptFeedback")?.optString("blockReason", "") ?: ""
            throw AiException("Gemini did not answer for this page" + if (reason.isNotEmpty()) " ($reason)." else ".")
        }
        val cand = candidates.getJSONObject(0)
        val parts = cand.optJSONObject("content")?.optJSONArray("parts")
        val sb = StringBuilder()
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val p = parts.getJSONObject(i)
                if (!p.optBoolean("thought", false)) sb.append(p.optString("text", ""))
            }
        }
        if (sb.isBlank()) {
            val finish = cand.optString("finishReason", "")
            throw AiException("Gemini returned nothing for this page" + if (finish.isNotEmpty()) " ($finish)." else ".")
        }
        if (cand.optString("finishReason", "") == "MAX_TOKENS") {
            throw AiException("This page has too much on it for one go. Photograph it in two halves.")
        }
        return sb.toString()
    }

    // ---------------------------------------------------------------- Claude

    private fun claude(settings: JSONObject, b64: String): String {
        val key = settings.optString("claudeKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your Claude API key in Settings first.")
        val model = settings.optString("claudeModel", "").trim().ifEmpty { DEFAULT_CLAUDE_MODEL }

        val body = JSONObject()
            .put("model", model)
            .put("max_tokens", 16000)
            .put("system", systemPrompt(settings))
            .put("output_config", JSONObject().put("effort", "medium"))
            .put("messages", JSONArray().put(
                JSONObject().put("role", "user").put("content", JSONArray()
                    .put(JSONObject().put("type", "image").put("source", JSONObject()
                        .put("type", "base64").put("media_type", "image/jpeg").put("data", b64)))
                    .put(JSONObject().put("type", "text").put("text", userText(settings))))
            ))

        val headers = mutableMapOf("x-api-key" to key, "anthropic-version" to "2023-06-01")
        if (model in CLAUDE_FALLBACK_MODELS) {
            // If a safety classifier declines the request, let the API retry on a fallback model.
            body.put("fallbacks", "default")
            headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
        }

        val res = postWithRetry("https://api.anthropic.com/v1/messages", headers, body.toString(), "Claude")
        val json = JSONObject(res)
        when (json.optString("stop_reason", "")) {
            "refusal" -> throw AiException("Claude declined to process this page.")
            "max_tokens" -> throw AiException("This page has too much on it for one go. Photograph it in two halves.")
        }
        val content = json.optJSONArray("content")
        val sb = StringBuilder()
        if (content != null) {
            for (i in 0 until content.length()) {
                val block = content.getJSONObject(i)
                if (block.optString("type") == "text") sb.append(block.optString("text", ""))
            }
        }
        if (sb.isBlank()) throw AiException("Claude returned nothing for this page.")
        return sb.toString()
    }

    // ---------------------------------------------------------------- shared

    private fun parseJson(text: String): JSONObject {
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) throw AiException("The AI reply was not in the expected format. Try this page again.")
        return try {
            JSONObject(text.substring(start, end + 1))
        } catch (e: Exception) {
            throw AiException("The AI reply was not in the expected format. Try this page again.")
        }
    }

    private fun postWithRetry(url: String, headers: Map<String, String>, body: String, who: String): String {
        val waits = longArrayOf(3000, 9000)
        var attempt = 0
        while (true) {
            val (code, text) = try {
                post(url, headers, body)
            } catch (e: UnknownHostException) {
                throw AiException("No internet connection.")
            } catch (e: SocketTimeoutException) {
                if (attempt < waits.size) {
                    Thread.sleep(waits[attempt++]); continue
                }
                throw AiException("$who took too long to answer. Try again.")
            } catch (e: java.io.IOException) {
                if (attempt < waits.size) {
                    Thread.sleep(waits[attempt++]); continue
                }
                throw AiException("Network problem: ${e.message ?: "connection lost"}")
            }
            if (code in 200..299) return text
            val retryable = code == 429 || code == 500 || code == 502 || code == 503 || code == 529
            if (retryable && attempt < waits.size) {
                Thread.sleep(waits[attempt++]); continue
            }
            throw AiException(errorMessage(who, code, text))
        }
    }

    private fun errorMessage(who: String, code: Int, text: String): String {
        val raw = try {
            JSONObject(text).optJSONObject("error")?.optString("message", "") ?: ""
        } catch (e: Exception) {
            ""
        }
        val detail = raw.take(220)
        val lead = when (code) {
            400 -> if (detail.contains("API key", true)) "$who did not accept the API key. Check it in Settings." else "$who rejected the request."
            401, 403 -> "$who did not accept the API key. Check it in Settings."
            404 -> "$who does not know that model name. Check the model in Settings."
            413 -> "The picture is too large for $who."
            429 -> "$who says the usage limit is reached. Wait a minute and try again."
            else -> "$who is having trouble right now (error $code). Try again shortly."
        }
        return if (detail.isEmpty()) lead else "$lead ($detail)"
    }

    private fun post(url: String, headers: Map<String, String>, body: String): Pair<Int, String> {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 30_000
            c.readTimeout = 300_000
            c.doOutput = true
            c.setFixedLengthStreamingMode(bytes.size)
            c.setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            c.outputStream.use { it.write(bytes) }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }
}

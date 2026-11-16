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
    const val DEFAULT_DEEPSEEK_MODEL = "deepseek-flash"
    const val DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite"
    private const val CHEAP_TEXT_MODEL = "deepseek/deepseek-v4.1-flash"

    // Learned while running: which DeepSeek model name answered, and whether it refused pictures.
    @Volatile private var deepseekWorkingModel: String? = null
    @Volatile private var deepseekNoPictures = false
    private const val TOPIC_CHUNK = 30

    /** The model's text plus the tokens the service says it billed for it. */
    private class Reply(
        val text: String, val tokensIn: Long, val tokensOut: Long,
        val usd: Double = -1.0, val tokensThink: Long = 0
    )

    // Claude models that accept the server-side refusal fallback.
    private val CLAUDE_FALLBACK_MODELS = setOf(
        "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"
    )

    class AiException(message: String, val code: Int = 0) : Exception(message)

    private const val PAGE_PROMPT = """You turn a photo or scan of one page of study notes into clean, easy-to-read English notes.

The page may be handwritten or printed, and may be in any language (often Hindi, Punjabi or another Indian language, sometimes mixed with English). The reader is a student who wants to revise quickly.

Do this:
1. Read everything on the page carefully, including headings, side notes, labels on diagrams and anything underlined or boxed.
2. Write it in simple, clear English. Keep technical terms, names and formulae exact. If the original-language word matters, give it once in brackets after the English.
3. Rewrite it as short pointers grouped under clear headings. One idea per pointer, as few words as carry the full meaning. Keep every fact from the page; do not add facts that are not on the page and do not drop any.
4. Mark what matters most, sparingly (at most one or two marks in a pointer, and not in every pointer):
   [[k:...]] around a key term or the single most important phrase
   [[d:...]] around a definition, rule, law or formula
   [[n:...]] around an important number, date, name or place
   [[u:...]] around a word you could not read clearly, containing your best guess
SUMMARY_STEP

Reply with one JSON object only, no markdown fences and no other text, in exactly this shape:
{
  "title": "short title for this page",
  "topic": "the chapter or topic this page belongs to",
  "language": "language(s) the page was written in",
  "sections": [ { "heading": "...", "points": ["...", "..."] } ]SUMMARY_FIELD
}

If the picture has no readable notes (blank, too blurry, or not notes at all), reply instead with:
{ "unreadable": true, "reason": "one short sentence saying what is wrong and how to retake the photo" }"""

    private const val TOPIC_PROMPT = """You are given a digest of consecutive pages from a student's notes: for each page its number, title, topic, headings and key points.

Do this:
1. Group the pages into topics. A topic is a run of consecutive pages about the same chapter or subject. A topic may be a single page. Every page in the digest must belong to exactly one topic, in order, with no gaps and no overlaps.
2. For each topic write one mnemonic that makes the whole topic easy to remember, built as a short story from India. STYLE_LINE The story must be 4 to 8 short sentences, vivid and a little funny, and each character, object or event in it must stand for one key point of the topic, in the same order as the notes. Then list how each story element maps to the fact it stands for. Use only facts from the digest. Be respectful towards religious and historical figures.

Reply with one JSON object only, no markdown fences and no other text, in exactly this shape:
{
  "topics": [
    {
      "from": 1,
      "to": 3,
      "title": "name of the topic",
      "mnemonic": { "title": "...", "story": "...", "links": ["story element = fact it stands for", "..."] }
    }
  ]
}
"from" and "to" are the first and last page numbers of the topic."""

    private fun styleLine(settings: JSONObject): String = when (settings.optString("mnemonicStyle", "mix")) {
        "traditional" -> "Base it on a well-known traditional story: Panchatantra, Akbar-Birbal, Tenali Rama, Jataka tales, Vikram-Betal, or an episode from the Ramayana or Mahabharata."
        "madeup" -> "Make up a new story set in everyday India: a village, a bazaar, a train journey, a cricket match, a chai stall, a wedding, a school."
        else -> "Use either a well-known traditional story (Panchatantra, Akbar-Birbal, Tenali Rama, Jataka tales, Vikram-Betal, Ramayana or Mahabharata episodes) or a made-up story set in everyday India (village, bazaar, train, cricket match, chai stall), whichever fits the content best."
    }

    private fun subjectNote(settings: JSONObject): String {
        val subject = settings.optString("subject", "").trim()
        return if (subject.isEmpty()) "" else " The subject is: $subject."
    }

    /** usd is the real charge when the service reports one (OpenRouter does); -1 means unknown. */
    private fun usage(tokensIn: Long, tokensOut: Long, usd: Double = -1.0, tokensThink: Long = 0): JSONObject {
        // "out" is everything billed as output (answer + thinking); "think" is the thinking share of it
        val u = JSONObject().put("in", tokensIn).put("out", tokensOut).put("think", tokensThink)
        if (usd >= 0) u.put("usd", usd)
        return u
    }

    /**
     * Exact-transcription mode: the user's own instructions, word for word. The reply is still
     * asked for inside a JSON wrapper so every AI service returns it the same way.
     */
    private fun exactPrompt(settings: JSONObject): String {
        val custom = settings.optString("customPrompt", "").trim()
        if (custom.isEmpty()) throw AiException("Open Settings, check the transcription instructions and tap Save.")
        val cut = custom.indexOf("After the transcription, write:")
        val rules = if (settings.optString("doubtful") == "off" && cut > 0) custom.substring(0, cut).trim() else custom
        return rules + "\n\nReturn your whole answer as one JSON object with a single field, like this: " +
            "{\"text\": \"the complete plain-text output described above, with \\n for each line break\"}. " +
            "Put nothing outside the JSON object."
    }

    private fun shaped(json: JSONObject, settings: JSONObject): JSONObject {
        if (settings.optString("outputMode") != "exact") return json
        val text = json.optString("text", "")
        if (text.isBlank()) throw AiException("The AI sent back an empty transcription. Try this page again.")
        return JSONObject().put("exact", true).put("text", text)
    }

    /**
     * Prepares a page picture for upload. Pages are already stored at no more than 1800 px on the
     * longest edge (see Pages.MAX_SIDE); this can shrink them further and, when gray is set, turn
     * them into a grayscale picture with the contrast raised. A smaller picture means fewer input
     * tokens; grayscale does not change the token count but makes the upload lighter and faint
     * pen or pencil easier to read.
     */
    private fun shrink(image: File, maxSide: Int = 1100, gray: Boolean = false): ByteArray {
        val bmp = android.graphics.BitmapFactory.decodeFile(image.absolutePath) ?: return image.readBytes()
        val scale = maxSide.toFloat() / maxOf(bmp.width, bmp.height)
        if (scale >= 1f && !gray) {
            bmp.recycle()
            return image.readBytes()
        }
        var picture = if (scale < 1f) {
            android.graphics.Bitmap.createScaledBitmap(
                bmp, maxOf(1, (bmp.width * scale).toInt()), maxOf(1, (bmp.height * scale).toInt()), true
            )
        } else bmp
        if (picture !== bmp) bmp.recycle()

        if (gray) {
            // grayscale, then stretch contrast around mid-gray (1.0 = unchanged)
            val contrast = 1.35f
            val shift = (0.5f - 0.5f * contrast) * 255f
            val matrix = android.graphics.ColorMatrix()
            matrix.setSaturation(0f)
            matrix.postConcat(android.graphics.ColorMatrix(floatArrayOf(
                contrast, 0f, 0f, 0f, shift,
                0f, contrast, 0f, 0f, shift,
                0f, 0f, contrast, 0f, shift,
                0f, 0f, 0f, 1f, 0f
            )))
            val paint = android.graphics.Paint()
            paint.colorFilter = android.graphics.ColorMatrixColorFilter(matrix)
            val grayPicture = android.graphics.Bitmap.createBitmap(
                picture.width, picture.height, android.graphics.Bitmap.Config.ARGB_8888
            )
            android.graphics.Canvas(grayPicture).drawBitmap(picture, 0f, 0f, paint)
            picture.recycle()
            picture = grayPicture
        }

        val out = java.io.ByteArrayOutputStream()
        picture.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
        picture.recycle()
        return out.toByteArray()
    }

    /** One page picture in, structured notes out. "_usage" carries the tokens billed. */
    fun makeNotes(settings: JSONObject, image: File): JSONObject {
        if (settings.optString("provider") == "gemini" && settings.optString("costSaving") == "on") {
            return costSavingPage(settings, image)
        }
        val gray = settings.optString("grayPictures") != "off"
        val bytes = shrink(image, if (settings.optString("smallPictures") == "on") 1100 else Pages.MAX_SIDE, gray)
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val summaries = settings.optString("summaries") != "off"
        val notesPrompt = PAGE_PROMPT
            .replace("SUMMARY_STEP", if (summaries) "5. Write a summary of 2 to 3 short lines covering the whole page." else "")
            .replace("SUMMARY_FIELD", if (summaries) ",\n  \"summary\": [\"...\", \"...\"]" else "")
        val exact = settings.optString("outputMode") == "exact"
        val system = if (exact) exactPrompt(settings) else notesPrompt
        val user = if (exact) "Here is the page. Transcribe it." else "Here is the page.${subjectNote(settings)} Make the notes."
        val deepseek = settings.optString("provider") == "deepseek"
        if (deepseek && deepseekNoPictures) return notesFromPhoneReading(settings, system, image)
        val reply = try {
            ask(settings, system, user, b64)
        } catch (e: AiException) {
            // DeepSeek may not take pictures: read the text on the phone and send only the text
            if (!deepseek || (e.code != 400 && e.code != 404 && e.code != 422)) throw e
            deepseekNoPictures = true
            return notesFromPhoneReading(settings, system, image)
        }
        return shaped(parseJson(reply.text), settings).put("_usage", usage(reply.tokensIn, reply.tokensOut, reply.usd, reply.tokensThink))
    }

    private fun notesFromPhoneReading(settings: JSONObject, system: String, image: File): JSONObject {
        val text = Offline.readText(image)
        if (text.count { it.isLetterOrDigit() } < 15) {
            return JSONObject().put("unreadable", true).put(
                "reason",
                "DeepSeek did not accept the picture, and the phone's own reader found almost no text. That reader only manages printed or very neat English and Hindi."
            )
        }
        val user = "The page was read by OCR on a phone, so the text may contain mistakes; fix obvious OCR errors from context." +
            "${subjectNote(settings)} Make the notes from this text:\n\n$text"
        val reply = ask(settings, system, user, null)
        return shaped(parseJson(reply.text), settings).put("_usage", usage(reply.tokensIn, reply.tokensOut, reply.usd, reply.tokensThink)).put("ocr", true)
    }

    /**
     * digest: [{page, title, topic, headings, points}], page numbers in order.
     * Returns {topics: [{from, to, title, mnemonic}], _usage}. Long documents are done in
     * chunks; a topic that crosses a chunk border is split there.
     */
    fun makeTopics(settings: JSONObject, digest: JSONArray): JSONObject {
        // Writing stories is plain text work, so with OpenRouter it can go to the cheapest model.
        val cheaper = settings.optString("provider") == "openrouter" &&
            settings.optString("cheapStories") != "off" &&
            settings.optString("openrouterModel") != CHEAP_TEXT_MODEL
        if (cheaper) {
            try {
                return topicsWith(JSONObject(settings.toString()).put("openrouterModel", CHEAP_TEXT_MODEL), digest)
            } catch (e: Exception) {
                // the cheap model failed: use the model the user chose
            }
        }
        return topicsWith(settings, digest)
    }

    private fun topicsWith(settings: JSONObject, digest: JSONArray): JSONObject {
        val system = TOPIC_PROMPT.replace("STYLE_LINE", styleLine(settings))
        val all = JSONArray()
        var tokensIn = 0L
        var tokensOut = 0L
        var usd = -1.0
        var start = 0
        while (start < digest.length()) {
            val chunk = JSONArray()
            for (i in start until minOf(start + TOPIC_CHUNK, digest.length())) chunk.put(digest.get(i))
            val user = "Here is the digest.${subjectNote(settings)}\n\n$chunk"
            val reply = ask(settings, system, user, null)
            tokensIn += reply.tokensIn
            tokensOut += reply.tokensOut
            if (reply.usd >= 0) usd = maxOf(usd, 0.0) + reply.usd
            val topics = parseJson(reply.text).optJSONArray("topics")
            if (topics != null) for (i in 0 until topics.length()) all.put(topics.get(i))
            start += TOPIC_CHUNK
        }
        return JSONObject().put("topics", all).put("_usage", usage(tokensIn, tokensOut, usd))
    }

    private fun ask(settings: JSONObject, system: String, user: String, imageB64: String?): Reply =
        when (settings.optString("provider", "gemini")) {
            "claude" -> claude(settings, system, user, imageB64)
            "deepseek" -> deepseek(settings, system, user, imageB64)
            "openrouter" -> openrouter(settings, system, user, imageB64)
            else -> gemini(settings, system, user, imageB64)
        }

    /** One tiny request to check a key and model name. Returns a success line or throws. */
    fun testKey(settings: JSONObject): String {
        if (settings.optString("provider") == "openrouter") {
            val model = settings.optString("openrouterModel", "").trim().ifEmpty { DEFAULT_OPENROUTER_MODEL }
            openrouter(settings, "Reply with a JSON object.", "Reply with {\"ok\": true}", null)
            return "OpenRouter key works (model $model)."
        }
        if (settings.optString("provider") == "deepseek") {
            deepseekWorkingModel = null
            deepseek(settings, "Reply with a JSON object.", "Reply with {\"ok\": true}", null)
            val balance = try {
                val b = Prices.deepseekBalance(settings.optString("deepseekKey", "").trim())
                " Balance: ${b.getString("currency")} ${b.getDouble("amount")}."
            } catch (e: Exception) {
                ""
            }
            return "DeepSeek key works (model ${deepseekWorkingModel ?: settings.optString("deepseekModel")}).$balance"
        }
        val claude = settings.optString("provider") == "claude"
        val who = if (claude) "Claude" else "Gemini"
        val key = settings.optString(if (claude) "claudeKey" else "geminiKey", "").trim()
        if (key.isEmpty()) throw AiException("Paste your $who key first.")
        val result = try {
            if (claude) {
                val model = settings.optString("claudeModel", "").trim().ifEmpty { DEFAULT_CLAUDE_MODEL }
                val body = JSONObject().put("model", model).put("max_tokens", 16)
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "Say OK")))
                post(
                    "https://api.anthropic.com/v1/messages",
                    mapOf("x-api-key" to key, "anthropic-version" to "2023-06-01"),
                    body.toString()
                )
            } else {
                val model = settings.optString("geminiModel", "").trim().ifEmpty { DEFAULT_GEMINI_MODEL }
                val body = JSONObject().put("contents", JSONArray().put(
                    JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", "Say OK")))
                ))
                post(
                    "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent",
                    mapOf("x-goog-api-key" to key),
                    body.toString()
                )
            }
        } catch (e: UnknownHostException) {
            throw AiException("No internet connection.")
        } catch (e: java.io.IOException) {
            throw AiException("Network problem: ${e.message ?: "connection lost"}")
        }
        if (result.first !in 200..299) throw AiException(errorMessage(who, result.first, result.second))
        return "$who key works."
    }

    // ---------------------------------------------------------------- Gemini cost-saving mode

    /** The one place to change the model cost-saving mode uses when none is picked in Settings. */
    const val COST_SAVING_GEMINI_MODEL = "gemini-3.1-flash-lite"
    private const val COST_SAVING_MAX_SIDE = 1500

    private const val COST_SAVING_PROMPT = """You transcribe handwritten Indian law notes (LLB/LLM level) exactly as written, then flag doubtful facts.

TRANSCRIPTION RULES
1. Copy the writer's words verbatim. Do NOT paraphrase, summarise, reorder, or add explanations, definitions or headings that are not on the page.
2. Keep every negative exactly: can't, not, no, never. Double-check these.
3. Keep the writer's abbreviations as-is: R8 = right, ICA, TPA, SOGA, b/w, eg, i.e., S. = Section.
4. Hindi/Punjabi words: write them in the original script, then a short English meaning in [ ].
5. Numbers and years: copy digit by digit. If a digit is unclear, write your best reading followed by (?). Never correct a year or fact inside the transcription.
6. Case names and Acts: use this list to resolve unclear spellings. If a word clearly matches one, use it:
   Luke v Lyde, Slade v Morley, Humber Ferryman's Case, Pacta Sunt Servanda, Assumpsit, Quid Pro Quo, Magna Carta, Indian Contract Act 1872, Transfer of Property Act (TPA), Sale of Goods Act (SOGA), Specific Relief Act, NDPS Act, Vyavaharmayukha, Smritis, Shrutis.
7. Unreadable word: write [?]. Struck-out word: ~~word~~.
8. Arrows (→ ↓) and numbering (1, 2, 3): keep them as written.

OUTPUT FORMAT
- Plain text, one line per handwritten line or bullet.
- Use **bold** only where the writer underlined or highlighted.
- No intro, no closing remarks, no page titles, no summary."""

    // Left out of the request when "Include doubtful points" is off, to save output tokens.
    private const val COST_SAVING_DOUBTFUL = """

After the transcription, write:
DOUBTFUL POINTS
- List only facts, dates, case names or section numbers in the notes that may be legally or historically wrong. Give the likely correct version. Max 1 line each, max 5 items.
- If nothing is doubtful, write "None".
- Do not change the transcription itself."""

    // Which request shape each model accepted, so a rejected setting is only tried once per model.
    private val costSavingShape = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /**
     * One page, one request: system_instruction + (page picture, "Transcribe."), plain-text reply.
     * Settings are tried from cheapest to plainest, because models differ in what they accept:
     *   0: temperature 0, medium picture detail, thinking budget 0   (models where thinking can be off)
     *   1: the same, but thinking level "minimal"                    (Gemini 3.x Flash-Lite: cannot be off)
     *   2: no thinking setting at all
     *   3: no thinking setting and default picture detail
     */
    private fun costSavingPage(settings: JSONObject, image: File): JSONObject {
        val key = settings.optString("geminiKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your Gemini API key in Settings first.")
        val model = settings.optString("geminiModel", "").trim().ifEmpty { COST_SAVING_GEMINI_MODEL }
        val b64 = Base64.encodeToString(shrink(image, COST_SAVING_MAX_SIDE, settings.optString("grayPictures") != "off"), Base64.NO_WRAP)
        val system = COST_SAVING_PROMPT + if (settings.optString("doubtful") != "off") COST_SAVING_DOUBTFUL else ""
        val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent"

        var shape = costSavingShape[model] ?: 0
        while (true) {
            val config = JSONObject().put("temperature", 0)
            if (shape <= 2) config.put("mediaResolution", "MEDIA_RESOLUTION_MEDIUM")
            if (shape == 0) config.put("thinkingConfig", JSONObject().put("thinkingBudget", 0))
            if (shape == 1) config.put("thinkingConfig", JSONObject().put("thinkingLevel", "minimal"))
            val body = JSONObject()
                .put("system_instruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", system))))
                .put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", JSONArray()
                    .put(JSONObject().put("inline_data", JSONObject().put("mime_type", "image/jpeg").put("data", b64)))
                    .put(JSONObject().put("text", "Transcribe.")))))
                .put("generationConfig", config)

            val res = try {
                postWithRetry(url, mapOf("x-goog-api-key" to key), body.toString(), "Gemini")
            } catch (e: AiException) {
                // 400 = this model does not take one of the settings: step down and ask again
                if (e.code != 400 || shape >= 3) throw e
                shape++
                continue
            }
            costSavingShape[model] = shape

            val json = JSONObject(res)
            val cand = json.optJSONArray("candidates")?.optJSONObject(0)
                ?: throw AiException("Gemini did not answer for this page.")
            val parts = cand.optJSONObject("content")?.optJSONArray("parts")
            val sb = StringBuilder()
            if (parts != null) {
                for (i in 0 until parts.length()) {
                    val p = parts.getJSONObject(i)
                    if (!p.optBoolean("thought", false)) sb.append(p.optString("text", ""))
                }
            }
            if (cand.optString("finishReason", "") == "MAX_TOKENS") {
                throw AiException("There is too much here for one go. Photograph the page in two halves.")
            }
            if (sb.isBlank()) throw AiException("Gemini returned nothing for this page.")

            val u = json.optJSONObject("usageMetadata")
            val prompt = u?.optLong("promptTokenCount", 0) ?: 0
            val candidates = u?.optLong("candidatesTokenCount", 0) ?: 0
            val thoughts = u?.optLong("thoughtsTokenCount", 0) ?: 0
            android.util.Log.i(
                "NoteSaathi",
                "cost-saving page ${image.name} model=$model shape=$shape " +
                    "promptTokenCount=$prompt candidatesTokenCount=$candidates thoughtsTokenCount=$thoughts"
            )
            return JSONObject()
                .put("exact", true)
                .put("text", sb.toString().trim())
                .put("_usage", usage(prompt, candidates + thoughts, tokensThink = thoughts))
        }
    }

    // ---------------------------------------------------------------- Gemini

    private fun gemini(settings: JSONObject, system: String, user: String, imageB64: String?): Reply {
        val key = settings.optString("geminiKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your Gemini API key in Settings first.")
        val model = settings.optString("geminiModel", "").trim().ifEmpty { DEFAULT_GEMINI_MODEL }

        val parts = JSONArray()
        if (imageB64 != null) {
            parts.put(JSONObject().put("inlineData", JSONObject().put("mimeType", "image/jpeg").put("data", imageB64)))
        }
        parts.put(JSONObject().put("text", user))
        val lowThinking = settings.optString("lowThinking") == "on"
        val config = JSONObject().put("responseMimeType", "application/json")
        if (lowThinking) config.put("thinkingConfig", JSONObject().put("thinkingLevel", "low"))
        val body = JSONObject()
            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", system))))
            .put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", parts)))
            .put("generationConfig", config)

        val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent"
        val res = try {
            postWithRetry(url, mapOf("x-goog-api-key" to key), body.toString(), "Gemini")
        } catch (e: AiException) {
            if (!lowThinking || e.code != 400) throw e
            // this model does not accept the thinking setting: ask again without it
            config.remove("thinkingConfig")
            postWithRetry(url, mapOf("x-goog-api-key" to key), body.toString(), "Gemini")
        }
        val json = JSONObject(res)

        val candidates = json.optJSONArray("candidates")
        if (candidates == null || candidates.length() == 0) {
            val reason = json.optJSONObject("promptFeedback")?.optString("blockReason", "") ?: ""
            throw AiException("Gemini did not answer" + if (reason.isNotEmpty()) " ($reason)." else ".")
        }
        val cand = candidates.getJSONObject(0)
        val outParts = cand.optJSONObject("content")?.optJSONArray("parts")
        val sb = StringBuilder()
        if (outParts != null) {
            for (i in 0 until outParts.length()) {
                val p = outParts.getJSONObject(i)
                if (!p.optBoolean("thought", false)) sb.append(p.optString("text", ""))
            }
        }
        if (sb.isBlank()) {
            val finish = cand.optString("finishReason", "")
            throw AiException("Gemini returned nothing" + if (finish.isNotEmpty()) " ($finish)." else ".")
        }
        if (cand.optString("finishReason", "") == "MAX_TOKENS") {
            throw AiException("There is too much here for one go. Photograph the page in two halves.")
        }
        // thinking tokens are billed at the output rate
        val u = json.optJSONObject("usageMetadata")
        val tokensIn = u?.optLong("promptTokenCount", 0) ?: 0
        val tokensOut = (u?.optLong("candidatesTokenCount", 0) ?: 0) + (u?.optLong("thoughtsTokenCount", 0) ?: 0)
        return Reply(sb.toString(), tokensIn, tokensOut, tokensThink = u?.optLong("thoughtsTokenCount", 0) ?: 0)
    }

    // ---------------------------------------------------------------- Claude

    private fun claude(settings: JSONObject, system: String, user: String, imageB64: String?): Reply {
        val key = settings.optString("claudeKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your Claude API key in Settings first.")
        val model = settings.optString("claudeModel", "").trim().ifEmpty { DEFAULT_CLAUDE_MODEL }

        val content = JSONArray()
        if (imageB64 != null) {
            content.put(JSONObject().put("type", "image").put("source", JSONObject()
                .put("type", "base64").put("media_type", "image/jpeg").put("data", imageB64)))
        }
        content.put(JSONObject().put("type", "text").put("text", user))
        val body = JSONObject()
            .put("model", model)
            .put("max_tokens", 16000)
            .put("system", system)
            .put("output_config", JSONObject().put("effort", if (settings.optString("lowThinking") == "on") "low" else "medium"))
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))

        val headers = mutableMapOf("x-api-key" to key, "anthropic-version" to "2023-06-01")
        if (model in CLAUDE_FALLBACK_MODELS) {
            // If a safety classifier declines the request, let the API retry on a fallback model.
            body.put("fallbacks", "default")
            headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
        }

        val res = postWithRetry("https://api.anthropic.com/v1/messages", headers, body.toString(), "Claude")
        val json = JSONObject(res)
        when (json.optString("stop_reason", "")) {
            "refusal" -> throw AiException("Claude declined to process this.")
            "max_tokens" -> throw AiException("There is too much here for one go. Photograph the page in two halves.")
        }
        val blocks = json.optJSONArray("content")
        val sb = StringBuilder()
        if (blocks != null) {
            for (i in 0 until blocks.length()) {
                val block = blocks.getJSONObject(i)
                if (block.optString("type") == "text") sb.append(block.optString("text", ""))
            }
        }
        if (sb.isBlank()) throw AiException("Claude returned nothing.")
        val u = json.optJSONObject("usage")
        return Reply(sb.toString(), u?.optLong("input_tokens", 0) ?: 0, u?.optLong("output_tokens", 0) ?: 0)
    }

    // ---------------------------------------------------------------- DeepSeek

    private fun deepseek(settings: JSONObject, system: String, user: String, imageB64: String?): Reply {
        val key = settings.optString("deepseekKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your DeepSeek API key in Settings first.")
        val chosen = settings.optString("deepseekModel", "").trim()
        val remembered = deepseekWorkingModel
        val models = when {
            chosen.isNotEmpty() && chosen != DEFAULT_DEEPSEEK_MODEL -> listOf(chosen)
            remembered != null -> listOf(remembered)
            else -> listOf(DEFAULT_DEEPSEEK_MODEL, "deepseek-chat")
        }
        var last: AiException? = null
        for (model in models) {
            try {
                val reply = deepseekCall(key, model, system, user, imageB64)
                deepseekWorkingModel = model
                return reply
            } catch (e: AiException) {
                // a wrong model name or an unsupported picture: try the next name
                if (e.code != 400 && e.code != 404 && e.code != 422) throw e
                last = e
            }
        }
        throw last ?: AiException("DeepSeek did not answer.")
    }

    /** DeepSeek speaks the OpenAI-style chat format. */
    private fun deepseekCall(key: String, model: String, system: String, user: String, imageB64: String?): Reply {
        val userContent: Any = if (imageB64 != null) {
            JSONArray()
                .put(JSONObject().put("type", "image_url")
                    .put("image_url", JSONObject().put("url", "data:image/jpeg;base64,$imageB64")))
                .put(JSONObject().put("type", "text").put("text", user))
        } else user
        val body = JSONObject()
            .put("model", model)
            .put("stream", false)
            .put("response_format", JSONObject().put("type", "json_object"))
            .put("messages", JSONArray()
                .put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", userContent)))

        val res = postWithRetry(
            "https://api.deepseek.com/chat/completions",
            mapOf("Authorization" to "Bearer $key"),
            body.toString(),
            "DeepSeek"
        )
        val json = JSONObject(res)
        val choice = json.optJSONArray("choices")?.optJSONObject(0)
            ?: throw AiException("DeepSeek did not answer.")
        if (choice.optString("finish_reason") == "length") {
            throw AiException("There is too much here for one go. Photograph the page in two halves.")
        }
        val text = choice.optJSONObject("message")?.optString("content", "") ?: ""
        if (text.isBlank()) throw AiException("DeepSeek returned nothing.")
        val u = json.optJSONObject("usage")
        return Reply(text, u?.optLong("prompt_tokens", 0) ?: 0, u?.optLong("completion_tokens", 0) ?: 0)
    }

    // ---------------------------------------------------------------- OpenRouter

    /** OpenRouter passes the request to whichever model is named, and reports the real charge. */
    private fun openrouter(settings: JSONObject, system: String, user: String, imageB64: String?): Reply {
        val key = settings.optString("openrouterKey", "").trim()
        if (key.isEmpty()) throw AiException("Add your OpenRouter API key in Settings first.")
        val model = settings.optString("openrouterModel", "").trim().ifEmpty { DEFAULT_OPENROUTER_MODEL }

        val userContent: Any = if (imageB64 != null) {
            JSONArray()
                .put(JSONObject().put("type", "text").put("text", user))
                .put(JSONObject().put("type", "image_url")
                    .put("image_url", JSONObject().put("url", "data:image/jpeg;base64,$imageB64")))
        } else user
        val body = JSONObject()
            .put("model", model)
            .put("stream", false)
            .put("response_format", JSONObject().put("type", "json_object"))
            .put("usage", JSONObject().put("include", true))
            .put("messages", JSONArray()
                .put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", userContent)))
        if (settings.optString("lowThinking") == "on") {
            body.put("reasoning", JSONObject().put("effort", "low"))
        }

        val res = postWithRetry(
            "https://openrouter.ai/api/v1/chat/completions",
            mapOf("Authorization" to "Bearer $key", "X-Title" to "NoteSaathi"),
            body.toString(),
            "OpenRouter"
        )
        val json = JSONObject(res)
        // OpenRouter can return an error inside a 200 reply
        json.optJSONObject("error")?.let {
            throw AiException("OpenRouter: " + it.optString("message", "the model could not answer").take(220))
        }
        val choice = json.optJSONArray("choices")?.optJSONObject(0)
            ?: throw AiException("OpenRouter did not answer.")
        if (choice.optString("finish_reason") == "length") {
            throw AiException("There is too much here for one go. Photograph the page in two halves.")
        }
        val text = choice.optJSONObject("message")?.optString("content", "") ?: ""
        if (text.isBlank()) throw AiException("OpenRouter returned nothing. The chosen model may not accept pictures.")
        val u = json.optJSONObject("usage")
        val cost = u?.optDouble("cost", Double.NaN) ?: Double.NaN
        return Reply(
            text,
            u?.optLong("prompt_tokens", 0) ?: 0,
            u?.optLong("completion_tokens", 0) ?: 0,
            if (cost.isNaN()) -1.0 else cost
        )
    }

    // ---------------------------------------------------------------- shared

    private fun parseJson(text: String): JSONObject {
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) throw AiException("The AI reply was not in the expected format. Try again.")
        return try {
            JSONObject(text.substring(start, end + 1))
        } catch (e: Exception) {
            throw AiException("The AI reply was not in the expected format. Try again.")
        }
    }

    private fun postWithRetry(url: String, headers: Map<String, String>, body: String, who: String): String {
        val waits = longArrayOf(4000, 12000, 30000)
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
            throw AiException(errorMessage(who, code, text), code)
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
            402 -> "$who says the account has no balance left. Add credit on its website."
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

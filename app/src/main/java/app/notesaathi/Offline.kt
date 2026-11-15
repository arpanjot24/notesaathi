package app.notesaathi

import android.graphics.BitmapFactory
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The no-API-key mode. Reads the page with the on-device text recogniser (Latin and Devanagari
 * scripts), translates Hindi to English with the on-device translator, and arranges the result
 * into the same notes shape the AI mode returns. No language model is involved, so the result is
 * a tidy-up of what was read, not a rewrite.
 */
object Offline {

    private class Section(val heading: String) {
        val points = mutableListOf<String>()
    }

    private val BULLET = Regex("""^\s*(?:[-•*·→>✓]+|\(?\d{1,2}[.)]|\(?[a-zA-Z][.)])\s+""")
    private val SENTENCE_END = Regex("""(?<=[.!?।])\s+""")
    private val NUMBER = Regex("""\b\d+(?:[.,/:-]\d+)*%?""")
    private val KEY_PREFIX = Regex("""^([A-Z][\w' -]{2,38}?)(\s*[:=–-]\s+|\s+(?:is|are|means|refers to)\s+)""")
    private val WORD = Regex("""[A-Za-z]{4,}""")
    private val STOP = setOf(
        "this", "that", "with", "from", "have", "which", "their", "there", "these", "those", "into",
        "also", "them", "they", "were", "been", "when", "what", "where", "will", "such", "than",
        "then", "some", "other", "about", "called", "known", "used", "each", "more", "most", "many"
    )

    fun makeNotes(image: File): JSONObject {
        val bmp = BitmapFactory.decodeFile(image.absolutePath)
            ?: throw Ai.AiException("Could not open this page.")
        val recognizer = TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build())
        val text = try {
            Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)), 90, TimeUnit.SECONDS)
        } catch (e: Exception) {
            throw Ai.AiException("On-device reading failed for this page. Try again, or use an AI key in Settings.")
        } finally {
            recognizer.close()
        }
        bmp.recycle()

        val blocks = text.textBlocks.map { b -> b.lines.map { it.text.trim() }.filter { it.isNotEmpty() } }
            .filter { it.isNotEmpty() }
        val allText = blocks.flatten().joinToString(" ")
        if (allText.count { it.isLetterOrDigit() } < 15) {
            return JSONObject().put("unreadable", true).put(
                "reason",
                "The on-device reader found almost no text. It works best on printed or very neat writing in good light. For handwriting, add an AI key in Settings."
            )
        }

        val hasHindi = allText.any { isDevanagari(it) }
        var translator: Translator? = null
        if (hasHindi) {
            translator = Translation.getClient(
                TranslatorOptions.Builder()
                    .setSourceLanguage(TranslateLanguage.HINDI)
                    .setTargetLanguage(TranslateLanguage.ENGLISH)
                    .build()
            )
            try {
                Tasks.await(translator.downloadModelIfNeeded(), 240, TimeUnit.SECONDS)
            } catch (e: Exception) {
                translator.close()
                throw Ai.AiException("To translate Hindi without an AI key, the app must download a language pack once (about 30 MB). Connect to the internet and try again.")
            }
        }

        try {
            val sections = buildSections(blocks, translator)
            return toJson(sections, hasHindi)
        } finally {
            translator?.close()
        }
    }

    private fun isDevanagari(c: Char) = c in 'ऀ'..'ॿ'

    private fun english(s: String, translator: Translator?): String {
        if (translator == null || s.none { isDevanagari(it) }) return s
        return try {
            Tasks.await(translator.translate(s), 60, TimeUnit.SECONDS)
        } catch (e: Exception) {
            s
        }
    }

    private fun clean(s: String): String =
        s.replace("[[", "(").replace("]]", ")").replace(Regex("""\s+"""), " ").trim()

    private fun buildSections(blocks: List<List<String>>, translator: Translator?): List<Section> {
        val sections = mutableListOf<Section>()
        for (lines in blocks) {
            val joined = lines.joinToString(" ")
            val words = joined.split(' ').count { it.isNotBlank() }
            val looksLikeHeading = lines.size == 1 && joined.length <= 45 && words <= 7 &&
                !joined.endsWith(".") && !joined.endsWith("।") && !BULLET.containsMatchIn(joined)

            if (looksLikeHeading) {
                val h = clean(english(joined, translator)).trimEnd(':', '-', '–').trim()
                if (h.isNotEmpty()) sections.add(Section(h))
                continue
            }

            val bulleted = lines.count { BULLET.containsMatchIn(it) }
            val avgLen = lines.sumOf { it.length } / lines.size
            val pieces: List<String> = if (lines.size >= 2 && (bulleted * 2 >= lines.size || avgLen < 40)) {
                lines.map { it.replace(BULLET, "") }
            } else {
                // a paragraph: translate it whole (better English), then cut into sentences
                english(joined.replace(BULLET, ""), translator).split(SENTENCE_END)
            }
            if (sections.isEmpty()) sections.add(Section(""))
            for (piece in pieces) {
                val p = clean(english(piece, translator))
                if (p.count { it.isLetterOrDigit() } >= 3) sections.last().points.add(p)
            }
        }
        return sections.filter { it.points.isNotEmpty() || it.heading.isNotEmpty() }
    }

    /** Colours the leading term of "Term: ..." / "Term is ..." and up to two numbers. */
    private fun highlight(point: String): String {
        val m = KEY_PREFIX.find(point)
        val head = if (m != null) "[[k:${m.groupValues[1]}]]${m.groupValues[2]}" else ""
        val rest = if (m != null) point.substring(m.range.last + 1) else point
        var marked = 0
        val body = NUMBER.replace(rest) { r ->
            if (marked < 2) {
                marked++
                "[[n:${r.value}]]"
            } else r.value
        }
        return head + body
    }

    private fun toJson(sections: List<Section>, hasHindi: Boolean): JSONObject {
        val allPoints = sections.flatMap { it.points }
        val headings = sections.map { it.heading }.filter { it.isNotEmpty() }
        val title = headings.firstOrNull()
            ?: allPoints.firstOrNull()?.split(' ')?.take(6)?.joinToString(" ")?.trimEnd('.', ',', ':')
            ?: "Notes"

        val secArr = JSONArray()
        for (s in sections) {
            if (s.points.isEmpty()) continue
            val pts = JSONArray()
            s.points.forEach { pts.put(highlight(it)) }
            secArr.put(JSONObject().put("heading", if (s.heading == title && sections.size == 1) "" else s.heading).put("points", pts))
        }

        // key terms for the memory trick: headings first, then leading terms of points
        val keys = LinkedHashSet<String>()
        headings.filter { it != title }.forEach { keys.add(it) }
        allPoints.forEach { p -> KEY_PREFIX.find(p)?.let { keys.add(it.groupValues[1].trim()) } }
        if (keys.size < 3) allPoints.forEach { p ->
            val w = p.split(' ').take(3).joinToString(" ").trimEnd('.', ',', ':')
            if (w.length >= 4) keys.add(w)
        }

        val out = JSONObject()
            .put("basic", true)
            .put("title", title)
            .put("language", if (hasHindi) "Hindi" else "")
            .put("sections", secArr)
            .put("summary", JSONArray(summary(allPoints)))
        mnemonic(keys.take(6))?.let { out.put("mnemonic", it) }
        return out
    }

    /** Picks the sentences that share the most frequent words on the page. */
    private fun summary(points: List<String>): List<String> {
        if (points.size <= 3) return points.take(2)
        val freq = HashMap<String, Int>()
        val wordsOf = { s: String ->
            WORD.findAll(s).map { it.value.lowercase() }.filter { it !in STOP }.toList()
        }
        points.forEach { p -> wordsOf(p).forEach { w -> freq[w] = (freq[w] ?: 0) + 1 } }
        val scored = points.mapIndexed { i, p ->
            val ws = wordsOf(p)
            val score = if (ws.isEmpty()) 0.0 else ws.sumOf { freq[it] ?: 0 } / Math.sqrt(ws.size.toDouble())
            Triple(i, p, score)
        }
        return scored.sortedByDescending { it.third }.take(3).sortedBy { it.first }.map { it.second }
    }

    /** A memory-journey trick: hang each key point on a fixed, familiar sequence. */
    private fun mnemonic(keys: List<String>): JSONObject? {
        if (keys.size < 2) return null
        val frames = listOf(
            Triple(
                "The chaiwala's train",
                "Picture a long train ride across India. At every station the chaiwala climbs on, but instead of 'chai, chai' he shouts one thing from your notes. ",
                listOf("Amritsar", "Delhi", "Agra", "Bhopal", "Nagpur", "Chennai")
            ),
            Triple(
                "The wedding thali",
                "Picture a big wedding thali in front of you. Each katori holds one idea from your notes instead of food, and you taste them left to right. ",
                listOf("the dal katori", "the sabzi katori", "the raita katori", "the rice", "the roti", "the mithai")
            ),
            Triple(
                "The last over",
                "It is the last over of a final at a packed stadium. On every ball the commentator screams one thing from your notes. ",
                listOf("Ball 1", "Ball 2", "Ball 3", "Ball 4", "Ball 5", "Ball 6")
            )
        )
        val frame = frames[Math.abs(keys.joinToString().hashCode()) % frames.size]
        val story = StringBuilder(frame.second)
        val links = JSONArray()
        keys.forEachIndexed { i, k ->
            val spot = frame.third[i]
            story.append(if (frame.first == "The last over") "$spot: \"$k\". " else "At $spot: \"$k\". ")
            links.put("${spot.replaceFirstChar { it.uppercase() }} = $k")
        }
        story.append("Replay it once in your head, in order, and the points come back.")
        val letters = keys.mapNotNull { k -> k.firstOrNull { it.isLetter() }?.uppercaseChar() }
        if (letters.size >= 3) links.put("First letters: " + letters.joinToString(" – "))
        return JSONObject().put("title", frame.first).put("story", story.toString()).put("links", links)
    }
}

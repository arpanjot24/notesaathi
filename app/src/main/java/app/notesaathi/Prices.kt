package app.notesaathi

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Looks up current per-token prices and exchange rates from public sources, and reads the
 * DeepSeek account balance. Nothing about the user or their notes is sent: these are plain GETs.
 */
object Prices {

    // Community-maintained price list used by many tools; not published by the AI providers themselves.
    private const val PRICE_LIST =
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
    private const val RATES = "https://open.er-api.com/v6/latest/USD"

    fun get(url: String, headers: Map<String, String> = emptyMap()): String {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            c.setRequestProperty("User-Agent", "NoteSaathi-Android")
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            val code = c.responseCode
            if (code !in 200..299) throw IllegalStateException("error $code")
            return c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /**
     * Returns whatever could be found: {in, out} in US$ per million tokens for the model,
     * {inr, cny} per US dollar. Missing parts are simply absent.
     */
    fun fetch(provider: String, model: String): JSONObject {
        val out = JSONObject()
        try {
            val rates = JSONObject(get(RATES)).getJSONObject("rates")
            out.put("inr", rates.getDouble("INR"))
            out.put("cny", rates.getDouble("CNY"))
        } catch (e: Exception) {
            // leave the rate out
        }
        if (provider == "openrouter") {
            // OpenRouter publishes its own prices, per token, for every model it offers
            try {
                val models = JSONObject(get("https://openrouter.ai/api/v1/models")).getJSONArray("data")
                for (i in 0 until models.length()) {
                    val m = models.getJSONObject(i)
                    if (m.optString("id") != model) continue
                    val pricing = m.optJSONObject("pricing") ?: break
                    val pin = pricing.optString("prompt").toDoubleOrNull()
                    val pout = pricing.optString("completion").toDoubleOrNull()
                    if (pin != null && pout != null && pin >= 0 && pout >= 0) {
                        out.put("in", pin * 1_000_000).put("out", pout * 1_000_000)
                    }
                    break
                }
            } catch (e: Exception) {
                // leave the prices out
            }
            return out
        }
        try {
            val text = get(PRICE_LIST)
            val names = when (provider) {
                "gemini" -> listOf("gemini/$model", model)
                "deepseek" -> listOf("deepseek/$model", model)
                else -> listOf(model)
            }
            for (name in names) {
                val entry = entry(text, name) ?: continue
                val pin = entry.optDouble("input_cost_per_token", Double.NaN)
                val pout = entry.optDouble("output_cost_per_token", Double.NaN)
                if (!pin.isNaN() && !pout.isNaN()) {
                    out.put("in", pin * 1_000_000).put("out", pout * 1_000_000)
                    break
                }
            }
        } catch (e: Exception) {
            // leave the prices out
        }
        return out
    }

    /** Pulls one model's object out of the (large) price list without parsing all of it. */
    private fun entry(text: String, name: String): JSONObject? {
        val start = text.indexOf("\"$name\": {")
        if (start < 0) return null
        val open = text.indexOf('{', start)
        var depth = 0
        var i = open
        while (i < text.length) {
            when (text[i]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) {
                        return try {
                            JSONObject(text.substring(open, i + 1))
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
            }
            i++
        }
        return null
    }

    /** The DeepSeek account balance right now: {amount, currency}. */
    fun deepseekBalance(key: String): JSONObject {
        val json = JSONObject(get("https://api.deepseek.com/user/balance", mapOf("Authorization" to "Bearer $key")))
        val infos = json.getJSONArray("balance_infos")
        var best = infos.getJSONObject(0)
        for (i in 0 until infos.length()) {
            val info = infos.getJSONObject(i)
            if ((info.optString("total_balance").toDoubleOrNull() ?: 0.0) > 0.0) {
                best = info
                break
            }
        }
        return JSONObject()
            .put("amount", best.optString("total_balance").toDoubleOrNull() ?: 0.0)
            .put("currency", best.optString("currency", "USD"))
    }
}

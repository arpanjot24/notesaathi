package app.notesaathi

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/** The source pages (photos or PDF pages) waiting to be turned into notes, kept as JPEG files. */
class Pages(private val ctx: Context) {

    private val dir = File(ctx.filesDir, "pages").apply { mkdirs() }
    private var seq = 0

    fun list(): List<File> =
        (dir.listFiles() ?: emptyArray()).filter { it.name.endsWith(".jpg") }.sortedBy { it.name }

    fun count(): Int = list().size

    fun file(index: Int): File = list()[index]

    fun clear() {
        list().forEach { it.delete() }
    }

    fun remove(index: Int) {
        list().getOrNull(index)?.delete()
    }

    @Synchronized
    private fun save(bmp: Bitmap) {
        seq = (seq + 1) % 10000
        val f = File(dir, "p%013d_%04d.jpg".format(System.currentTimeMillis(), seq))
        FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 88, it) }
        bmp.recycle()
    }

    fun addImageUri(uri: Uri) {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("Could not open that picture.")
        addImageBytes(bytes)
    }

    fun addImageBytes(bytes: ByteArray) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalStateException("That file is not a picture I can open.")
        }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            ?: throw IllegalStateException("That file is not a picture I can open.")

        val orientation = try {
            ExifInterface(ByteArrayInputStream(bytes))
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val degrees = when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(bmp.width, bmp.height))
        if (degrees != 0f || scale < 1f) {
            val m = Matrix()
            m.postScale(scale, scale)
            m.postRotate(degrees)
            val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (out !== bmp) bmp.recycle()
            bmp = out
        }
        save(bmp)
    }

    /** Renders each PDF page to a picture. Returns the total page count of the PDF. */
    fun addPdf(uri: Uri, onPage: (Int, Int) -> Unit = { _, _ -> }): Int {
        val pfd = ctx.contentResolver.openFileDescriptor(uri, "r")
            ?: throw IllegalStateException("Could not open that PDF.")
        return pfd.use { fd ->
            val renderer = try {
                PdfRenderer(fd)
            } catch (e: SecurityException) {
                throw IllegalStateException("That PDF is password-protected. Remove the password and try again.")
            } catch (e: Exception) {
                throw IllegalStateException("That PDF could not be opened. It may be damaged.")
            }
            renderer.use { r ->
                val total = r.pageCount
                for (i in 0 until minOf(total, MAX_PDF_PAGES)) {
                    val page = r.openPage(i)
                    val scale = MAX_SIDE.toFloat() / maxOf(page.width, page.height)
                    val w = maxOf(1, (page.width * scale).toInt())
                    val h = maxOf(1, (page.height * scale).toInt())
                    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(Color.WHITE)
                    page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
                    page.close()
                    save(bmp)
                    onPage(i + 1, total)
                }
                total
            }
        }
    }

    fun thumb(index: Int): String {
        val f = list().getOrNull(index) ?: return ""
        val opts = BitmapFactory.Options().apply { inSampleSize = 8 }
        val bmp = BitmapFactory.decodeFile(f.absolutePath, opts) ?: return ""
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, out)
        bmp.recycle()
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        const val MAX_SIDE = 1800
        const val MAX_PDF_PAGES = 1000
    }
}

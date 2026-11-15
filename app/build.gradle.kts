plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The build number comes from the GitHub Actions run, so every release is newer than the last.
val buildNumber = (System.getenv("VERSION_CODE") ?: "1").toInt()
val updateRepo = System.getenv("GITHUB_REPOSITORY") ?: "arpanjot24/notesaathi"
val keystorePath: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "app.notesaathi"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.notesaathi"
        minSdk = 24
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        buildConfigField("String", "UPDATE_REPO", "\"$updateRepo\"")
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = "notesaathi"
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    // One APK per processor type keeps the download small (x86_64 is only for the CI emulator).
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    // on-device reading and Hindi-to-English translation for the no-key mode
    implementation("com.google.mlkit:text-recognition-devanagari:16.0.1")
    implementation("com.google.mlkit:translate:17.0.3")
}

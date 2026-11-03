plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signatur: Schlüssel kommt im GitHub-Actions-Lauf aus den Secrets (siehe android/README.md).
// Ohne Schlüssel wird nur eine Debug-Version gebaut.
val keystoreFile = System.getenv("GOAHEAD_KEYSTORE_FILE")
val keystorePassword = System.getenv("GOAHEAD_KEYSTORE_PASSWORD")

android {
    namespace = "de.goahead.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "de.goahead.app"
        minSdk = 29
        targetSdk = 34
        versionCode = (System.getenv("GOAHEAD_VERSION_CODE") ?: "1").toInt()
        versionName = "1." + (System.getenv("GOAHEAD_VERSION_CODE") ?: "0")
    }

    signingConfigs {
        if (keystoreFile != null && keystorePassword != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storeType = "JKS"   // JKS, RSA 2048, SHA256withRSA – so wie es bei einer früheren App verlässlich funktioniert hat
                storePassword = keystorePassword
                keyAlias = "goahead"
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreFile != null && keystorePassword != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
}

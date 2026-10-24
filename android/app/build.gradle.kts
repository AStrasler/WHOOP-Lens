plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "io.github.astrasler.whooplens"
  compileSdk = 36

  defaultConfig {
    applicationId = "io.github.astrasler.whooplens"
    minSdk = 34
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  signingConfigs {
    create("release") {
      val keystorePath = System.getenv("KEYSTORE_PATH") ?: project.findProperty("KEYSTORE_PATH") as? String
      val keystorePassword = System.getenv("KEYSTORE_PASSWORD") ?: project.findProperty("KEYSTORE_PASSWORD") as? String
      val keyAliasVal = System.getenv("KEY_ALIAS") ?: project.findProperty("KEY_ALIAS") as? String
      val keyPasswordVal = System.getenv("KEY_PASSWORD") ?: project.findProperty("KEY_PASSWORD") as? String

      if (!keystorePath.isNullOrBlank() && file(keystorePath).exists()) {
        storeFile = file(keystorePath)
        storePassword = keystorePassword
        keyAlias = keyAliasVal
        keyPassword = keyPasswordVal
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      val releaseSigning = signingConfigs.getByName("release")
      if (releaseSigning.storeFile != null) {
        signingConfig = releaseSigning
      }
    }
    debug {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  lint {
    abortOnError = true
    checkDependencies = true
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.16.0")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("androidx.health.connect:connect-client:1.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20240303")
}

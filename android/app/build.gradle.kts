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
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation("androidx.core:core-ktx:1.16.0")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("androidx.health.connect:connect-client:1.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}

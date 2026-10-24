# Proguard / R8 rules for WHOOP Lens Companion

# Keep Health Connect Client and Records
-keep class androidx.health.connect.client.** { *; }
-keep class androidx.health.connect.client.records.** { *; }

# Keep data models serialized to JSON
-keepclassmembers class io.github.astrasler.whooplens.ReviewedSteps { *; }

# Keep Kotlin Coroutines
-keep class kotlinx.coroutines.** { *; }

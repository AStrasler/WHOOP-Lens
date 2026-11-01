package io.github.astrasler.whooplens
import org.junit.Assert.*
import org.junit.Test

class ChartLayoutTest {
    @Test fun clusteredSamplesCannotForceCollidingLabels() {
        val labels=collisionFreeAxisLabels(listOf(AxisCandidate("08:00",16f,70f),AxisCandidate("08:01",20f,70f),AxisCandidate("19:00",300f,70f)),16f,300f,8f)
        assertEquals(listOf("08:00","19:00"),labels.map { it.text })
        assertTrue(labels[0].left+labels[0].width+8 <= labels[1].left)
    }
    @Test fun normalAndEnlargedFontsStayInsidePlotBounds() {
        for (width in listOf(180f,300f,420f)) for (scale in listOf(1f,1.5f,2f)) {
            val labels=collisionFreeAxisLabels(listOf(AxisCandidate("Oct 1",16f,50f*scale),AxisCandidate("Oct 15",width/2,60f*scale),AxisCandidate("Oct 30",width-16,60f*scale)),16f,width-16,8f)
            labels.forEach { assertTrue(it.left >= 16f && it.left+it.width <= width-16) }
            labels.zipWithNext().forEach { (a,b) -> assertTrue(a.left+a.width+8 <= b.left) }
        }
    }
    @Test fun duplicatesSinglePointsAndImpossibleBoundsDoNotClip() {
        assertEquals(1,collisionFreeAxisLabels(listOf(AxisCandidate("09:00",100f,60f),AxisCandidate("09:00",110f,60f)),0f,200f,8f).size)
        assertTrue(collisionFreeAxisLabels(listOf(AxisCandidate("09:00",0f,100f)),0f,20f,8f).isEmpty())
        assertTrue(collisionFreeAxisLabels(emptyList(),0f,0f,8f).isEmpty())
        assertTrue(chartHeightDp(2f)>chartHeightDp(1f))
    }
}

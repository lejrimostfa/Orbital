<script setup lang="ts">
/**
 * Canvas-based velocity profile graph.
 * Shows average |v| vs radial distance from center.
 * Positioned bottom-right of the screen.
 */
import { ref, watch, onMounted } from 'vue'

const props = defineProps<{
  profile: Float32Array
  planeX: number
  planeY: number
  planeZ: number
  planeThickness: number
  planeRadius: number
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null

const W = 400
const H = 220
const PAD = { top: 24, right: 20, bottom: 30, left: 50 }

let lastDrawTime = 0
const DRAW_INTERVAL = 1000 // 1 second throttle

function draw(): void {
  const now = performance.now()
  if (now - lastDrawTime < DRAW_INTERVAL) return
  lastDrawTime = now

  if (!ctx || !props.profile || props.profile.length < 4) return

  const data = props.profile
  const nBins = data.length / 2

  ctx.clearRect(0, 0, W, H)

  // Background
  ctx.fillStyle = 'rgba(10, 10, 30, 0.88)'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = 'rgba(100, 120, 255, 0.15)'
  ctx.lineWidth = 1
  ctx.strokeRect(0, 0, W, H)

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  // Find ranges
  let maxR = 0, maxV = 0
  for (let i = 0; i < nBins; i++) {
    const r = data[i * 2]
    const v = data[i * 2 + 1]
    if (r > maxR) maxR = r
    if (v > maxV) maxV = v
  }
  if (maxR < 1e-6 || maxV < 1e-6) return
  maxV *= 1.2 // add margin

  // Grid lines
  ctx.strokeStyle = 'rgba(80, 90, 140, 0.15)'
  ctx.lineWidth = 0.5
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + plotH * (1 - i / 4)
    ctx.beginPath()
    ctx.moveTo(PAD.left, y)
    ctx.lineTo(PAD.left + plotW, y)
    ctx.stroke()
  }

  // Axes labels
  ctx.fillStyle = '#5560a0'
  ctx.font = '9px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('R (display units)', PAD.left + plotW / 2, H - 3)
  ctx.save()
  ctx.translate(10, PAD.top + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('|v|', 0, 0)
  ctx.restore()

  // Title + plane info
  ctx.fillStyle = '#7080c0'
  ctx.font = 'bold 10px monospace'
  ctx.textAlign = 'left'
  ctx.fillText('VELOCITY PROFILE', PAD.left, 14)
  ctx.fillStyle = '#4560a0'
  ctx.font = '9px monospace'
  const ctr = `(${props.planeX.toFixed(1)},${props.planeY.toFixed(1)},${props.planeZ.toFixed(1)})`
  ctx.fillText(`cyl ${ctr} r=${props.planeRadius.toFixed(1)} \u00B1${props.planeThickness.toFixed(1)}`, PAD.left + 140, 14)

  // Y-axis tick labels
  ctx.fillStyle = '#5570b0'
  ctx.font = '9px monospace'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + plotH * (1 - i / 4)
    const val = (maxV * i / 4).toFixed(1)
    ctx.fillText(val, PAD.left - 4, y + 3)
  }

  // Draw curve
  ctx.beginPath()
  ctx.strokeStyle = '#6090ff'
  ctx.lineWidth = 2.5
  ctx.lineJoin = 'round'
  for (let i = 0; i < nBins; i++) {
    const r = data[i * 2]
    const v = data[i * 2 + 1]
    const x = PAD.left + (r / maxR) * plotW
    const y = PAD.top + plotH * (1 - v / maxV)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Dots
  ctx.fillStyle = '#90c0ff'
  for (let i = 0; i < nBins; i++) {
    const r = data[i * 2]
    const v = data[i * 2 + 1]
    if (v < 1e-6) continue
    const x = PAD.left + (r / maxR) * plotW
    const y = PAD.top + plotH * (1 - v / maxV)
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  // Star count in slab
  let nStars = 0
  for (let i = 0; i < nBins; i++) {
    if (data[i * 2 + 1] > 1e-6) nStars++
  }
  ctx.fillStyle = '#4560a0'
  ctx.font = '9px monospace'
  ctx.textAlign = 'right'
  ctx.fillText(`${nBins} bins`, W - PAD.right, 14)
}

watch(() => props.profile, draw)

onMounted(() => {
  if (canvas.value) {
    ctx = canvas.value.getContext('2d')
    // Set canvas resolution for crisp rendering
    canvas.value.width = W * 2
    canvas.value.height = H * 2
    ctx?.scale(2, 2)
    draw()
  }
})
</script>

<template>
  <div class="velocity-graph">
    <canvas ref="canvas" :style="{ width: W + 'px', height: H + 'px' }" />
  </div>
</template>

<style scoped>
.velocity-graph {
  position: absolute;
  bottom: 16px;
  right: 16px;
  border-radius: 8px;
  overflow: hidden;
  z-index: 100;
  pointer-events: none;
}
canvas {
  display: block;
}
</style>

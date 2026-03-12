<script setup lang="ts">
/**
 * Main simulation view component.
 * Hosts the Three.js canvas, control panel, and velocity graph.
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useSimulation } from '../simulation/useSimulation'
import ControlPanel from './ControlPanel.vue'
import VelocityGraph from './VelocityGraph.vue'

const canvasContainer = ref<HTMLElement | null>(null)

// ─── Video recording ──────────────────────────────────────────────────
const isRecording = ref(false)
const recordingTime = ref(0)
let mediaRecorder: MediaRecorder | null = null
let recordedChunks: Blob[] = []
let recordingTimer: ReturnType<typeof setInterval> | null = null

function toggleRecording(): void {
  if (isRecording.value) {
    stopRecording()
  } else {
    startRecording()
  }
}

function startRecording(): void {
  const canvas = canvasContainer.value?.querySelector('canvas')
  if (!canvas) return

  recordedChunks = []
  recordingTime.value = 0

  const stream = canvas.captureStream(60)
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 8_000_000,
  })

  mediaRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) recordedChunks.push(e.data)
  }

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `orbital-${date}.webm`
    a.click()
    URL.revokeObjectURL(url)
    recordedChunks = []
  }

  mediaRecorder.start(100)
  isRecording.value = true
  recordingTimer = setInterval(() => { recordingTime.value++ }, 1000)
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  mediaRecorder = null
  isRecording.value = false
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
}

onUnmounted(() => { if (isRecording.value) stopRecording() })

const {
  config,
  isRunning,
  isReady,
  fps,
  stepTime,
  simTime,
  velocityProfile,
  trackedParticle,
  trackedInfo,
  isFollowing,
  init,
  togglePlayPause,
  restart,
  updateConfig,
  resetView,
  singleStep,
} = useSimulation()

onMounted(() => {
  if (canvasContainer.value) {
    init(canvasContainer.value)
  }
})
function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="simulation-container">
    <div ref="canvasContainer" class="canvas-container" />
    <!-- Record button -->
    <button
      class="record-btn"
      :class="{ recording: isRecording }"
      @click="toggleRecording"
      :title="isRecording ? 'Stop recording' : 'Record video'"
    >
      <span class="record-icon" />
      <span v-if="isRecording" class="record-time">{{ formatTime(recordingTime) }}</span>
    </button>
    <ControlPanel
      :config="config"
      :isRunning="isRunning"
      :isReady="isReady"
      :fps="fps"
      :stepTime="stepTime"
      :simTime="simTime"
      :trackedParticle="trackedParticle"
      :trackedInfo="trackedInfo"
      :isFollowing="isFollowing"
      @toggle-play-pause="togglePlayPause"
      @restart="restart"
      @update-config="updateConfig"
      @single-step="singleStep"
      @reset-view="resetView"
    />
    <VelocityGraph
      :profile="velocityProfile"
      :planeX="config.measurePlaneX"
      :planeY="config.measurePlaneY"
      :planeZ="config.measurePlaneZ"
      :planeThickness="config.measurePlaneThickness"
      :planeRadius="config.measurePlaneRadius"
    />
  </div>
</template>

<style scoped>
.simulation-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #050510;
}

.canvas-container {
  width: 100%;
  height: 100%;
}

.record-btn {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 24px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.2s;
  z-index: 100;
}
.record-btn:hover {
  background: rgba(0, 0, 0, 0.8);
  border-color: rgba(255, 255, 255, 0.3);
}
.record-btn.recording {
  border-color: #e33;
  background: rgba(40, 0, 0, 0.7);
}

.record-icon {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #e33;
  display: inline-block;
  transition: all 0.2s;
}
.record-btn.recording .record-icon {
  border-radius: 3px;
  background: #e33;
  animation: pulse-rec 1s infinite;
}

.record-time {
  color: #e33;
  font-size: 13px;
  font-family: monospace;
  font-weight: bold;
}

@keyframes pulse-rec {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>

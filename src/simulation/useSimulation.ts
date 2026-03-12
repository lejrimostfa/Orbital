/**
 * Vue composable that bridges the N-body Web Worker with the Three.js renderer.
 *
 * Events flow:
 * UI (Vue) -> useSimulation -> Worker (physics) -> useSimulation -> SceneManager (render)
 *
 * New features:
 *   - Velocity profile data forwarding
 *   - Particle click → trajectory tracking
 *   - Supernova flash events
 *   - Grid toggle
 *   - Simulation time tracking
 */

import { ref, shallowRef, onUnmounted } from 'vue'
import type { SimulationConfig, WorkerResponse } from './types'
import { DEFAULT_CONFIG } from './types'
import { SceneManager } from '../renderer/SceneManager'

import NBodyWorker from '../workers/nbody.worker?worker'

export function useSimulation() {
  const config = ref<SimulationConfig>({ ...DEFAULT_CONFIG })
  const isRunning = ref(false)
  const isReady = ref(false)
  const fps = ref(0)
  const stepTime = ref(0)
  const simTime = ref(0)
  const velocityProfile = shallowRef<Float32Array>(new Float32Array(0))
  const trackedParticle = ref(-1)
  const isFollowing = ref(false)
  const trackedInfo = ref<{ velocity: number; mass: number; age: number; ptype: number } | null>(null)

  const sceneManager = shallowRef<SceneManager | null>(null)
  let worker: Worker | null = null

  function handleWorkerMessage(e: MessageEvent<WorkerResponse>): void {
    const msg = e.data

    switch (msg.type) {
      case 'ready':
        isReady.value = true
        // Don't auto-play: worker auto-starts its loop after init,
        // so send pause immediately. User must click Play to resume.
        if (worker) {
          worker.postMessage({ type: 'pause' })
        }
        isRunning.value = false
        break

      case 'state':
        if (sceneManager.value) {
          sceneManager.value.updateParticles(
            msg.positions,
            msg.velocities,
            msg.masses,
            msg.types,
            msg.count,
            msg.stepTime,
          )
        }
        simTime.value = msg.simTime
        velocityProfile.value = msg.velocityProfile
        trackedInfo.value = msg.trackedInfo ?? null

        // Auto-track densest mass center: update cylinder + DM halo position
        if (msg.barycenter && config.value.measurePlaneAutoTrack && sceneManager.value) {
          const s = config.value.displayScale
          config.value.measurePlaneX = msg.barycenter.x
          config.value.measurePlaneY = msg.barycenter.y
          config.value.measurePlaneZ = msg.barycenter.z
          sceneManager.value.setMeasurePlanePosition(
            msg.barycenter.x * s,
            msg.barycenter.y * s,
            msg.barycenter.z * s,
          )
          if (config.value.darkMatterEnabled) {
            sceneManager.value.setDmHaloPosition(
              msg.barycenter.x * s,
              msg.barycenter.y * s,
              msg.barycenter.z * s,
            )
          }
        }
        break

      case 'trajectory':
        if (sceneManager.value && msg.positions.length >= 6) {
          sceneManager.value.updateTrajectory(msg.positions, msg.speeds)
        }
        break

      case 'supernova':
        if (sceneManager.value) {
          sceneManager.value.addSupernovaFlash(msg.x, msg.y, msg.z, msg.mass)
        }
        break

      case 'error':
        console.error('[Simulation Worker]', msg.message)
        break
    }
  }

  function handleParticleClick(index: number): void {
    if (!worker) return

    if (index < 0) {
      // Clear trajectory and exit follow
      trackedParticle.value = -1
      isFollowing.value = false
      trackedInfo.value = null
      if (sceneManager.value) {
        sceneManager.value.clearTrajectory()
        sceneManager.value.stopFollow()
      }
      worker.postMessage({ type: 'getTrajectory', particleIndex: -1 })
    } else {
      trackedParticle.value = index
      worker.postMessage({ type: 'getTrajectory', particleIndex: index })
      // If already following, switch follow to the new particle
      if (isFollowing.value && sceneManager.value) {
        sceneManager.value.startFollow(index)
      }
    }
  }

  function handleFollowChange(following: boolean): void {
    if (following && trackedParticle.value >= 0 && sceneManager.value) {
      sceneManager.value.startFollow(trackedParticle.value)
      isFollowing.value = true
    } else {
      isFollowing.value = false
    }
  }

  function init(container: HTMLElement): void {
    sceneManager.value = new SceneManager({
      container,
      maxParticles: 15000,
      onFpsUpdate: (f) => { fps.value = f },
      onStepTime: (ms) => { stepTime.value = ms },
      onParticleClick: handleParticleClick,
      onFollowChange: handleFollowChange,
      onPlayPause: togglePlayPause,
    })

    worker = new NBodyWorker()
    worker.onmessage = handleWorkerMessage
    worker.onerror = (err) => console.error('[Worker Error]', err)

    worker.postMessage({ type: 'init', config: { ...config.value } })
  }

  function pause(): void {
    if (worker && isRunning.value) {
      worker.postMessage({ type: 'pause' })
      isRunning.value = false
    }
  }

  function resume(): void {
    if (worker && !isRunning.value && isReady.value) {
      worker.postMessage({ type: 'resume' })
      isRunning.value = true
    }
  }

  function togglePlayPause(): void {
    if (isRunning.value) pause()
    else resume()
  }

  function restart(newConfig?: Partial<SimulationConfig>): void {
    if (newConfig) {
      Object.assign(config.value, newConfig)
    }
    trackedParticle.value = -1
    isFollowing.value = false
    if (sceneManager.value) {
      sceneManager.value.clearTrajectory()
      sceneManager.value.stopFollow()
    }
    if (worker) {
      isReady.value = false
      isRunning.value = false
      worker.postMessage({ type: 'init', config: { ...config.value } })
    }
  }

  function updateConfig(partial: Partial<SimulationConfig>): void {
    // Only auto-pause for display/non-physics toggles that don't need it
    const displayOnlyKeys = new Set([
      'showGrid', 'gridSolid', 'showMeasurePlane', 'measurePlaneAutoTrack',
      'measurePlaneX', 'measurePlaneY', 'measurePlaneZ',
      'measurePlaneRadius', 'measurePlaneThickness',
      'darkMatterEnabled', 'dmHaloMass', 'dmScaleRadius', 'dmConcentration', 'dmHaloVisible',
    ])
    const isDisplayOnly = Object.keys(partial).every(k => displayOnlyKeys.has(k))
    if (isRunning.value && !isDisplayOnly) pause()

    Object.assign(config.value, partial)
    if (worker) {
      worker.postMessage({ type: 'updateConfig', config: { ...partial } })
    }
    // Immediate renderer-side updates
    if (partial.showGrid !== undefined && sceneManager.value) {
      sceneManager.value.setGridVisible(partial.showGrid)
    }
    if (partial.gridSolid !== undefined && sceneManager.value) {
      sceneManager.value.setGridSolid(partial.gridSolid)
    }
    if (partial.showMeasurePlane !== undefined && sceneManager.value) {
      sceneManager.value.setMeasurePlaneVisible(partial.showMeasurePlane)
    }
    // Update measure plane position if any position axis changed
    if ((partial.measurePlaneX !== undefined || partial.measurePlaneY !== undefined || partial.measurePlaneZ !== undefined) && sceneManager.value) {
      const s = config.value.displayScale
      sceneManager.value.setMeasurePlanePosition(
        config.value.measurePlaneX * s,
        config.value.measurePlaneY * s,
        config.value.measurePlaneZ * s,
      )
    }
    // Update measure plane geometry if radius or thickness changed
    if ((partial.measurePlaneRadius !== undefined || partial.measurePlaneThickness !== undefined) && sceneManager.value) {
      sceneManager.value.setMeasurePlaneGeometry(config.value.measurePlaneRadius, config.value.measurePlaneThickness, config.value.displayScale)
    }
    // Dark matter halo visualization
    if (partial.darkMatterEnabled !== undefined && sceneManager.value) {
      if (partial.darkMatterEnabled) {
        sceneManager.value.updateDmHalo(config.value.dmScaleRadius, config.value.dmConcentration, config.value.displayScale)
        sceneManager.value.setDmHaloVisible(true)
      } else {
        sceneManager.value.setDmHaloVisible(false)
      }
    }
    if ((partial.dmScaleRadius !== undefined || partial.dmConcentration !== undefined) && sceneManager.value && config.value.darkMatterEnabled) {
      sceneManager.value.updateDmHalo(config.value.dmScaleRadius, config.value.dmConcentration, config.value.displayScale)
    }
    // DM halo visibility toggle (display only, no physics impact)
    if ((partial as any).dmHaloVisible !== undefined && sceneManager.value) {
      sceneManager.value.setDmHaloVisible((partial as any).dmHaloVisible && config.value.darkMatterEnabled)
    }
  }

  function resetView(): void {
    if (sceneManager.value) {
      sceneManager.value.resetView()
      isFollowing.value = false
    }
  }

  function singleStep(): void {
    if (worker && !isRunning.value) {
      worker.postMessage({ type: 'step' })
    }
  }

  function dispose(): void {
    if (worker) { worker.terminate(); worker = null }
    if (sceneManager.value) { sceneManager.value.dispose(); sceneManager.value = null }
  }

  onUnmounted(dispose)

  return {
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
    pause,
    resume,
    togglePlayPause,
    restart,
    updateConfig,
    resetView,
    singleStep,
    dispose,
  }
}

/**
 * Three.js scene manager for N-body visualization.
 *
 * Features:
 *   - Custom GLSL shaders: mass→spectral color, BH dark core + accretion ring, SMBH glow
 *   - Click-to-select particle → trajectory polyline
 *   - Supernova flash effect
 *   - Grid toggle
 *   - Velocity profile data forwarding
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'

// ParticleType values (mirrors const enum)
const STAR = 0
const BLACK_HOLE = 1
const SMBH = 2

export interface SceneManagerOptions {
  container: HTMLElement
  maxParticles: number
  onFpsUpdate?: (fps: number) => void
  onStepTime?: (ms: number) => void
  onParticleClick?: (index: number) => void
  onFollowChange?: (following: boolean) => void
  onPlayPause?: () => void
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

const vertexShader = `
  attribute float aSpeed;
  attribute float aMass;
  attribute float aType;
  varying float vSpeed;
  varying float vMass;
  varying float vType;
  varying float vInflation;   // how much we enlarged vs natural size (>=1)
  varying float vCamDist;     // camera distance for LOD blending

  void main() {
    vSpeed = aSpeed;
    vMass = aMass;
    vType = aType;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float negZ = -mvPosition.z;
    vCamDist = negZ;

    float logMass = log(aMass * 10000.0 + 1.0);
    // Smooth perspective scaling: 260 / sqrt(z² + 9) gives standard 1/z at distance
    // but softly caps at 260/3 ≈ 87 when very close. No discontinuities.
    float perspScale = 260.0 / sqrt(negZ * negZ + 9.0);
    float naturalSize = (2.5 + logMass * 1.6) * perspScale;

    // SMBH: large
    if (aType > 1.5) {
      naturalSize *= 4.0;
    }
    // Stellar BH: medium dark point
    else if (aType > 0.5) {
      naturalSize = max(naturalSize * 1.8, 3.0 * perspScale);
    }

    // ─── Gaussian splatting: minimum size floor + inflation tracking ──
    // When zoomed out, particles shrink below MIN_SIZE → clamp up.
    // Fragment shader uses vInflation to widen the gaussian sigma and
    // dim peak alpha (luminosity conservation). Additive blending of
    // many overlapping soft gaussians creates natural nebular glow.
    float MIN_SIZE = 8.0;
    float MAX_SIZE = 80.0;
    float finalSize = max(naturalSize, MIN_SIZE);

    // Inflation ratio: 1.0 = natural, >1 = enlarged for visibility
    vInflation = finalSize / max(naturalSize, 0.1);

    gl_PointSize = clamp(finalSize, MIN_SIZE, MAX_SIZE);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = `
  varying float vSpeed;
  varying float vMass;
  varying float vType;
  varying float vInflation;
  varying float vCamDist;

  void main() {
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);
    if (dist > 0.5) discard;

    // ─── Gaussian splat profile ─────────────────────────────────────
    // sigma adapts: natural size → tight core (star), inflated → wide (nebula)
    // Near: sigma ~0.12 (sharp star), Far/inflated: sigma ~0.35 (soft cloud)
    float sigmaBase = 0.12;
    float sigmaFar  = 0.35;
    float infT = clamp((vInflation - 1.0) / 3.0, 0.0, 1.0);
    float sigma = mix(sigmaBase, sigmaFar, infT);
    float gauss = exp(-dist * dist / (2.0 * sigma * sigma));

    // Luminosity conservation: inflated particles get dimmer peak alpha
    // so total integrated light ~constant. Gentle decay so that even at
    // extreme zoom, overlapping gaussian tails accumulate into visible glow.
    float infMinus1 = max(vInflation - 1.0, 0.0);
    float alphaScale = 1.0 / (1.0 + infMinus1 * infMinus1 * 0.08);
    // Minimum alpha floor: ensures far particles always contribute some glow
    alphaScale = max(alphaScale, 0.15);

    // ─── SMBH: accretion disk effect ────────────────────────────────
    if (vType > 1.5) {
      float coreAlpha = smoothstep(0.0, 0.12, dist);
      float ring = exp(-pow((dist - 0.28) * 8.0, 2.0));
      float glow = exp(-dist * 4.0) * 0.4;

      vec3 ringColor = mix(vec3(1.0, 0.7, 0.2), vec3(0.8, 0.9, 1.0), ring);
      vec3 color = ringColor * (ring * 2.0 + glow);
      color *= coreAlpha;
      color += vec3(0.3, 0.2, 0.5) * exp(-dist * 3.0) * 0.3;

      float a = (ring * 0.8 + glow + 0.2) * gauss;
      gl_FragColor = vec4(color, a);
      return;
    }

    // ─── Stellar Black Hole: dark core + faint red accretion ────────
    if (vType > 0.5) {
      float coreAlpha = smoothstep(0.0, 0.15, dist);
      float ring = exp(-pow((dist - 0.25) * 10.0, 2.0));
      float glow = exp(-dist * 6.0) * 0.2;

      vec3 color = vec3(0.8, 0.15, 0.05) * ring * 1.5;
      color += vec3(0.3, 0.05, 0.02) * glow;
      color *= coreAlpha;

      float a = (ring * 0.6 + glow + 0.1) * gauss * alphaScale;
      gl_FragColor = vec4(color, a);
      return;
    }

    // ─── Stars: spectral type from mass (HR diagram) ────────────────
    float logM = log2(vMass * 20000.0 + 1.0);
    float t = clamp((logM - 1.0) / 6.0, 0.0, 1.0);

    vec3 mType  = vec3(0.8, 0.2, 0.1);
    vec3 kType  = vec3(0.95, 0.5, 0.15);
    vec3 gType  = vec3(1.0, 0.9, 0.5);
    vec3 fType  = vec3(0.9, 0.92, 1.0);
    vec3 obType = vec3(0.6, 0.7, 1.0);

    vec3 color;
    if (t < 0.25) {
      color = mix(mType, kType, t * 4.0);
    } else if (t < 0.5) {
      color = mix(kType, gType, (t - 0.25) * 4.0);
    } else if (t < 0.75) {
      color = mix(gType, fType, (t - 0.5) * 4.0);
    } else {
      color = mix(fType, obType, (t - 0.75) * 4.0);
    }

    float speedBoost = 1.0 + clamp(vSpeed / 3.0, 0.0, 0.3);
    color *= speedBoost;

    // Soft inner glow (brighter near center)
    float innerGlow = exp(-dist * 5.0) * 0.15;
    color += innerGlow;

    // Final alpha: gaussian profile × luminosity conservation
    // Near: bright crisp star. Far: dim soft gaussian splat.
    // With additive blending, thousands of overlapping dim gaussians
    // accumulate into a visible diffuse nebular glow.
    float baseAlpha = gauss * alphaScale * 0.9;

    gl_FragColor = vec4(color, baseAlpha);
  }
`

// ─── SceneManager class ──────────────────────────────────────────────────────

export class SceneManager {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls
  private container: HTMLElement
  private maxParticles: number
  private animationId: number | null = null

  // Points system
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute
  private speedAttr: THREE.BufferAttribute
  private massAttr: THREE.BufferAttribute
  private typeAttr: THREE.BufferAttribute

  // Deformable gravity grid
  private gridMesh: THREE.LineSegments
  private gridSolidMesh: THREE.Mesh | null = null
  private gridPositionAttr!: THREE.BufferAttribute
  private gridBasePositions!: Float32Array
  private readonly GRID_RES = 16
  private readonly GRID_SIZE = 300
  private gridDeformFrame = 0
  private potentialMap: Float64Array = new Float64Array(0)
  private readonly POT_RES = 32

  // Trajectory trail (fat Line2 for zoom-independent visibility)
  private trajectoryLine: Line2 | null = null

  // Supernova flashes
  private supernovaFlashes: { mesh: THREE.Mesh; birth: number; duration: number }[] = []

  // Dark matter halo visualization
  private dmHaloMesh: THREE.Mesh | null = null

  // Velocity measurement plane (semi-transparent disc in 3D)
  private measurePlane: THREE.Mesh | null = null
  private measurePlaneEdge: THREE.LineLoop | null = null

  // Selection: double-click to select, right-click/Escape to deselect
  private onParticleClick?: (index: number) => void

  // FPS
  private frameCount = 0
  private lastFpsTime = 0
  private onFpsUpdate?: (fps: number) => void
  private onStepTime?: (ms: number) => void

  // Camera follow mode
  private followIndex = -1
  private onFollowChange?: (following: boolean) => void
  private onPlayPause?: () => void

  // Pending state
  private pendingPositions: Float32Array | null = null
  private pendingVelocities: Float32Array | null = null
  private pendingMasses: Float32Array | null = null
  private pendingTypes: Uint8Array | null = null
  private pendingCount = 0

  constructor(options: SceneManagerOptions) {
    this.container = options.container
    this.maxParticles = options.maxParticles
    this.onFpsUpdate = options.onFpsUpdate
    this.onStepTime = options.onStepTime
    this.onParticleClick = options.onParticleClick
    this.onFollowChange = options.onFollowChange
    this.onPlayPause = options.onPlayPause

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x020208)

    const aspect = this.container.clientWidth / this.container.clientHeight
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 20000)
    this.camera.position.set(0, 120, 220)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.minDistance = 0.1
    this.controls.maxDistance = 3000

    // Buffer attributes
    this.positionAttr = new THREE.BufferAttribute(new Float32Array(this.maxParticles * 3), 3)
    this.positionAttr.setUsage(THREE.DynamicDrawUsage)
    this.speedAttr = new THREE.BufferAttribute(new Float32Array(this.maxParticles), 1)
    this.speedAttr.setUsage(THREE.DynamicDrawUsage)
    this.massAttr = new THREE.BufferAttribute(new Float32Array(this.maxParticles), 1)
    this.massAttr.setUsage(THREE.DynamicDrawUsage)
    this.typeAttr = new THREE.BufferAttribute(new Float32Array(this.maxParticles), 1)
    this.typeAttr.setUsage(THREE.DynamicDrawUsage)

    this.createPoints()

    // Deformable gravity grid (spacetime curvature visualization)
    this.gridMesh = this.createDeformableGrid()
    this.scene.add(this.gridMesh)

    // Solid surface version of the grid
    this.gridSolidMesh = this.createSolidGrid()
    this.gridSolidMesh.visible = false
    this.scene.add(this.gridSolidMesh)

    // Measurement plane (semi-transparent disc showing where velocity is sampled)
    this.createMeasurePlane()

    // Double-click to select, long-press empty to deselect
    this.renderer.domElement.addEventListener('dblclick', this.onDoubleClick)
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKeyDown)

    this.lastFpsTime = performance.now()
    this.animate()
  }

  private createPoints(): void {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', this.positionAttr)
    geometry.setAttribute('aSpeed', this.speedAttr)
    geometry.setAttribute('aMass', this.massAttr)
    geometry.setAttribute('aType', this.typeAttr)

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.points = new THREE.Points(geometry, material)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  // ─── Measurement plane ─────────────────────────────────────────────────

  private createMeasurePlane(): void {
    this.rebuildMeasureCylinder(6.0, 0.5)
  }

  private measureDisplayScale = 30 // cached displayScale for cylinder geometry

  private rebuildMeasureCylinder(radius: number, halfThick: number): void {
    // Remove old meshes
    if (this.measurePlane) { this.scene.remove(this.measurePlane); this.measurePlane.geometry.dispose() }
    if (this.measurePlaneEdge) { this.scene.remove(this.measurePlaneEdge); this.measurePlaneEdge.geometry.dispose() }

    const s = this.measureDisplayScale
    const displayRadius = radius * s
    const displayHeight = Math.max(halfThick * 2 * s, 0.5)
    const segments = 48

    // Semi-transparent cylinder body
    const cylGeom = new THREE.CylinderGeometry(displayRadius, displayRadius, displayHeight, segments, 1, true)
    const cylMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.04,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    this.measurePlane = new THREE.Mesh(cylGeom, cylMat)
    this.measurePlane.position.set(0, 0, 0)
    this.scene.add(this.measurePlane)

    // Top + bottom edge rings
    const ringPts: THREE.Vector3[] = []
    const halfH = displayHeight / 2
    // Top ring
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      ringPts.push(new THREE.Vector3(Math.cos(a) * displayRadius, halfH, Math.sin(a) * displayRadius))
    }
    // Break (NaN jump) then bottom ring
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      ringPts.push(new THREE.Vector3(Math.cos(a) * displayRadius, -halfH, Math.sin(a) * displayRadius))
    }
    const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts)
    const ringMat = new THREE.LineBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.3,
    })
    this.measurePlaneEdge = new THREE.LineLoop(ringGeom, ringMat)
    this.measurePlaneEdge.position.set(0, 0, 0)
    this.scene.add(this.measurePlaneEdge)
  }

  setMeasurePlaneVisible(visible: boolean): void {
    if (this.measurePlane) this.measurePlane.visible = visible
    if (this.measurePlaneEdge) this.measurePlaneEdge.visible = visible
  }

  setMeasurePlanePosition(x: number, y: number, z: number): void {
    if (this.measurePlane) this.measurePlane.position.set(x, y, z)
    if (this.measurePlaneEdge) this.measurePlaneEdge.position.set(x, y, z)
  }

  setMeasurePlaneY(y: number): void {
    if (this.measurePlane) this.measurePlane.position.y = y
    if (this.measurePlaneEdge) this.measurePlaneEdge.position.y = y
  }

  setMeasurePlaneGeometry(radius: number, halfThick: number, displayScale?: number): void {
    if (displayScale !== undefined) this.measureDisplayScale = displayScale
    const wasVisible = this.measurePlane?.visible ?? true
    const pos = this.measurePlane?.position.clone() ?? new THREE.Vector3()
    this.rebuildMeasureCylinder(radius, halfThick)
    if (this.measurePlane) { this.measurePlane.position.copy(pos); this.measurePlane.visible = wasVisible }
    if (this.measurePlaneEdge) { this.measurePlaneEdge.position.copy(pos); this.measurePlaneEdge.visible = wasVisible }
  }

  // ─── Dark Matter halo visualization ─────────────────────────────────────

  private createDmHalo(scaleRadius: number, concentration: number, displayScale: number): void {
    if (this.dmHaloMesh) {
      this.scene.remove(this.dmHaloMesh)
      this.dmHaloMesh.geometry.dispose()
      ;(this.dmHaloMesh.material as THREE.Material).dispose()
    }

    const rVir = scaleRadius * concentration * displayScale
    const geometry = new THREE.SphereGeometry(rVir, 48, 48)

    // Simple semi-transparent sphere with radial fade
    const material = new THREE.MeshBasicMaterial({
      color: 0x7755cc,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      side: THREE.BackSide,
    })

    this.dmHaloMesh = new THREE.Mesh(geometry, material)
    this.dmHaloMesh.frustumCulled = false
    this.dmHaloMesh.renderOrder = -1
    this.scene.add(this.dmHaloMesh)

    // Add inner shells for density gradient (denser at center)
    const shellRadii = [0.15, 0.35, 0.6]
    for (const frac of shellRadii) {
      const shellGeom = new THREE.SphereGeometry(rVir * frac, 32, 32)
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0x8866dd,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.BackSide,
      })
      const shell = new THREE.Mesh(shellGeom, shellMat)
      this.dmHaloMesh.add(shell)
    }
  }

  setDmHaloVisible(visible: boolean): void {
    if (this.dmHaloMesh) this.dmHaloMesh.visible = visible
  }

  setDmHaloPosition(x: number, y: number, z: number): void {
    if (this.dmHaloMesh) this.dmHaloMesh.position.set(x, y, z)
  }

  updateDmHalo(scaleRadius: number, concentration: number, displayScale: number): void {
    this.createDmHalo(scaleRadius, concentration, displayScale)
  }

  // ─── Grid toggle ────────────────────────────────────────────────────────

  private gridIsSolid = false

  setGridVisible(visible: boolean): void {
    if (visible) {
      this.gridMesh.visible = !this.gridIsSolid
      if (this.gridSolidMesh) this.gridSolidMesh.visible = this.gridIsSolid
    } else {
      this.gridMesh.visible = false
      if (this.gridSolidMesh) this.gridSolidMesh.visible = false
    }
  }

  // ─── Deformable gravity grid ──────────────────────────────────────────

  private createDeformableGrid(): THREE.LineSegments {
    const res = this.GRID_RES
    const size = this.GRID_SIZE
    const half = size / 2

    // Build line segments for a grid: horizontal + vertical lines
    const positions: number[] = []

    for (let i = 0; i <= res; i++) {
      const t = (i / res) * size - half
      // Row line (along X)
      for (let j = 0; j < res; j++) {
        const x0 = (j / res) * size - half
        const x1 = ((j + 1) / res) * size - half
        positions.push(x0, 0, t, x1, 0, t)
      }
      // Column line (along Z)
      for (let j = 0; j < res; j++) {
        const z0 = (j / res) * size - half
        const z1 = ((j + 1) / res) * size - half
        positions.push(t, 0, z0, t, 0, z1)
      }
    }

    const geometry = new THREE.BufferGeometry()
    const posArray = new Float32Array(positions)
    this.gridPositionAttr = new THREE.BufferAttribute(posArray, 3)
    this.gridPositionAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', this.gridPositionAttr)

    // Store base positions (flat grid) for reset
    this.gridBasePositions = new Float32Array(posArray)

    const material = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.12,
    })

    const mesh = new THREE.LineSegments(geometry, material)
    mesh.position.y = -0.5
    mesh.frustumCulled = false // dynamic geometry — don't cull
    return mesh
  }

  private createSolidGrid(): THREE.Mesh {
    const res = this.GRID_RES
    const size = this.GRID_SIZE
    const geometry = new THREE.PlaneGeometry(size, size, res, res)
    geometry.rotateX(-Math.PI / 2) // lay flat in XZ

    const material = new THREE.MeshBasicMaterial({
      color: 0x4466cc,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
      wireframe: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.y = -0.5
    mesh.frustumCulled = false
    return mesh
  }

  setGridSolid(solid: boolean): void {
    this.gridIsSolid = solid
    // Only show the appropriate grid if any grid is currently visible
    const anyVisible = this.gridMesh.visible || (this.gridSolidMesh?.visible ?? false)
    if (anyVisible) {
      this.gridMesh.visible = !solid
      if (this.gridSolidMesh) this.gridSolidMesh.visible = solid
    }
  }

  private updateGridDeformation(): void {
    // Throttle: update every 15th frame (~8Hz at 120fps)
    this.gridDeformFrame++
    if (this.gridDeformFrame % 15 !== 0) return
    const anyGridVisible = this.gridMesh.visible || (this.gridSolidMesh?.visible ?? false)
    if (!anyGridVisible) return

    const P = this.POT_RES  // 32
    const mapSize = this.GRID_SIZE
    const mapHalf = mapSize / 2
    const cellSize = mapSize / P

    // Reuse potential map
    if (this.potentialMap.length !== P * P) {
      this.potentialMap = new Float64Array(P * P)
    }
    this.potentialMap.fill(0)

    // Step 1: Splat each particle mass into nearest cell only (fastest)
    const pPosArr = this.positionAttr.array as Float32Array
    const massArr = this.massAttr.array as Float32Array
    const pCount = this.points ? this.points.geometry.drawRange.count : 0

    for (let p = 0; p < pCount; p++) {
      const ci = Math.floor((pPosArr[p * 3] + mapHalf) / cellSize)
      const cj = Math.floor((pPosArr[p * 3 + 2] + mapHalf) / cellSize)
      if (ci >= 0 && ci < P && cj >= 0 && cj < P) {
        this.potentialMap[cj * P + ci] += massArr[p]
      }
    }

    const strength = 800.0

    // Step 2a: Deform wireframe grid vertices
    const posArr = this.gridPositionAttr.array as Float32Array
    const baseArr = this.gridBasePositions
    const vertCount = posArr.length / 3

    for (let v = 0; v < vertCount; v++) {
      const v3 = v * 3
      const ci = Math.floor((baseArr[v3] + mapHalf) / cellSize)
      const cj = Math.floor((baseArr[v3 + 2] + mapHalf) / cellSize)

      if (ci < 0 || ci >= P || cj < 0 || cj >= P) {
        posArr[v3 + 1] = 0
        continue
      }

      posArr[v3 + 1] = -this.potentialMap[cj * P + ci] * strength
    }
    this.gridPositionAttr.needsUpdate = true

    // Step 2b: Deform solid grid vertices (PlaneGeometry)
    if (this.gridSolidMesh) {
      const solidPosAttr = this.gridSolidMesh.geometry.getAttribute('position') as THREE.BufferAttribute
      const solidArr = solidPosAttr.array as Float32Array
      const solidVerts = solidArr.length / 3
      // PlaneGeometry rotated -PI/2 around X: original (x, y) → (x, 0, -y) after rotation
      // After rotation, vertex layout: x = original x, y = 0 (will be deformed), z = original -y
      for (let v = 0; v < solidVerts; v++) {
        const v3 = v * 3
        const wx = solidArr[v3]       // world X
        const wz = solidArr[v3 + 2]   // world Z
        const ci = Math.floor((wx + mapHalf) / cellSize)
        const cj = Math.floor((wz + mapHalf) / cellSize)

        if (ci < 0 || ci >= P || cj < 0 || cj >= P) {
          solidArr[v3 + 1] = 0
          continue
        }
        solidArr[v3 + 1] = -this.potentialMap[cj * P + ci] * strength
      }
      solidPosAttr.needsUpdate = true
    }
  }

  // ─── Double-click → select nearest particle by screen projection ────────

  private findNearestParticle(clientX: number, clientY: number): number {
    if (!this.points) return -1

    const rect = this.renderer.domElement.getBoundingClientRect()
    const clickX = clientX - rect.left
    const clickY = clientY - rect.top
    const w = rect.width
    const h = rect.height

    const posArr = this.positionAttr.array as Float32Array
    const count = this.points.geometry.drawRange.count
    const tmpVec = new THREE.Vector3()

    let bestDist = Infinity
    let bestIndex = -1
    const MAX_SCREEN_DIST = 40

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      tmpVec.set(posArr[i3], posArr[i3 + 1], posArr[i3 + 2])
      tmpVec.project(this.camera)

      const sx = (tmpVec.x * 0.5 + 0.5) * w
      const sy = (-tmpVec.y * 0.5 + 0.5) * h

      if (tmpVec.z > 1) continue

      const dx = sx - clickX
      const dy = sy - clickY
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        bestIndex = i
      }
    }

    return (bestIndex >= 0 && Math.sqrt(bestDist) <= MAX_SCREEN_DIST) ? bestIndex : -1
  }

  private onDoubleClick = (event: MouseEvent): void => {
    if (!this.onParticleClick) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    const idx = this.findNearestParticle(event.clientX, event.clientY)
    if (idx >= 0) {
      this.onParticleClick(idx)
    }
  }

  // ─── Right-click on empty space → deselect ────────────────────────────

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    if (!this.onParticleClick) return
    const idx = this.findNearestParticle(event.clientX, event.clientY)
    if (idx < 0) {
      this.stopFollow()
      this.onParticleClick(-1)
    }
  }

  // ─── Keyboard → camera follow ─────────────────────────────────────────

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      event.preventDefault()
      if (this.onPlayPause) this.onPlayPause()
    } else if (event.code === 'KeyF' && this.followIndex < 0) {
      event.preventDefault()
      if (this.onFollowChange) this.onFollowChange(true)
    } else if (event.code === 'KeyF' && this.followIndex >= 0) {
      event.preventDefault()
      this.stopFollow()
    } else if (event.code === 'Escape') {
      // Escape: stop follow AND deselect
      this.stopFollow()
      if (this.onParticleClick) this.onParticleClick(-1)
    }
  }

  startFollow(particleIndex: number): void {
    if (particleIndex < 0) return
    this.followIndex = particleIndex
  }

  stopFollow(): void {
    if (this.followIndex < 0) return
    this.followIndex = -1
    if (this.onFollowChange) this.onFollowChange(false)
  }

  isFollowing(): boolean {
    return this.followIndex >= 0
  }

  resetView(): void {
    this.stopFollow()
    this.camera.position.set(0, 120, 220)
    this.controls.target.set(0, 0, 0)
    this.camera.lookAt(0, 0, 0)
    this.controls.update()
  }

  private updateFollow(): void {
    if (this.followIndex < 0) return

    const posArr = this.positionAttr.array as Float32Array
    const i3 = this.followIndex * 3
    const px = posArr[i3]
    const py = posArr[i3 + 1]
    const pz = posArr[i3 + 2]

    // Move the OrbitControls target to the particle — camera orbit/zoom/rotate are handled by OrbitControls
    const target = this.controls.target
    const lerpFactor = 0.15
    target.x += (px - target.x) * lerpFactor
    target.y += (py - target.y) * lerpFactor
    target.z += (pz - target.z) * lerpFactor

    // Shift camera by the same delta so the view doesn't jump
    const dx = (px - target.x) * lerpFactor
    const dy = (py - target.y) * lerpFactor
    const dz = (pz - target.z) * lerpFactor
    this.camera.position.x += dx
    this.camera.position.y += dy
    this.camera.position.z += dz
  }

  // ─── Trajectory trail ──────────────────────────────────────────────────

  updateTrajectory(positions: Float32Array, speeds?: Float32Array): void {
    // Remove old line
    if (this.trajectoryLine) {
      this.scene.remove(this.trajectoryLine)
      this.trajectoryLine.geometry.dispose()
      ;(this.trajectoryLine.material as THREE.Material).dispose()
      this.trajectoryLine = null
    }

    if (positions.length < 6) return // need at least 2 points

    const nPts = positions.length / 3

    // Build per-vertex colors from speed (blue→cyan→yellow→red)
    const colors = new Float32Array(nPts * 3)
    if (speeds && speeds.length === nPts) {
      let minS = Infinity, maxS = -Infinity
      for (let i = 0; i < nPts; i++) {
        if (speeds[i] < minS) minS = speeds[i]
        if (speeds[i] > maxS) maxS = speeds[i]
      }
      const range = maxS - minS || 1
      for (let i = 0; i < nPts; i++) {
        const t = (speeds[i] - minS) / range // 0..1
        // Gradient: blue(0) → cyan(0.33) → yellow(0.66) → red(1)
        let r: number, g: number, b: number
        if (t < 0.33) {
          const u = t / 0.33
          r = 0.1; g = 0.3 + 0.7 * u; b = 1.0 - 0.3 * u
        } else if (t < 0.66) {
          const u = (t - 0.33) / 0.33
          r = u; g = 1.0; b = 0.7 * (1.0 - u)
        } else {
          const u = (t - 0.66) / 0.34
          r = 1.0; g = 1.0 - 0.8 * u; b = 0.0
        }
        colors[i * 3] = r
        colors[i * 3 + 1] = g
        colors[i * 3 + 2] = b
      }
    } else {
      // Fallback: solid blue
      for (let i = 0; i < nPts; i++) {
        colors[i * 3] = 0.27; colors[i * 3 + 1] = 0.67; colors[i * 3 + 2] = 1.0
      }
    }

    // Fat line (Line2) — constant screen-space width, visible at any zoom
    const geometry = new LineGeometry()
    geometry.setPositions(positions as unknown as number[])
    geometry.setColors(colors as unknown as number[])

    const material = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      linewidth: 3, // pixels on screen
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      resolution: new THREE.Vector2(
        this.container.clientWidth,
        this.container.clientHeight,
      ),
    })

    this.trajectoryLine = new Line2(geometry, material)
    this.trajectoryLine.computeLineDistances()
    this.scene.add(this.trajectoryLine)
  }

  clearTrajectory(): void {
    if (this.trajectoryLine) {
      this.scene.remove(this.trajectoryLine)
      this.trajectoryLine.geometry.dispose()
      ;(this.trajectoryLine.material as THREE.Material).dispose()
      this.trajectoryLine = null
    }
  }

  // ─── Supernova flash ───────────────────────────────────────────────────

  addSupernovaFlash(x: number, y: number, z: number, _mass: number): void {
    // Brief bright flash at SN location — small sphere that expands and fades
    const size = 0.6
    const geometry = new THREE.SphereGeometry(size, 6, 4)
    const material = new THREE.MeshBasicMaterial({
      color: 0xffeedd,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    this.scene.add(mesh)
    this.supernovaFlashes.push({ mesh, birth: performance.now(), duration: 400 })
  }

  private updateSupernovas(): void {
    const now = performance.now()
    for (let i = this.supernovaFlashes.length - 1; i >= 0; i--) {
      const sn = this.supernovaFlashes[i]
      const t = (now - sn.birth) / sn.duration
      if (t >= 1) {
        this.scene.remove(sn.mesh)
        sn.mesh.geometry.dispose()
        ;(sn.mesh.material as THREE.Material).dispose()
        this.supernovaFlashes.splice(i, 1)
      } else {
        // Expand and fade
        const scale = 1 + t * 3
        sn.mesh.scale.set(scale, scale, scale)
        ;(sn.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
      }
    }
  }

  // ─── State update ──────────────────────────────────────────────────────

  updateParticles(
    positions: Float32Array,
    velocities: Float32Array,
    masses: Float32Array,
    types: Uint8Array,
    count: number,
    stepTime?: number,
  ): void {
    this.pendingPositions = positions
    this.pendingVelocities = velocities
    this.pendingMasses = masses
    this.pendingTypes = types
    this.pendingCount = count
    if (stepTime !== undefined && this.onStepTime) {
      this.onStepTime(stepTime)
    }
  }

  private applyState(): void {
    if (!this.pendingPositions || this.pendingCount === 0) return

    const count = this.pendingCount
    const positions = this.pendingPositions
    const velocities = this.pendingVelocities
    const masses = this.pendingMasses
    const types = this.pendingTypes

    const posArr = this.positionAttr.array as Float32Array
    posArr.set(positions.subarray(0, count * 3))
    this.positionAttr.needsUpdate = true

    if (velocities && masses && types) {
      const speedArr = this.speedAttr.array as Float32Array
      const massArr = this.massAttr.array as Float32Array
      const typeArr = this.typeAttr.array as Float32Array

      for (let i = 0; i < count; i++) {
        const i3 = i * 3
        const vx = velocities[i3]
        const vy = velocities[i3 + 1]
        const vz = velocities[i3 + 2]
        speedArr[i] = Math.sqrt(vx * vx + vy * vy + vz * vz)
        massArr[i] = masses[i]
        typeArr[i] = types[i]
      }
      this.speedAttr.needsUpdate = true
      this.massAttr.needsUpdate = true
      this.typeAttr.needsUpdate = true
    }

    if (this.points) {
      this.points.geometry.setDrawRange(0, count)
    }

    this.pendingPositions = null
    this.pendingVelocities = null
    this.pendingMasses = null
    this.pendingTypes = null
  }

  // ─── Animation loop ────────────────────────────────────────────────────

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate)
    this.applyState()
    this.updateSupernovas()
    this.updateGridDeformation()
    this.updateFollow();
    this.controls.update();
    this.renderer.render(this.scene, this.camera)

    this.frameCount++
    const now = performance.now()
    if (now - this.lastFpsTime >= 1000) {
      if (this.onFpsUpdate) this.onFpsUpdate(this.frameCount)
      this.frameCount = 0
      this.lastFpsTime = now
    }
  }

  private onResize = (): void => {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    // Update fat-line resolution
    if (this.trajectoryLine) {
      ;(this.trajectoryLine.material as LineMaterial).resolution.set(width, height)
    }
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener('dblclick', this.onDoubleClick)
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKeyDown)
    if (this.animationId !== null) cancelAnimationFrame(this.animationId)
    this.controls.dispose()
    this.renderer.dispose()
    if (this.points) {
      this.points.geometry.dispose()
      ;(this.points.material as THREE.Material).dispose()
    }
    this.clearTrajectory()
    for (const sn of this.supernovaFlashes) {
      sn.mesh.geometry.dispose()
      ;(sn.mesh.material as THREE.Material).dispose()
    }
    this.renderer.domElement.remove()
  }
}

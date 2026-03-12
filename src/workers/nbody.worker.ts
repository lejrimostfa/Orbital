/**
 * N-body simulation Web Worker
 *
 * Features:
 *   - Barnes-Hut octree O(n log n) gravity
 *   - Two IC modes: Galaxy (disk+bulge+SMBH) and Cosmological (CMB block)
 *   - Stellar evolution: aging → supernova → stellar black hole
 *   - Velocity Verlet symplectic integrator
 *   - Trajectory recording for selected particle
 */

import type { SimulationConfig, SimulationState, WorkerCommand, WorkerResponse } from '../simulation/types'
import { DEFAULT_CONFIG } from '../simulation/types'

// ParticleType enum values (can't import const enum across worker boundary)
const STAR = 0
const BLACK_HOLE = 1
const SMBH = 2

let state: SimulationState | null = null
let config: SimulationConfig = { ...DEFAULT_CONFIG }
let running = false
let frameId: ReturnType<typeof setTimeout> | null = null
let simTime = 0

// Acceleration buffers
let ax: Float64Array
let ay: Float64Array
let az: Float64Array

// Trajectory recording
let trackedParticle = -1
let trajectoryBuffer: number[] = []
let trajectorySpeedBuffer: number[] = []
let trajectoryStepCounter = 0
const MAX_TRAJECTORY_POINTS = 5000
const TRAJECTORY_RECORD_INTERVAL = 3 // record every Nth step

// ═══════════════════════════════════════════════════════════════════════════════
// BARNES-HUT OCTREE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Flat octree stored in typed arrays for cache efficiency.
 * Each node stores: center of mass (cx,cy,cz), total mass, size, and child pointers.
 * Children are stored as 8 consecutive indices (or -1 if empty).
 */
const MAX_NODES = 200000
// Node data: [cx, cy, cz, mass, halfSize, particleIndex(-1 if internal)]
const nodeCx = new Float64Array(MAX_NODES)
const nodeCy = new Float64Array(MAX_NODES)
const nodeCz = new Float64Array(MAX_NODES)
const nodeMass = new Float64Array(MAX_NODES)
const nodeHalf = new Float64Array(MAX_NODES)
// Center of the node box
const nodeBoxX = new Float64Array(MAX_NODES)
const nodeBoxY = new Float64Array(MAX_NODES)
const nodeBoxZ = new Float64Array(MAX_NODES)
// -1 = empty leaf, >=0 = single particle, -2 = internal (has children)
const nodeBody = new Int32Array(MAX_NODES)
// Children: 8 per node. children[node*8 + octant] = child node index or -1
const children = new Int32Array(MAX_NODES * 8)

let nodeCount = 0

function octantIndex(px: number, py: number, pz: number, cx: number, cy: number, cz: number): number {
  return (px > cx ? 1 : 0) | (py > cy ? 2 : 0) | (pz > cz ? 4 : 0)
}

function buildOctree(): void {
  if (!state) return
  const n = state.count
  const { px, py, pz, mass } = state

  // Find bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    if (px[i] < minX) minX = px[i]
    if (py[i] < minY) minY = py[i]
    if (pz[i] < minZ) minZ = pz[i]
    if (px[i] > maxX) maxX = px[i]
    if (py[i] > maxY) maxY = py[i]
    if (pz[i] > maxZ) maxZ = pz[i]
  }

  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) + 0.01
  const half = size * 0.5
  const rootCx = (minX + maxX) * 0.5
  const rootCy = (minY + maxY) * 0.5
  const rootCz = (minZ + maxZ) * 0.5

  // Init root
  nodeCount = 1
  nodeBoxX[0] = rootCx
  nodeBoxY[0] = rootCy
  nodeBoxZ[0] = rootCz
  nodeHalf[0] = half
  nodeBody[0] = -1 // empty
  nodeCx[0] = 0; nodeCy[0] = 0; nodeCz[0] = 0; nodeMass[0] = 0
  children.fill(-1, 0, 8)

  // Insert particles
  for (let i = 0; i < n; i++) {
    insertParticle(0, i, px[i], py[i], pz[i], mass[i])
  }

  // Compute center-of-mass bottom-up
  computeCOM(0)
}

function insertParticle(node: number, idx: number, px: number, py: number, pz: number, m: number): void {
  if (nodeCount >= MAX_NODES - 10) return // safety

  const body = nodeBody[node]

  if (body === -1) {
    // Empty leaf → store particle
    nodeBody[node] = idx
    return
  }

  if (body >= 0) {
    // Leaf with one particle → subdivide
    const existingIdx = body
    nodeBody[node] = -2 // mark internal

    // Re-insert existing particle
    const ePx = state!.px[existingIdx]
    const ePy = state!.py[existingIdx]
    const ePz = state!.pz[existingIdx]
    const eM = state!.mass[existingIdx]
    insertIntoChild(node, existingIdx, ePx, ePy, ePz, eM)
    // Insert new particle
    insertIntoChild(node, idx, px, py, pz, m)
    return
  }

  // Internal node → insert into appropriate child
  insertIntoChild(node, idx, px, py, pz, m)
}

function insertIntoChild(node: number, idx: number, px: number, py: number, pz: number, m: number): void {
  const oct = octantIndex(px, py, pz, nodeBoxX[node], nodeBoxY[node], nodeBoxZ[node])
  const ci = node * 8 + oct

  if (children[ci] === -1) {
    // Create child node
    const child = nodeCount++
    children[ci] = child
    const h = nodeHalf[node] * 0.5
    nodeBoxX[child] = nodeBoxX[node] + (oct & 1 ? h : -h)
    nodeBoxY[child] = nodeBoxY[node] + (oct & 2 ? h : -h)
    nodeBoxZ[child] = nodeBoxZ[node] + (oct & 4 ? h : -h)
    nodeHalf[child] = h
    nodeBody[child] = -1
    nodeCx[child] = 0; nodeCy[child] = 0; nodeCz[child] = 0; nodeMass[child] = 0
    children.fill(-1, child * 8, child * 8 + 8)
  }

  insertParticle(children[ci], idx, px, py, pz, m)
}

function computeCOM(node: number): void {
  const body = nodeBody[node]

  if (body >= 0) {
    // Leaf with single particle
    nodeCx[node] = state!.px[body]
    nodeCy[node] = state!.py[body]
    nodeCz[node] = state!.pz[body]
    nodeMass[node] = state!.mass[body]
    return
  }

  if (body === -1) {
    nodeMass[node] = 0
    return
  }

  // Internal: sum children
  let totalM = 0, cx = 0, cy = 0, cz = 0
  for (let oct = 0; oct < 8; oct++) {
    const child = children[node * 8 + oct]
    if (child === -1) continue
    computeCOM(child)
    const cm = nodeMass[child]
    if (cm <= 0) continue
    totalM += cm
    cx += nodeCx[child] * cm
    cy += nodeCy[child] * cm
    cz += nodeCz[child] * cm
  }

  if (totalM > 0) {
    nodeCx[node] = cx / totalM
    nodeCy[node] = cy / totalM
    nodeCz[node] = cz / totalM
  }
  nodeMass[node] = totalM
}

function computeForce(node: number, i: number, G: number, eps2: number, theta2: number): void {
  const body = nodeBody[node]
  const nm = nodeMass[node]
  if (nm <= 0) return

  // If leaf with the same particle, skip
  if (body === i) return

  const dx = nodeCx[node] - state!.px[i]
  const dy = nodeCy[node] - state!.py[i]
  const dz = nodeCz[node] - state!.pz[i]
  const dist2 = dx * dx + dy * dy + dz * dz

  // If leaf with single particle, compute directly
  if (body >= 0) {
    const r2 = dist2 + eps2
    const invDist = 1.0 / Math.sqrt(r2)
    const invDist3 = invDist * invDist * invDist
    const f = G * nm * invDist3
    ax[i] += dx * f
    ay[i] += dy * f
    az[i] += dz * f
    return
  }

  // Barnes-Hut criterion: s/d < θ  ⟹  s² / d² < θ²
  const s = nodeHalf[node] * 2.0
  if (s * s < dist2 * theta2) {
    // Use multipole approximation
    const r2 = dist2 + eps2
    const invDist = 1.0 / Math.sqrt(r2)
    const invDist3 = invDist * invDist * invDist
    const f = G * nm * invDist3
    ax[i] += dx * f
    ay[i] += dy * f
    az[i] += dz * f
    return
  }

  // Recurse into children
  for (let oct = 0; oct < 8; oct++) {
    const child = children[node * 8 + oct]
    if (child !== -1) computeForce(child, i, G, eps2, theta2)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOM UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function gaussRandom(): number {
  const u1 = Math.random() || 1e-10
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function samplePowerLaw(alpha: number, mMin: number, mMax: number): number {
  if (Math.abs(alpha - 1.0) < 0.01) {
    return mMin * Math.pow(mMax / mMin, Math.random())
  }
  const b = 1.0 - alpha
  const cMin = Math.pow(mMin, b)
  const cMax = Math.pow(mMax, b)
  return Math.pow(cMin + Math.random() * (cMax - cMin), 1.0 / b)
}

// ═══════════════════════════════════════════════════════════════════════════════
// GALAXY IC
// ═══════════════════════════════════════════════════════════════════════════════

function sampleExponentialRadius(Rd: number, maxR: number): number {
  const peakDensity = 1.0 / (Rd * Math.E)
  while (true) {
    const R = Math.random() * maxR
    const pR = (R / (Rd * Rd)) * Math.exp(-R / Rd)
    if (Math.random() * peakDensity < pR) return R
  }
}

function sampleSechSquaredHeight(z0: number): number {
  const u = 0.01 + Math.random() * 0.98
  return z0 * Math.atanh(2.0 * u - 1.0)
}

function sampleHernquistRadius(a: number, rMax: number): number {
  while (true) {
    const u = Math.random() * 0.98
    const sqrtU = Math.sqrt(u)
    const r = a * sqrtU / (1.0 - sqrtU)
    if (r <= rMax) return r
  }
}

function hernquistEnclosedMass(r: number, a: number, Mb: number): number {
  const ra = r + a
  return Mb * (r * r) / (ra * ra)
}

function hernquistDispersion(r: number, G: number, Menc: number): number {
  if (r < 1e-10) return 0
  return Math.sqrt(G * Menc / (3.0 * r))
}

function diskEnclosedMass(R: number, Rd: number, Mdisk: number): number {
  const x = R / Rd
  return Mdisk * (1.0 - (1.0 + x) * Math.exp(-x))
}

function circularVelocity(R: number, G: number, Menc: number): number {
  if (R < 1e-10) return 0
  return Math.sqrt(G * Menc / R)
}

function initGalaxy(): void {
  const n = config.particleCount
  const Rd = config.scaleLength
  const z0 = Rd * config.scaleHeightRatio
  const maxR = Rd * config.maxRadiusFactor
  const bulgeA = Rd * config.bulgeScaleRatio

  const Mtotal = 1.0
  const Msmbh = Mtotal * config.smbhMassFraction
  const Mstellar = Mtotal - Msmbh
  const Mbulge = Mstellar * config.bulgeFraction
  const Mdisk = Mstellar * (1.0 - config.bulgeFraction)

  const nBulge = Math.round((n - 1) * config.bulgeFraction)

  allocateState(n)

  // SMBH at index 0
  state!.mass[0] = Msmbh
  state!.ptype[0] = SMBH

  // IMF mass sampling for stellar particles
  const rawMasses = new Float64Array(n - 1)
  let totalRaw = 0
  for (let i = 0; i < n - 1; i++) {
    rawMasses[i] = samplePowerLaw(config.imfExponent, config.massRatioMin, config.massRatioMax)
    totalRaw += rawMasses[i]
  }
  const scale = Mstellar / totalRaw
  for (let i = 0; i < n - 1; i++) {
    state!.mass[i + 1] = rawMasses[i] * scale
    state!.ptype[i + 1] = STAR
  }

  // Bulge particles
  for (let i = 1; i <= nBulge; i++) {
    const r = sampleHernquistRadius(bulgeA, maxR)
    const cosTheta = 2.0 * Math.random() - 1.0
    const sinTheta = Math.sqrt(1.0 - cosTheta * cosTheta)
    const phi = Math.random() * 2.0 * Math.PI

    state!.px[i] = r * sinTheta * Math.cos(phi)
    state!.py[i] = r * cosTheta
    state!.pz[i] = r * sinTheta * Math.sin(phi)

    const Rxy = Math.sqrt(state!.px[i] ** 2 + state!.pz[i] ** 2)
    const Menc = Msmbh + hernquistEnclosedMass(r, bulgeA, Mbulge) + diskEnclosedMass(Rxy, Rd, Mdisk)
    const sigma = hernquistDispersion(r, config.G, Menc)
    const vCircBulge = circularVelocity(Rxy, config.G, Menc) * 0.3
    const thetaXZ = Math.atan2(state!.pz[i], state!.px[i])

    state!.vx[i] = gaussRandom() * sigma + (-Math.sin(thetaXZ) * vCircBulge)
    state!.vy[i] = gaussRandom() * sigma * 0.7
    state!.vz[i] = gaussRandom() * sigma + (Math.cos(thetaXZ) * vCircBulge)
  }

  // Disk particles
  for (let i = nBulge + 1; i < n; i++) {
    const R = sampleExponentialRadius(Rd, maxR)
    const theta = Math.random() * Math.PI * 2
    const z = sampleSechSquaredHeight(z0)

    state!.px[i] = R * Math.cos(theta)
    state!.py[i] = z
    state!.pz[i] = R * Math.sin(theta)

    const Menc = Msmbh + hernquistEnclosedMass(R, bulgeA, Mbulge) + diskEnclosedMass(R, Rd, Mdisk)
    const vCirc = circularVelocity(R, config.G, Menc)
    const vx = -Math.sin(theta) * vCirc
    const vz = Math.cos(theta) * vCirc

    const sigmaR = vCirc * 0.12
    const sigmaZ = sigmaR * config.scaleHeightRatio

    state!.vx[i] = vx + Math.cos(theta) * gaussRandom() * sigmaR - Math.sin(theta) * gaussRandom() * sigmaR * 0.6
    state!.vy[i] = gaussRandom() * sigmaZ
    state!.vz[i] = vz + Math.sin(theta) * gaussRandom() * sigmaR + Math.cos(theta) * gaussRandom() * sigmaR * 0.6
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COSMOLOGICAL IC — Fractal filamentary structure (cosmic web)
// ═══════════════════════════════════════════════════════════════════════════════

// Simple 3D hash-based gradient noise (no external deps)
function noise3d(x: number, y: number, z: number): number {
  // Integer cell corners
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  // Smoothstep
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)

  function hash(i: number, j: number, k: number): number {
    let h = (i * 374761 + j * 668265 + k * 1274653) & 0x7fffffff
    h = ((h >> 13) ^ h)
    h = (h * (h * h * 15731 + 789221) + 1376312589) & 0x7fffffff
    return (h / 0x7fffffff) * 2 - 1
  }

  // Trilinear interpolation of hash values
  const c000 = hash(ix, iy, iz)
  const c100 = hash(ix + 1, iy, iz)
  const c010 = hash(ix, iy + 1, iz)
  const c110 = hash(ix + 1, iy + 1, iz)
  const c001 = hash(ix, iy, iz + 1)
  const c101 = hash(ix + 1, iy, iz + 1)
  const c011 = hash(ix, iy + 1, iz + 1)
  const c111 = hash(ix + 1, iy + 1, iz + 1)

  const c00 = c000 + ux * (c100 - c000)
  const c10 = c010 + ux * (c110 - c010)
  const c01 = c001 + ux * (c101 - c001)
  const c11 = c011 + ux * (c111 - c011)
  const c0 = c00 + uy * (c10 - c00)
  const c1 = c01 + uy * (c11 - c01)
  return c0 + uz * (c1 - c0)
}

// Multi-octave fractal noise → produces filamentary density field
function fractalDensity(x: number, y: number, z: number): number {
  let val = 0
  let amp = 1.0
  let freq = 1.0
  // 5 octaves: large voids + medium filaments + small clumps
  for (let o = 0; o < 5; o++) {
    val += amp * noise3d(x * freq, y * freq, z * freq)
    amp *= 0.5
    freq *= 2.0
  }
  // Filament enhancement: take absolute value → creates sharp ridges (filaments)
  // where noise crosses zero, and voids in the peaks/troughs
  const ridged = 1.0 - Math.abs(val)
  // Sharpen the filaments with a power function
  return Math.pow(Math.max(0, ridged), 2.5)
}

function initCosmological(): void {
  const n = config.particleCount
  const L = config.boxSize
  const amp = config.perturbationAmplitude

  allocateState(n)

  const Mtotal = 1.0

  // Noise frequency scale: controls how many filaments fit in the box
  // Higher → more filaments, lower → fewer but larger structures
  const noiseScale = 3.0 / L

  // Step 1: Place particles via rejection sampling on the fractal density field
  // This naturally creates filaments, voids, and dense nodes
  let idx = 0
  let attempts = 0
  const maxAttempts = n * 200 // safety limit

  while (idx < n && attempts < maxAttempts) {
    attempts++
    // Random candidate position in the box
    const x = (Math.random() - 0.5) * L
    const y = (Math.random() - 0.5) * L
    const z = (Math.random() - 0.5) * L

    // Evaluate fractal density at this point
    const density = fractalDensity(x * noiseScale, y * noiseScale, z * noiseScale)

    // Rejection sampling: accept with probability proportional to density
    // Mix with a small uniform floor so voids aren't completely empty
    const acceptance = density * amp + 0.02
    if (Math.random() < acceptance) {
      state!.px[idx] = x
      state!.py[idx] = y
      state!.pz[idx] = z

      // Mass proportional to local density (denser → heavier particles)
      state!.mass[idx] = 1.0 + density * 2.0

      // Small thermal velocities
      const vTherm = 0.005
      state!.vx[idx] = gaussRandom() * vTherm
      state!.vy[idx] = gaussRandom() * vTherm
      state!.vz[idx] = gaussRandom() * vTherm

      // Hubble flow: v = H * r
      if (config.hubbleParam > 0) {
        state!.vx[idx] += config.hubbleParam * x
        state!.vy[idx] += config.hubbleParam * y
        state!.vz[idx] += config.hubbleParam * z
      }

      state!.ptype[idx] = STAR
      idx++
    }
  }

  // If rejection sampling didn't fill all particles, place remainder randomly
  while (idx < n) {
    state!.px[idx] = (Math.random() - 0.5) * L
    state!.py[idx] = (Math.random() - 0.5) * L
    state!.pz[idx] = (Math.random() - 0.5) * L
    state!.mass[idx] = 1.0
    state!.vx[idx] = gaussRandom() * 0.005
    state!.vy[idx] = gaussRandom() * 0.005
    state!.vz[idx] = gaussRandom() * 0.005
    if (config.hubbleParam > 0) {
      state!.vx[idx] += config.hubbleParam * state!.px[idx]
      state!.vy[idx] += config.hubbleParam * state!.py[idx]
      state!.vz[idx] += config.hubbleParam * state!.pz[idx]
    }
    state!.ptype[idx] = STAR
    idx++
  }

  // Apply weak spherical rotational velocity field around center (Y-axis)
  // Angular velocity ∝ 1/sqrt(r) — blend of solid-body and Keplerian
  const omegaMax = 0.03 * amp // weak rotation, scaled by perturbation amplitude
  for (let i = 0; i < n; i++) {
    const x = state!.px[i]
    const z = state!.pz[i]
    const rCyl = Math.sqrt(x * x + z * z)
    if (rCyl < 1e-6) continue
    // Tangential direction in XZ plane: (-z, 0, x) / r
    const omega = omegaMax / Math.sqrt(1.0 + rCyl)
    state!.vx[i] += -z * omega
    state!.vz[i] +=  x * omega
  }

  // Normalize total mass to 1
  let totalM = 0
  for (let i = 0; i < n; i++) totalM += state!.mass[i]
  const mScale = Mtotal / totalM
  for (let i = 0; i < n; i++) state!.mass[i] *= mScale
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ALLOCATION
// ═══════════════════════════════════════════════════════════════════════════════

function allocateState(n: number): void {
  state = {
    px: new Float64Array(n),
    py: new Float64Array(n),
    pz: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    vz: new Float64Array(n),
    mass: new Float64Array(n),
    ptype: new Uint8Array(n),
    age: new Float64Array(n),
    metallicity: new Float64Array(n), // 0=primordial, up to ~1=enriched
    heat: new Float64Array(n),        // thermal energy from SN feedback
    count: n,
  }
  ax = new Float64Array(n)
  ay = new Float64Array(n)
  az = new Float64Array(n)
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORCE COMPUTATION (with octree or brute-force fallback)
// ═══════════════════════════════════════════════════════════════════════════════

function computeAccelerations(): void {
  if (!state) return

  const n = state.count
  const G = config.G
  const eps2 = config.softening * config.softening

  ax.fill(0)
  ay.fill(0)
  az.fill(0)

  if (config.theta > 0 && n > 200) {
    // Barnes-Hut
    buildOctree()
    const theta2 = config.theta * config.theta
    for (let i = 0; i < n; i++) {
      computeForce(0, i, G, eps2, theta2)
    }
  } else {
    // Brute-force O(n²)
    const { px, py, pz, mass } = state
    for (let i = 0; i < n; i++) {
      const xi = px[i], yi = py[i], zi = pz[i]
      for (let j = i + 1; j < n; j++) {
        const dx = px[j] - xi
        const dy = py[j] - yi
        const dz = pz[j] - zi
        const dist2 = dx * dx + dy * dy + dz * dz + eps2
        const invDist = 1.0 / Math.sqrt(dist2)
        const invDist3 = invDist * invDist * invDist
        const fj = G * mass[j] * invDist3
        const fi = G * mass[i] * invDist3
        ax[i] += dx * fj; ay[i] += dy * fj; az[i] += dz * fj
        ax[j] -= dx * fi; ay[j] -= dy * fi; az[j] -= dz * fi
      }
    }
  }

  // ─── NFW Dark Matter halo external potential ─────────────────────────
  if (config.darkMatterEnabled) {
    applyDarkMatterHalo(n, G, eps2)
  }
}

/**
 * NFW (Navarro-Frenk-White) dark matter halo.
 * M_enclosed(r) = M_total * f(r/r_s) / f(c)
 * where f(x) = ln(1+x) - x/(1+x)
 * Acceleration: a = -G * M_enclosed(r) / (r² + eps²) * r_hat
 * Halo is centered at the barycenter (config.measurePlaneX/Y/Z when auto-tracking).
 */
function applyDarkMatterHalo(n: number, G: number, eps2: number): void {
  if (!state) return

  const rs = config.dmScaleRadius
  const c = config.dmConcentration
  const Mtot = config.dmHaloMass
  const fc = Math.log(1 + c) - c / (1 + c) // normalization factor
  if (fc < 1e-12) return

  // Halo center: use densest mass zone (stored in measurePlane coords when auto-tracking)
  const cx = config.measurePlaneAutoTrack ? config.measurePlaneX : 0
  const cy = config.measurePlaneAutoTrack ? config.measurePlaneY : 0
  const cz = config.measurePlaneAutoTrack ? config.measurePlaneZ : 0

  const { px, py, pz } = state

  for (let i = 0; i < n; i++) {
    const dx = px[i] - cx
    const dy = py[i] - cy
    const dz = pz[i] - cz
    const r2 = dx * dx + dy * dy + dz * dz
    const r = Math.sqrt(r2)
    const x = r / rs  // r / r_s
    const fxVal = Math.log(1 + x) - x / (1 + x) // f(x)
    const Menclosed = Mtot * fxVal / fc
    const accel = -G * Menclosed / (r2 + eps2)
    const invR = r > 1e-12 ? 1.0 / r : 0
    ax[i] += accel * dx * invR
    ay[i] += accel * dy * invR
    az[i] += accel * dz * invR
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STELLAR EVOLUTION — Full lifecycle with SN feedback
//   1. Aging → Supernova → BH formation (with mass/momentum/metallicity ejecta)
//   2. Black hole mergers
//   3. Star formation in dense regions (boosted by SN compression & metallicity)
//   4. Thermal heat decay
// ═══════════════════════════════════════════════════════════════════════════════

function processStellarEvolution(): void {
  if (!state || !config.stellarEvolution) return

  const n = state.count
  const dt = config.timestep
  const snThresh = config.snMassThreshold
  const kickV = config.snKickVelocity
  const eps2 = config.softening * config.softening
  const soft = config.softening

  // ─── 0. Heat decay (thermal feedback cools over time) ─────────────────
  const heatDecayRate = 0.05 // fraction lost per timestep
  for (let i = 0; i < n; i++) {
    if (state.heat[i] > 0) {
      state.heat[i] *= (1.0 - heatDecayRate)
      if (state.heat[i] < 1e-8) state.heat[i] = 0
    }
  }

  // ─── 1. Aging + Supernova + BH formation ──────────────────────────────
  let snCount = 0
  const MAX_SN_PER_STEP = 2
  const kickRadius2 = (soft * 4) ** 2    // blast wave radius
  const enrichRadius2 = (soft * 5) ** 2  // enrichment/heat radius (wider)

  for (let i = 0; i < n; i++) {
    if (state.ptype[i] !== STAR) continue

    state.age[i] += dt

    const m = state.mass[i]
    if (m < snThresh) continue

    // Stellar lifetime ∝ mass^(-2.5)
    const lifetime = 5.0 * Math.pow(snThresh / m, 2.5)

    if (state.age[i] >= lifetime) {
      if (snCount >= MAX_SN_PER_STEP) continue
      snCount++

      // Notify renderer
      const sx = state.px[i] * config.displayScale
      const sy = state.py[i] * config.displayScale
      const sz = state.pz[i] * config.displayScale
      self.postMessage({ type: 'supernova', x: sx, y: sy, z: sz, mass: m } as WorkerResponse)

      const ejectFrac = 0.6 // 60% of mass ejected
      const ejectMass = m * ejectFrac
      const remnantMass = m * (1.0 - ejectFrac)
      const snMetallicity = Math.min(state.metallicity[i] + 0.3, 1.0) // SN enriches ejecta

      // Collect neighbors in blast zone for mass/energy redistribution
      let totalWeight = 0
      const neighborBuf: { idx: number; r: number; w: number }[] = []
      let bhAccretor = -1
      let bhAccretorDist2 = Infinity

      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = state.px[j] - state.px[i]
        const dy = state.py[j] - state.py[i]
        const dz = state.pz[j] - state.pz[i]
        const r2 = dx * dx + dy * dy + dz * dz

        // (a) Velocity kick — blast wave
        if (r2 < kickRadius2 && r2 > eps2) {
          const r = Math.sqrt(r2)
          const kick = kickV * m * Math.exp(-r2 / kickRadius2 * 4)
          state.vx[j] += (dx / r) * kick
          state.vy[j] += (dy / r) * kick
          state.vz[j] += (dz / r) * kick
        }

        // (b) Collect stars in enrichment zone for mass redistribution
        if (r2 < enrichRadius2 && state.ptype[j] === STAR) {
          const r = Math.sqrt(r2)
          const w = Math.exp(-r2 / enrichRadius2 * 2) // gaussian weight
          neighborBuf.push({ idx: j, r, w })
          totalWeight += w
        }

        // (c) Find nearest BH for accretion
        if ((state.ptype[j] === BLACK_HOLE || state.ptype[j] === SMBH) && r2 < enrichRadius2 && r2 < bhAccretorDist2) {
          bhAccretorDist2 = r2
          bhAccretor = j
        }
      }

      // ── (3) BH accretion: nearest BH captures a fraction of ejecta ──
      let bhAccreted = 0
      if (bhAccretor >= 0) {
        bhAccreted = ejectMass * 0.15 // BH captures 15% of ejecta
        state.mass[bhAccretor] += bhAccreted
      }

      // ── (1) Redistribute remaining ejecta to nearby star particles ──
      const massToDistribute = ejectMass - bhAccreted
      if (totalWeight > 0 && neighborBuf.length > 0) {
        for (const nb of neighborBuf) {
          const share = (nb.w / totalWeight) * massToDistribute
          state.mass[nb.idx] += share

          // ── (4) Chemical enrichment: transfer SN metallicity ──
          // Weighted blend of existing metallicity with SN ejecta metallicity
          const oldZ = state.metallicity[nb.idx]
          const oldM = state.mass[nb.idx] - share
          state.metallicity[nb.idx] = (oldZ * oldM + snMetallicity * share) / state.mass[nb.idx]

          // ── (5) Thermal feedback: inject heat proportional to blast ──
          state.heat[nb.idx] += (nb.w / totalWeight) * m * 0.5
        }
      }

      // ── (2) Triggered star formation: compress nearby gas ──
      // Particles hit by the shockwave get a compression boost recorded
      // in their metallicity/heat which the SF routine reads below

      // Convert remnant to black hole
      state.mass[i] = remnantMass
      state.ptype[i] = BLACK_HOLE
      state.age[i] = 0
      state.heat[i] = 0
      state.metallicity[i] = 0 // BH has no metallicity
    }
  }

  // ─── 2. Black hole mergers ────────────────────────────────────────────
  const mergeRadius2 = (soft * 1.5) * (soft * 1.5)
  const MAX_MERGES_PER_STEP = 2
  let mergeCount = 0

  for (let i = 0; i < n && mergeCount < MAX_MERGES_PER_STEP; i++) {
    if (state.ptype[i] !== BLACK_HOLE && state.ptype[i] !== SMBH) continue
    if (state.mass[i] <= 0) continue

    for (let j = i + 1; j < n; j++) {
      if (state.ptype[j] !== BLACK_HOLE && state.ptype[j] !== SMBH) continue
      if (state.mass[j] <= 0) continue

      const dx = state.px[j] - state.px[i]
      const dy = state.py[j] - state.py[i]
      const dz = state.pz[j] - state.pz[i]
      const r2 = dx * dx + dy * dy + dz * dz

      if (r2 < mergeRadius2) {
        const mi = state.mass[i], mj = state.mass[j]
        const totalM = mi + mj
        const inv = 1.0 / totalM

        state.px[i] = (state.px[i] * mi + state.px[j] * mj) * inv
        state.py[i] = (state.py[i] * mi + state.py[j] * mj) * inv
        state.pz[i] = (state.pz[i] * mi + state.pz[j] * mj) * inv
        state.vx[i] = (state.vx[i] * mi + state.vx[j] * mj) * inv
        state.vy[i] = (state.vy[i] * mi + state.vy[j] * mj) * inv
        state.vz[i] = (state.vz[i] * mi + state.vz[j] * mj) * inv

        state.mass[i] = totalM
        if (state.ptype[i] === BLACK_HOLE && totalM > snThresh * 5) {
          state.ptype[i] = SMBH
        }

        // Remove j
        state.mass[j] = 1e-12
        state.px[j] = 1e6; state.py[j] = 1e6; state.pz[j] = 1e6
        state.vx[j] = 0; state.vy[j] = 0; state.vz[j] = 0
        state.ptype[j] = STAR
        state.heat[j] = 0
        state.metallicity[j] = 0

        mergeCount++
        if (mergeCount >= MAX_MERGES_PER_STEP) break
      }
    }
  }

  // ─── 3. Star formation in dense regions ───────────────────────────────
  // Dense clumps collapse into massive newborn stars.
  // Boosted by: high metallicity (efficient cooling) and SN compression (heat).
  // Suppressed by: very high heat (thermal negative feedback).
  const MAX_BIRTHS_PER_STEP = 2
  let birthCount = 0
  const formRadius2 = (soft * 4) * (soft * 4)
  const BASE_NEIGHBOR_THRESH = 8

  const checkStride = 10
  const checkOffset = Math.floor(Math.random() * checkStride)

  for (let i = checkOffset; i < n && birthCount < MAX_BIRTHS_PER_STEP; i += checkStride) {
    if (state.ptype[i] !== STAR) continue
    if (state.mass[i] > snThresh * 0.5) continue
    if (state.age[i] < 1.0) continue

    // (5) Thermal negative feedback: very hot gas can't collapse
    if (state.heat[i] > 1.0) continue

    // (4) Metallicity bonus: enriched gas cools faster → easier collapse
    // (2) Moderate heat = compression from SN → triggered star formation
    const metalBonus = state.metallicity[i] * 3 // up to 3 fewer neighbors needed
    const compressionBonus = Math.min(state.heat[i] * 2, 2) // moderate heat helps
    const effectiveThresh = Math.max(3, BASE_NEIGHBOR_THRESH - metalBonus - compressionBonus)

    let neighbors = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const dx = state.px[j] - state.px[i]
      const dy = state.py[j] - state.py[i]
      const dz = state.pz[j] - state.pz[i]
      const r2 = dx * dx + dy * dy + dz * dz
      if (r2 < formRadius2) {
        neighbors++
        if (neighbors >= effectiveThresh) break
      }
    }

    if (neighbors >= effectiveThresh) {
      // Accrete mass from neighbors (gas collapse)
      const accreted = state.mass[i] * 0.3
      state.mass[i] += accreted * neighbors
      state.age[i] = 0 // newborn

      // (4) Enriched newborns inherit local metallicity (already set by ejecta)
      // Higher metallicity → slightly more massive stars
      state.mass[i] *= (1.0 + state.metallicity[i] * 0.5)

      state.heat[i] = 0 // collapse consumes thermal energy
      birthCount++
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION (Velocity Verlet)
// ═══════════════════════════════════════════════════════════════════════════════

function step(): void {
  if (!state) return

  const n = state.count
  const dt = config.timestep
  const halfDt = 0.5 * dt
  const { px, py, pz, vx, vy, vz } = state

  for (let i = 0; i < n; i++) {
    vx[i] += ax[i] * halfDt
    vy[i] += ay[i] * halfDt
    vz[i] += az[i] * halfDt
  }

  for (let i = 0; i < n; i++) {
    px[i] += vx[i] * dt
    py[i] += vy[i] * dt
    pz[i] += vz[i] * dt
  }

  computeAccelerations()

  for (let i = 0; i < n; i++) {
    vx[i] += ax[i] * halfDt
    vy[i] += ay[i] * halfDt
    vz[i] += az[i] * halfDt
  }

  simTime += dt

  // Stellar evolution after force computation
  processStellarEvolution()

  // Record trajectory if tracking (subsampled to cover more time)
  if (trackedParticle >= 0 && trackedParticle < n) {
    trajectoryStepCounter++
    if (trajectoryStepCounter >= TRAJECTORY_RECORD_INTERVAL) {
      trajectoryStepCounter = 0
      const s = config.displayScale
      trajectoryBuffer.push(
        px[trackedParticle] * s,
        py[trackedParticle] * s,
        pz[trackedParticle] * s,
      )
      const svx = state!.vx[trackedParticle], svy = state!.vy[trackedParticle], svz = state!.vz[trackedParticle]
      trajectorySpeedBuffer.push(Math.sqrt(svx * svx + svy * svy + svz * svz))
      if (trajectoryBuffer.length > MAX_TRAJECTORY_POINTS * 3) {
        trajectoryBuffer.splice(0, 3)
        trajectorySpeedBuffer.splice(0, 1)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VELOCITY PROFILE — binned average |v| vs R
// ═══════════════════════════════════════════════════════════════════════════════

function computeVelocityProfile(): Float32Array {
  if (!state) return new Float32Array(0)

  const n = state.count
  const NBINS = 20
  const { px, py, pz, vx, vy, vz } = state

  // Measurement cylinder: center (cx, cy, cz), halfThick along Y, max radius
  const cx = config.measurePlaneX
  const cy = config.measurePlaneY
  const cz = config.measurePlaneZ
  const halfThick = config.measurePlaneThickness
  const maxRadius = config.measurePlaneRadius
  const maxR2 = maxRadius * maxRadius

  // Count particles inside cylinder and find actual max radius
  let actualMaxR = 0
  let inCyl = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(py[i] - cy) > halfThick) continue
    const dx = px[i] - cx
    const dz = pz[i] - cz
    const R2 = dx * dx + dz * dz
    if (R2 > maxR2) continue
    const R = Math.sqrt(R2)
    if (R > actualMaxR) actualMaxR = R
    inCyl++
  }
  if (actualMaxR < 1e-10 || inCyl < 2) return new Float32Array(0)

  const binWidth = actualMaxR / NBINS
  const binSum = new Float64Array(NBINS)
  const binCount = new Int32Array(NBINS)

  for (let i = 0; i < n; i++) {
    if (Math.abs(py[i] - cy) > halfThick) continue
    const dx = px[i] - cx
    const dz = pz[i] - cz
    const R2 = dx * dx + dz * dz
    if (R2 > maxR2) continue
    const R = Math.sqrt(R2)
    const bin = Math.min(Math.floor(R / binWidth), NBINS - 1)
    const v = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i])
    binSum[bin] += v
    binCount[bin]++
  }

  // Output: [r0, v0, r1, v1, ...] (pairs)
  const result = new Float32Array(NBINS * 2)
  for (let b = 0; b < NBINS; b++) {
    result[b * 2] = (b + 0.5) * binWidth * config.displayScale
    result[b * 2 + 1] = binCount[b] > 0 ? binSum[b] / binCount[b] : 0
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

function buildRenderState(): {
  positions: Float32Array
  velocities: Float32Array
  masses: Float32Array
  types: Uint8Array
} {
  if (!state) throw new Error('No state')
  const n = state.count
  const s = config.displayScale
  const positions = new Float32Array(n * 3)
  const velocities = new Float32Array(n * 3)
  const masses = new Float32Array(n)
  const types = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    const i3 = i * 3
    positions[i3] = state.px[i] * s
    positions[i3 + 1] = state.py[i] * s
    positions[i3 + 2] = state.pz[i] * s
    velocities[i3] = state.vx[i]
    velocities[i3 + 1] = state.vy[i]
    velocities[i3 + 2] = state.vz[i]
    masses[i] = state.mass[i]
    types[i] = state.ptype[i]
  }

  return { positions, velocities, masses, types }
}

function sendState(stepTime: number): void {
  const { positions, velocities, masses, types } = buildRenderState()

  // Compute densest mass center via 3D grid density estimation + moving average
  let barycenter: { x: number; y: number; z: number } | undefined
  if (config.measurePlaneAutoTrack && state) {
    const n = state.count
    const G = 8 // grid resolution per axis
    const G3 = G * G * G

    // Find bounding box
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const x = state.px[i], y = state.py[i], z = state.pz[i]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    const rangeX = (maxX - minX) || 1
    const rangeY = (maxY - minY) || 1
    const rangeZ = (maxZ - minZ) || 1

    // Bin particle masses into grid
    const grid = new Float64Array(G3)
    for (let i = 0; i < n; i++) {
      const ci = Math.min(G - 1, Math.floor(((state.px[i] - minX) / rangeX) * G))
      const cj = Math.min(G - 1, Math.floor(((state.py[i] - minY) / rangeY) * G))
      const ck = Math.min(G - 1, Math.floor(((state.pz[i] - minZ) / rangeZ) * G))
      grid[ci + cj * G + ck * G * G] += state.mass[i]
    }

    // Find densest cell
    let bestCell = 0, bestMass = -1
    for (let c = 0; c < G3; c++) {
      if (grid[c] > bestMass) { bestMass = grid[c]; bestCell = c }
    }
    const bi = bestCell % G
    const bj = Math.floor(bestCell / G) % G
    const bk = Math.floor(bestCell / (G * G))

    // Mass-weighted centroid of particles in densest cell + neighbors (3x3x3)
    let cx = 0, cy = 0, cz = 0, totalM = 0
    for (let i = 0; i < n; i++) {
      const ci = Math.min(G - 1, Math.floor(((state.px[i] - minX) / rangeX) * G))
      const cj = Math.min(G - 1, Math.floor(((state.py[i] - minY) / rangeY) * G))
      const ck = Math.min(G - 1, Math.floor(((state.pz[i] - minZ) / rangeZ) * G))
      if (Math.abs(ci - bi) <= 1 && Math.abs(cj - bj) <= 1 && Math.abs(ck - bk) <= 1) {
        const m = state.mass[i]
        cx += state.px[i] * m
        cy += state.py[i] * m
        cz += state.pz[i] * m
        totalM += m
      }
    }

    if (totalM > 0) {
      const inv = 1.0 / totalM
      const nx = cx * inv, ny = cy * inv, nz = cz * inv
      // Exponential moving average for smooth tracking
      const alpha = 0.15
      config.measurePlaneX += (nx - config.measurePlaneX) * alpha
      config.measurePlaneY += (ny - config.measurePlaneY) * alpha
      config.measurePlaneZ += (nz - config.measurePlaneZ) * alpha
      barycenter = { x: config.measurePlaneX, y: config.measurePlaneY, z: config.measurePlaneZ }
    }
  }

  const velocityProfile = computeVelocityProfile()

  // Build tracked particle info if selected
  let trackedInfo: { velocity: number; mass: number; age: number; ptype: number } | undefined
  if (trackedParticle >= 0 && trackedParticle < state!.count) {
    const i = trackedParticle
    const vx = state!.vx[i], vy = state!.vy[i], vz = state!.vz[i]
    trackedInfo = {
      velocity: Math.sqrt(vx * vx + vy * vy + vz * vz),
      mass: state!.mass[i],
      age: state!.age[i],
      ptype: state!.ptype[i],
    }
  }

  const response: WorkerResponse = {
    type: 'state',
    positions, velocities, masses, types,
    count: state!.count,
    stepTime,
    simTime,
    velocityProfile,
    trackedInfo,
    barycenter,
  }
  self.postMessage(response, [
    positions.buffer, velocities.buffer, masses.buffer,
    types.buffer, velocityProfile.buffer,
  ] as any)

  // Send trajectory update if tracking (throttled, copy not transfer)
  if (trackedParticle >= 0 && trajectoryBuffer.length >= 6 && trajectoryBuffer.length % 30 < 3) {
    const trajData = new Float32Array(trajectoryBuffer)
    const speedData = new Float32Array(trajectorySpeedBuffer)
    self.postMessage({
      type: 'trajectory',
      particleIndex: trackedParticle,
      positions: trajData,
      speeds: speedData,
    } as WorkerResponse)
  }
}

function simulationLoop(): void {
  if (!running || !state) return
  const t0 = performance.now()
  step()
  const stepTime = performance.now() - t0
  sendState(stepTime)
  frameId = setTimeout(simulationLoop, 0)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function initSimulation(cfg: SimulationConfig): void {
  config = { ...cfg }
  simTime = 0
  trackedParticle = -1
  trajectoryBuffer = []
  trajectorySpeedBuffer = []
  trajectoryStepCounter = 0

  if (config.icMode === 'cosmological') {
    initCosmological()
  } else {
    initGalaxy()
  }
}

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data

  switch (cmd.type) {
    case 'init':
      running = false
      if (frameId !== null) { clearTimeout(frameId); frameId = null }
      initSimulation(cmd.config)
      computeAccelerations()
      running = true
      self.postMessage({ type: 'ready' } as WorkerResponse)
      simulationLoop()
      break

    case 'step':
      if (state && !running) {
        const t0 = performance.now()
        step()
        sendState(performance.now() - t0)
      }
      break

    case 'pause':
      running = false
      if (frameId !== null) { clearTimeout(frameId); frameId = null }
      break

    case 'resume':
      if (state && !running) { running = true; simulationLoop() }
      break

    case 'updateConfig':
      if (cmd.config.timestep !== undefined) config.timestep = cmd.config.timestep
      if (cmd.config.softening !== undefined) config.softening = cmd.config.softening
      if (cmd.config.G !== undefined) config.G = cmd.config.G
      if (cmd.config.theta !== undefined) config.theta = cmd.config.theta
      if (cmd.config.stellarEvolution !== undefined) config.stellarEvolution = cmd.config.stellarEvolution
      if (cmd.config.snKickVelocity !== undefined) config.snKickVelocity = cmd.config.snKickVelocity
      if (cmd.config.measurePlaneX !== undefined) config.measurePlaneX = cmd.config.measurePlaneX
      if (cmd.config.measurePlaneY !== undefined) config.measurePlaneY = cmd.config.measurePlaneY
      if (cmd.config.measurePlaneZ !== undefined) config.measurePlaneZ = cmd.config.measurePlaneZ
      if (cmd.config.measurePlaneThickness !== undefined) config.measurePlaneThickness = cmd.config.measurePlaneThickness
      if (cmd.config.measurePlaneRadius !== undefined) config.measurePlaneRadius = cmd.config.measurePlaneRadius
      if (cmd.config.measurePlaneAutoTrack !== undefined) config.measurePlaneAutoTrack = cmd.config.measurePlaneAutoTrack
      if (cmd.config.darkMatterEnabled !== undefined) config.darkMatterEnabled = cmd.config.darkMatterEnabled
      if (cmd.config.dmHaloMass !== undefined) config.dmHaloMass = cmd.config.dmHaloMass
      if (cmd.config.dmScaleRadius !== undefined) config.dmScaleRadius = cmd.config.dmScaleRadius
      if (cmd.config.dmConcentration !== undefined) config.dmConcentration = cmd.config.dmConcentration
      break

    case 'getTrajectory':
      trackedParticle = cmd.particleIndex
      trajectoryBuffer = []
      trajectorySpeedBuffer = []
      trajectoryStepCounter = 0
      // Send current trajectory (empty initially)
      self.postMessage({
        type: 'trajectory',
        particleIndex: cmd.particleIndex,
        positions: new Float32Array(trajectoryBuffer),
        speeds: new Float32Array(trajectorySpeedBuffer),
      } as WorkerResponse)
      break
  }
}

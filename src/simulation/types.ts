/**
 * Core types for the N-body simulation.
 *
 * Two IC modes:
 *   1. Galaxy: disk + bulge + SMBH (Hénon N-body units)
 *   2. Cosmological: uniform block with CMB-like perturbations → structure formation
 *
 * Features:
 *   - Barnes-Hut octree O(n log n) gravity
 *   - Stellar evolution: aging → supernova → stellar black hole
 *   - Mass heterogeneity (power-law IMF)
 *   - Particle type tracking (star / black_hole / smbh)
 */

// ─── Particle types ──────────────────────────────────────────────────────────

export const enum ParticleType {
  STAR = 0,
  BLACK_HOLE = 1,
  SMBH = 2,
}

// ─── IC modes ────────────────────────────────────────────────────────────────

export type ICMode = 'galaxy' | 'cosmological'

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SimulationConfig {
  particleCount: number
  G: number
  timestep: number
  softening: number
  displayScale: number

  // ─── IC mode ───────────────────────────────────────────────────────────
  icMode: ICMode

  // ─── Galaxy IC params ──────────────────────────────────────────────────
  scaleLength: number
  scaleHeightRatio: number
  maxRadiusFactor: number
  bulgeFraction: number
  bulgeScaleRatio: number
  smbhMassFraction: number

  // ─── Cosmological IC params ────────────────────────────────────────────
  /** Side length of the cubic volume */
  boxSize: number
  /** RMS amplitude of initial density perturbations (δρ/ρ) */
  perturbationAmplitude: number
  /** Hubble-like expansion rate (0 = no expansion) */
  hubbleParam: number

  // ─── Mass distribution ─────────────────────────────────────────────────
  imfExponent: number
  massRatioMin: number
  massRatioMax: number

  // ─── Barnes-Hut ────────────────────────────────────────────────────────
  /** Opening angle θ: 0 = exact, 0.5-0.7 = typical, 1.0 = fast/approx */
  theta: number

  // ─── Stellar evolution ─────────────────────────────────────────────────
  /** Enable supernova and BH formation */
  stellarEvolution: boolean
  /** Supernova mass threshold: particles above this (in N-body mass) explode */
  snMassThreshold: number
  /** Supernova velocity kick magnitude (imparted to neighbors) */
  snKickVelocity: number

  // ─── Dark Matter halo (NFW profile) ───────────────────────────────────
  /** Enable dark matter halo potential */
  darkMatterEnabled: boolean
  /** Total DM halo mass (simulation mass units, relative to baryonic) */
  dmHaloMass: number
  /** NFW scale radius r_s (simulation length units) */
  dmScaleRadius: number
  /** NFW concentration c = r_vir / r_s */
  dmConcentration: number

  // ─── UI/Render flags ───────────────────────────────────────────────────
  showGrid: boolean
  /** Render grid as solid semi-transparent surface instead of wireframe */
  gridSolid: boolean

  // ─── Velocity measurement plane (cylinder) ─────────────────────────────
  /** X position of measurement plane center in simulation units */
  measurePlaneX: number
  /** Y position of measurement plane center in simulation units */
  measurePlaneY: number
  /** Z position of measurement plane center in simulation units */
  measurePlaneZ: number
  /** Half-thickness of cylinder (sim units) — stars within are sampled */
  measurePlaneThickness: number
  /** Radius of measurement cylinder (sim units) */
  measurePlaneRadius: number
  /** Auto-track center of mass for cylinder position */
  measurePlaneAutoTrack: boolean
  /** Show the measurement plane in the 3D view */
  showMeasurePlane: boolean
}

// ─── Simulation state ────────────────────────────────────────────────────────

export interface SimulationState {
  px: Float64Array
  py: Float64Array
  pz: Float64Array
  vx: Float64Array
  vy: Float64Array
  vz: Float64Array
  mass: Float64Array
  /** Per-particle type: 0=star, 1=black_hole, 2=smbh */
  ptype: Uint8Array
  /** Per-particle age in simulation time units */
  age: Float64Array
  /** Per-particle metallicity [0=primordial, 1=fully enriched] */
  metallicity: Float64Array
  /** Per-particle thermal energy (heat from SN feedback, decays over time) */
  heat: Float64Array
  count: number
}

// ─── Worker messages ─────────────────────────────────────────────────────────

export type WorkerCommand =
  | { type: 'init'; config: SimulationConfig }
  | { type: 'step' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'updateConfig'; config: Partial<SimulationConfig> }
  | { type: 'getTrajectory'; particleIndex: number }

export type WorkerResponse =
  | {
      type: 'state'
      positions: Float32Array
      velocities: Float32Array
      masses: Float32Array
      types: Uint8Array
      count: number
      stepTime: number
      simTime: number
      /** Velocity profile: [radius0, avgV0, radius1, avgV1, ...] */
      velocityProfile: Float32Array
      /** Tracked particle info (if any selected) */
      trackedInfo?: { velocity: number; mass: number; age: number; ptype: number }
      /** Mass-weighted barycenter (sim units) */
      barycenter?: { x: number; y: number; z: number }
    }
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'trajectory'; particleIndex: number; positions: Float32Array; speeds: Float32Array }
  | { type: 'supernova'; x: number; y: number; z: number; mass: number }

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SimulationConfig = {
  particleCount: 3000,
  G: 1.0,
  timestep: 0.005,
  softening: 0.15,
  displayScale: 30.0,

  icMode: 'galaxy',

  scaleLength: 1.0,
  scaleHeightRatio: 0.1,
  maxRadiusFactor: 5.0,
  bulgeFraction: 0.25,
  bulgeScaleRatio: 0.2,
  smbhMassFraction: 0.005,

  boxSize: 10.0,
  perturbationAmplitude: 0.05,
  hubbleParam: 0.0,

  imfExponent: 2.0,
  massRatioMin: 0.05,
  massRatioMax: 20.0,

  theta: 0.6,

  stellarEvolution: true,
  snMassThreshold: 0.002,
  snKickVelocity: 0.5,

  darkMatterEnabled: false,
  dmHaloMass: 10.0,
  dmScaleRadius: 2.0,
  dmConcentration: 10.0,

  showGrid: true,
  gridSolid: false,

  measurePlaneX: 0.0,
  measurePlaneY: 0.0,
  measurePlaneZ: 0.0,
  measurePlaneThickness: 0.5,
  measurePlaneRadius: 6.0,
  measurePlaneAutoTrack: true,
  showMeasurePlane: true,
}

<script setup lang="ts">
/**
 * Control panel for the N-body simulation.
 * Supports Galaxy and Cosmological IC modes.
 * Each parameter has a ? tooltip with pedagogical explanation.
 */
import { ref, computed, onMounted } from 'vue'
import type { SimulationConfig, ICMode } from '../simulation/types'
import { DEFAULT_CONFIG } from '../simulation/types'

// Prevent scroll from changing range slider values
onMounted(() => {
  document.querySelector('.control-panel')?.addEventListener('wheel', (e) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range') {
      ;(target as HTMLElement).blur()
    }
  }, { passive: true })
})

const props = defineProps<{
  config: SimulationConfig
  isRunning: boolean
  isReady: boolean
  fps: number
  stepTime: number
  simTime: number
  trackedParticle: number
  trackedInfo: { velocity: number; mass: number; age: number; ptype: number } | null
  isFollowing: boolean
}>()

const emit = defineEmits<{
  togglePlayPause: []
  restart: [config: Partial<SimulationConfig>]
  updateConfig: [config: Partial<SimulationConfig>]
  singleStep: []
  resetView: []
}>()

const stepTimeDisplay = computed(() => props.stepTime.toFixed(2))
const particleCountDisplay = computed(() => props.config.particleCount.toLocaleString())
const simTimeDisplay = computed(() => props.simTime.toFixed(2))

const particleTypeLabel = computed(() => {
  if (!props.trackedInfo) return ''
  switch (props.trackedInfo.ptype) {
    case 2: return 'SMBH'
    case 1: return 'Trou Noir'
    default: return 'Etoile'
  }
})
const particleTypeClass = computed(() => {
  if (!props.trackedInfo) return ''
  switch (props.trackedInfo.ptype) {
    case 2: return 'type-smbh'
    case 1: return 'type-bh'
    default: return 'type-star'
  }
})

// ─── Tooltip system ──────────────────────────────────────────────────────────

const activeTooltip = ref<string | null>(null)

function toggleTooltip(id: string): void {
  activeTooltip.value = activeTooltip.value === id ? null : id
}

const tooltips: Record<string, { title: string; text: string }> = {
  particles: {
    title: 'Nombre de particules',
    text: `Chaque particule represente une "population stellaire" de milliers d'etoiles. Plus il y a de particules, plus c'est precis mais plus c'est lent. L'octree Barnes-Hut permet d'aller a O(n log n) au lieu de O(n²).`,
  },
  G: {
    title: 'Constante gravitationnelle G',
    text: `En unites N-body (Henon), G=1 par convention. Augmenter G = gravite plus forte, galaxie plus compacte.`,
  },
  timestep: {
    title: 'Pas de temps (dt)',
    text: `L'intervalle entre chaque calcul. Plus dt est petit, plus les orbites sont precises, mais plus c'est lent.`,
  },
  softening: {
    title: 'Adoucissement de Plummer (ε)',
    text: `Remplace r² par (r² + ε²) pour eviter la singularite quand deux particules sont proches. Represente la taille finie des populations stellaires.`,
  },
  theta: {
    title: 'Angle d\'ouverture Barnes-Hut (θ)',
    text: `Controle la precision de l'octree. θ=0 = force exacte O(n²). θ=0.5 = bon compromis precision/vitesse. θ=1.0 = rapide mais approximatif. L'octree regroupe les particules distantes en "pseudo-particules" de masse combinee.`,
  },
  scaleLength: {
    title: 'Longueur d\'echelle Rd',
    text: `Taille du disque galactique. La densite suit Σ(R) ∝ exp(-R/Rd). Pour la Voie Lactee, Rd ≈ 2.5 kpc.`,
  },
  scaleHeight: {
    title: 'Epaisseur du disque z₀/Rd',
    text: `Ratio epaisseur/rayon du disque. Les galaxies spirales sont des disques fins: ratio typique ~0.1.`,
  },
  bulgeFraction: {
    title: 'Fraction du bulbe',
    text: `Le bulbe galactique: concentration spheroidale d'etoiles vieilles au centre. Typiquement 20-30% de la masse stellaire. Profil de Hernquist.`,
  },
  bulgeScale: {
    title: 'Taille du bulbe (a/Rd)',
    text: `Rayon caracteristique du bulbe en fraction du rayon du disque. 0.1 = tres concentre, 0.3 = plus etale.`,
  },
  smbh: {
    title: 'Trou noir supermassif (SMBH)',
    text: `Chaque grande galaxie a un trou noir central. Masse ≈ 0.2-0.5% du bulbe (relation de Magorrian). Represente comme un point sombre avec disque d'accretion lumineux.`,
  },
  imfExponent: {
    title: 'Exposant IMF (α)',
    text: `Fonction de Masse Initiale: dN/dm ∝ m^(-α). Salpeter α ≈ 2.35. Plus α est grand, plus il y a de naines rouges par rapport aux etoiles massives bleues.`,
  },
  stellarEvolution: {
    title: 'Evolution stellaire',
    text: `Active les supernovae et la formation de trous noirs stellaires. Les etoiles massives vivent moins longtemps (t ∝ m^(-2.5)). Quand elles explosent en supernova, elles ejectent de la masse et laissent un trou noir qui conserve ~40% de la masse.`,
  },
  boxSize: {
    title: 'Taille du volume',
    text: `Cote du cube initial. Plus c'est grand, plus les structures emergentes seront a grande echelle. Correspond a une portion d'univers primordial.`,
  },
  perturbation: {
    title: 'Amplitude des perturbations',
    text: `Fluctuations initiales de densite, analogues aux anisotropies du CMB (δρ/ρ ≈ 10⁻⁵ dans la realite, ici amplifie pour voir l'effondrement rapidement). Ces petites sur-densites s'effondrent sous la gravite pour former filaments, halos, puis galaxies.`,
  },
  icMode: {
    title: 'Mode de conditions initiales',
    text: `"Galaxie" = disque + bulbe + SMBH pre-formes. "Cosmologique" = bloc uniforme avec perturbations type CMB, on observe l'emergence spontanee de structures par effondrement gravitationnel.`,
  },
}

// ─── Slider handlers ─────────────────────────────────────────────────────────

function onParticleCountChange(e: Event): void {
  emit('restart', { particleCount: parseInt((e.target as HTMLInputElement).value) })
}
function onGChange(e: Event): void {
  emit('updateConfig', { G: parseFloat((e.target as HTMLInputElement).value) })
}
function onTimestepChange(e: Event): void {
  emit('updateConfig', { timestep: parseFloat((e.target as HTMLInputElement).value) })
}
function onSofteningChange(e: Event): void {
  emit('updateConfig', { softening: parseFloat((e.target as HTMLInputElement).value) })
}
function onThetaChange(e: Event): void {
  emit('updateConfig', { theta: parseFloat((e.target as HTMLInputElement).value) })
}
function onScaleLengthChange(e: Event): void {
  emit('restart', { scaleLength: parseFloat((e.target as HTMLInputElement).value) })
}
function onScaleHeightChange(e: Event): void {
  emit('restart', { scaleHeightRatio: parseFloat((e.target as HTMLInputElement).value) })
}
function onBulgeFractionChange(e: Event): void {
  emit('restart', { bulgeFraction: parseFloat((e.target as HTMLInputElement).value) })
}
function onBulgeScaleChange(e: Event): void {
  emit('restart', { bulgeScaleRatio: parseFloat((e.target as HTMLInputElement).value) })
}
function onSmbhChange(e: Event): void {
  emit('restart', { smbhMassFraction: parseFloat((e.target as HTMLInputElement).value) })
}
function onImfChange(e: Event): void {
  emit('restart', { imfExponent: parseFloat((e.target as HTMLInputElement).value) })
}
function onBoxSizeChange(e: Event): void {
  emit('restart', { boxSize: parseFloat((e.target as HTMLInputElement).value) })
}
function onPerturbationChange(e: Event): void {
  emit('restart', { perturbationAmplitude: parseFloat((e.target as HTMLInputElement).value) })
}
function onICModeChange(mode: ICMode): void {
  emit('restart', { icMode: mode })
}
function onGridToggle(e: Event): void {
  emit('updateConfig', { showGrid: (e.target as HTMLInputElement).checked })
}
function onGridSolidToggle(e: Event): void {
  emit('updateConfig', { gridSolid: (e.target as HTMLInputElement).checked })
}
const dmHaloVisible = ref(true)
function onDarkMatterToggle(e: Event): void {
  emit('updateConfig', { darkMatterEnabled: (e.target as HTMLInputElement).checked })
}
function onDmHaloVisToggle(e: Event): void {
  dmHaloVisible.value = (e.target as HTMLInputElement).checked
  emit('updateConfig', { dmHaloVisible: dmHaloVisible.value } as any)
}
function onDmHaloMass(e: Event): void {
  emit('updateConfig', { dmHaloMass: parseFloat((e.target as HTMLInputElement).value) })
}
function onDmScaleRadius(e: Event): void {
  emit('updateConfig', { dmScaleRadius: parseFloat((e.target as HTMLInputElement).value) })
}
function onDmConcentration(e: Event): void {
  emit('updateConfig', { dmConcentration: parseFloat((e.target as HTMLInputElement).value) })
}
function onStellarEvolutionToggle(e: Event): void {
  emit('updateConfig', { stellarEvolution: (e.target as HTMLInputElement).checked })
}
function onMeasurePlaneToggle(e: Event): void {
  emit('updateConfig', { showMeasurePlane: (e.target as HTMLInputElement).checked })
}
function onMeasurePlaneX(e: Event): void {
  emit('updateConfig', { measurePlaneX: parseFloat((e.target as HTMLInputElement).value) })
}
function onMeasurePlaneY(e: Event): void {
  emit('updateConfig', { measurePlaneY: parseFloat((e.target as HTMLInputElement).value) })
}
function onMeasurePlaneZ(e: Event): void {
  emit('updateConfig', { measurePlaneZ: parseFloat((e.target as HTMLInputElement).value) })
}
function onMeasurePlaneThickness(e: Event): void {
  emit('updateConfig', { measurePlaneThickness: parseFloat((e.target as HTMLInputElement).value) })
}
function onMeasurePlaneRadius(e: Event): void {
  emit('updateConfig', { measurePlaneRadius: parseFloat((e.target as HTMLInputElement).value) })
}
function onMeasurePlaneAutoTrack(e: Event): void {
  emit('updateConfig', { measurePlaneAutoTrack: (e.target as HTMLInputElement).checked })
}

// ─── Utility: random float in [min, max] with optional step snap ────────
function randRange(min: number, max: number, step?: number): number {
  let v = min + Math.random() * (max - min)
  if (step) v = Math.round(v / step) * step
  return parseFloat(v.toFixed(6))
}

function randomizeParams(): void {
  const mode: ICMode = Math.random() > 0.5 ? 'galaxy' : 'cosmological'
  const randomConfig: Partial<SimulationConfig> = {
    icMode: mode,
    particleCount: randRange(500, 6000, 100),
    G: randRange(0.3, 3.0, 0.1),
    timestep: randRange(0.002, 0.015, 0.001),
    softening: randRange(0.02, 0.3, 0.01),
    theta: randRange(0.3, 1.2, 0.05),
    imfExponent: randRange(1.2, 3.0, 0.1),
    stellarEvolution: Math.random() > 0.3,
    // Galaxy params
    scaleLength: randRange(0.5, 2.5, 0.1),
    scaleHeightRatio: randRange(0.02, 0.25, 0.01),
    bulgeFraction: randRange(0.0, 0.45, 0.05),
    bulgeScaleRatio: randRange(0.05, 0.45, 0.05),
    smbhMassFraction: randRange(0.002, 0.04, 0.001),
    // Cosmo params
    boxSize: randRange(5, 25, 1),
    perturbationAmplitude: randRange(0.01, 0.2, 0.005),
  }
  emit('restart', randomConfig)
}

function resetDefaults(): void {
  const { measurePlaneAutoTrack, showMeasurePlane, showGrid, measurePlaneX, measurePlaneY, measurePlaneZ, measurePlaneRadius, measurePlaneThickness, ...physicsDefaults } = DEFAULT_CONFIG
  emit('restart', physicsDefaults)
}
</script>

<template>
  <div class="control-panel" @click.self="activeTooltip = null">
    <div class="panel-header">
      <h2>ORBITAL</h2>
      <span class="subtitle">N-Body Simulation</span>
    </div>

    <!-- Stats -->
    <div class="stats-section">
      <div class="stat">
        <span class="stat-label">FPS</span>
        <span class="stat-value" :class="{ warn: fps < 30 }">{{ fps }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Step</span>
        <span class="stat-value">{{ stepTimeDisplay }}ms</span>
      </div>
      <div class="stat">
        <span class="stat-label">Bodies</span>
        <span class="stat-value">{{ particleCountDisplay }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">t</span>
        <span class="stat-value">{{ simTimeDisplay }}</span>
      </div>
    </div>

    <!-- Playback Controls -->
    <div class="controls-section">
      <button class="btn btn-primary" @click="emit('togglePlayPause')" :disabled="!isReady">
        {{ isRunning ? '⏸ Pause' : '▶ Play' }}
      </button>
      <button class="btn" @click="emit('singleStep')" :disabled="isRunning || !isReady">
        ⏭ Step
      </button>
      <button class="btn" @click="emit('resetView')" :disabled="!isReady">
        🎯 Reset vue
      </button>
    </div>
    <div class="controls-section">
      <button class="btn btn-accent" @click="randomizeParams">
        🎲 Random
      </button>
      <button class="btn btn-danger" @click="resetDefaults">
        ↻ Défauts
      </button>
    </div>

    <!-- IC Mode selector -->
    <div class="section-label">
      MODE <button class="help-btn" @click.stop="toggleTooltip('icMode')">?</button>
    </div>
    <Transition name="tooltip"><div v-if="activeTooltip === 'icMode'" class="tooltip-bubble"><strong>{{ tooltips.icMode.title }}</strong><p>{{ tooltips.icMode.text }}</p></div></Transition>
    <div class="mode-selector">
      <button class="mode-btn" :class="{ active: config.icMode === 'galaxy' }" @click="onICModeChange('galaxy')">
        🌀 Galaxie
      </button>
      <button class="mode-btn" :class="{ active: config.icMode === 'cosmological' }" @click="onICModeChange('cosmological')">
        🌌 Cosmologique
      </button>
    </div>

    <!-- Physics Parameters -->
    <div class="section-label">PHYSICS</div>
    <div class="sliders-section">
      <div class="slider-group">
        <label>
          <span class="slider-label">Particles <button class="help-btn" @click.stop="toggleTooltip('particles')">?</button></span>
          <span class="slider-value">{{ config.particleCount }}</span>
        </label>
        <input type="range" min="200" max="8000" step="100" :value="config.particleCount" @change="onParticleCountChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'particles'" class="tooltip-bubble"><strong>{{ tooltips.particles.title }}</strong><p>{{ tooltips.particles.text }}</p></div></Transition>
      </div>

      <div class="slider-group">
        <label>
          <span class="slider-label">G <button class="help-btn" @click.stop="toggleTooltip('G')">?</button></span>
          <span class="slider-value">{{ config.G.toFixed(2) }}</span>
        </label>
        <input type="range" min="0.1" max="5.0" step="0.1" :value="config.G" @change="onGChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'G'" class="tooltip-bubble"><strong>{{ tooltips.G.title }}</strong><p>{{ tooltips.G.text }}</p></div></Transition>
      </div>

      <div class="slider-group">
        <label>
          <span class="slider-label">Timestep (dt) <button class="help-btn" @click.stop="toggleTooltip('timestep')">?</button></span>
          <span class="slider-value">{{ config.timestep.toFixed(4) }}</span>
        </label>
        <input type="range" min="0.001" max="0.02" step="0.001" :value="config.timestep" @change="onTimestepChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'timestep'" class="tooltip-bubble"><strong>{{ tooltips.timestep.title }}</strong><p>{{ tooltips.timestep.text }}</p></div></Transition>
      </div>

      <div class="slider-group">
        <label>
          <span class="slider-label">Softening (ε) <button class="help-btn" @click.stop="toggleTooltip('softening')">?</button></span>
          <span class="slider-value">{{ config.softening.toFixed(3) }}</span>
        </label>
        <input type="range" min="0.01" max="0.5" step="0.01" :value="config.softening" @change="onSofteningChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'softening'" class="tooltip-bubble"><strong>{{ tooltips.softening.title }}</strong><p>{{ tooltips.softening.text }}</p></div></Transition>
      </div>

      <div class="slider-group">
        <label>
          <span class="slider-label">Barnes-Hut θ <button class="help-btn" @click.stop="toggleTooltip('theta')">?</button></span>
          <span class="slider-value">{{ config.theta.toFixed(2) }}</span>
        </label>
        <input type="range" min="0" max="1.5" step="0.05" :value="config.theta" @change="onThetaChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'theta'" class="tooltip-bubble"><strong>{{ tooltips.theta.title }}</strong><p>{{ tooltips.theta.text }}</p></div></Transition>
      </div>
    </div>

    <!-- Galaxy Structure (only in galaxy mode) -->
    <template v-if="config.icMode === 'galaxy'">
      <div class="section-label">GALAXY STRUCTURE</div>
      <div class="sliders-section">
        <div class="slider-group">
          <label>
            <span class="slider-label">Scale length (R<sub>d</sub>) <button class="help-btn" @click.stop="toggleTooltip('scaleLength')">?</button></span>
            <span class="slider-value">{{ config.scaleLength.toFixed(1) }}</span>
          </label>
          <input type="range" min="0.5" max="3.0" step="0.1" :value="config.scaleLength" @change="onScaleLengthChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'scaleLength'" class="tooltip-bubble"><strong>{{ tooltips.scaleLength.title }}</strong><p>{{ tooltips.scaleLength.text }}</p></div></Transition>
        </div>

        <div class="slider-group">
          <label>
            <span class="slider-label">Height (z₀/R<sub>d</sub>) <button class="help-btn" @click.stop="toggleTooltip('scaleHeight')">?</button></span>
            <span class="slider-value">{{ config.scaleHeightRatio.toFixed(2) }}</span>
          </label>
          <input type="range" min="0.01" max="0.3" step="0.01" :value="config.scaleHeightRatio" @change="onScaleHeightChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'scaleHeight'" class="tooltip-bubble"><strong>{{ tooltips.scaleHeight.title }}</strong><p>{{ tooltips.scaleHeight.text }}</p></div></Transition>
        </div>

        <div class="slider-group">
          <label>
            <span class="slider-label">Bulge fraction <button class="help-btn" @click.stop="toggleTooltip('bulgeFraction')">?</button></span>
            <span class="slider-value">{{ (config.bulgeFraction * 100).toFixed(0) }}%</span>
          </label>
          <input type="range" min="0" max="0.5" step="0.05" :value="config.bulgeFraction" @change="onBulgeFractionChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'bulgeFraction'" class="tooltip-bubble"><strong>{{ tooltips.bulgeFraction.title }}</strong><p>{{ tooltips.bulgeFraction.text }}</p></div></Transition>
        </div>

        <div class="slider-group">
          <label>
            <span class="slider-label">Bulge scale (a/R<sub>d</sub>) <button class="help-btn" @click.stop="toggleTooltip('bulgeScale')">?</button></span>
            <span class="slider-value">{{ config.bulgeScaleRatio.toFixed(2) }}</span>
          </label>
          <input type="range" min="0.05" max="0.5" step="0.05" :value="config.bulgeScaleRatio" @change="onBulgeScaleChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'bulgeScale'" class="tooltip-bubble"><strong>{{ tooltips.bulgeScale.title }}</strong><p>{{ tooltips.bulgeScale.text }}</p></div></Transition>
        </div>

        <div class="slider-group">
          <label>
            <span class="slider-label">SMBH mass <button class="help-btn" @click.stop="toggleTooltip('smbh')">?</button></span>
            <span class="slider-value">{{ (config.smbhMassFraction * 100).toFixed(1) }}%</span>
          </label>
          <input type="range" min="0.001" max="0.05" step="0.001" :value="config.smbhMassFraction" @change="onSmbhChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'smbh'" class="tooltip-bubble"><strong>{{ tooltips.smbh.title }}</strong><p>{{ tooltips.smbh.text }}</p></div></Transition>
        </div>
      </div>
    </template>

    <!-- Cosmological params (only in cosmo mode) -->
    <template v-if="config.icMode === 'cosmological'">
      <div class="section-label">COSMOLOGICAL IC</div>
      <div class="sliders-section">
        <div class="slider-group">
          <label>
            <span class="slider-label">Box size <button class="help-btn" @click.stop="toggleTooltip('boxSize')">?</button></span>
            <span class="slider-value">{{ config.boxSize.toFixed(1) }}</span>
          </label>
          <input type="range" min="3" max="30" step="1" :value="config.boxSize" @change="onBoxSizeChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'boxSize'" class="tooltip-bubble"><strong>{{ tooltips.boxSize.title }}</strong><p>{{ tooltips.boxSize.text }}</p></div></Transition>
        </div>

        <div class="slider-group">
          <label>
            <span class="slider-label">Perturbation δρ/ρ <button class="help-btn" @click.stop="toggleTooltip('perturbation')">?</button></span>
            <span class="slider-value">{{ config.perturbationAmplitude.toFixed(3) }}</span>
          </label>
          <input type="range" min="0.005" max="0.3" step="0.005" :value="config.perturbationAmplitude" @change="onPerturbationChange" />
          <Transition name="tooltip"><div v-if="activeTooltip === 'perturbation'" class="tooltip-bubble"><strong>{{ tooltips.perturbation.title }}</strong><p>{{ tooltips.perturbation.text }}</p></div></Transition>
        </div>
      </div>
    </template>

    <!-- Mass Distribution -->
    <div class="section-label">MASS / SPECTRAL TYPE</div>
    <div class="sliders-section">
      <div class="slider-group">
        <label>
          <span class="slider-label">IMF exponent (α) <button class="help-btn" @click.stop="toggleTooltip('imfExponent')">?</button></span>
          <span class="slider-value">{{ config.imfExponent.toFixed(1) }}</span>
        </label>
        <input type="range" min="1.0" max="3.5" step="0.1" :value="config.imfExponent" @change="onImfChange" />
        <Transition name="tooltip"><div v-if="activeTooltip === 'imfExponent'" class="tooltip-bubble"><strong>{{ tooltips.imfExponent.title }}</strong><p>{{ tooltips.imfExponent.text }}</p></div></Transition>
      </div>

      <!-- Spectral Legend -->
      <div class="spectral-legend">
        <span class="legend-label">Type spectral:</span>
        <div class="legend-bar">
          <span class="legend-m">M</span>
          <span class="legend-k">K</span>
          <span class="legend-g">G</span>
          <span class="legend-f">F</span>
          <span class="legend-ob">O/B</span>
        </div>
        <div class="legend-desc">
          <span>Naines rouges</span>
          <span>Etoiles bleues</span>
        </div>
      </div>
    </div>

    <!-- Stellar Evolution & Display -->
    <div class="section-label">OPTIONS</div>
    <div class="options-section">
      <label class="checkbox-row">
        <input type="checkbox" :checked="config.stellarEvolution" @change="onStellarEvolutionToggle" />
        <span>Supernovae / Trous noirs <button class="help-btn" @click.stop="toggleTooltip('stellarEvolution')">?</button></span>
      </label>
      <Transition name="tooltip"><div v-if="activeTooltip === 'stellarEvolution'" class="tooltip-bubble"><strong>{{ tooltips.stellarEvolution.title }}</strong><p>{{ tooltips.stellarEvolution.text }}</p></div></Transition>

      <label class="checkbox-row">
        <input type="checkbox" :checked="config.showGrid" @change="onGridToggle" />
        <span>Grille de reference</span>
      </label>

      <label class="checkbox-row">
        <input type="checkbox" :checked="config.gridSolid" @change="onGridSolidToggle" :disabled="!config.showGrid" />
        <span>Surface pleine</span>
      </label>

      <label class="checkbox-row">
        <input type="checkbox" :checked="config.showMeasurePlane" @change="onMeasurePlaneToggle" />
        <span>Plan de mesure velocite</span>
      </label>
    </div>

    <!-- Dark Matter halo -->
    <div class="section-label">MATIERE NOIRE (NFW)</div>
    <div class="param-group">
      <label class="checkbox-row">
        <input type="checkbox" :checked="config.darkMatterEnabled" @change="onDarkMatterToggle" />
        <span>Activer le halo de matiere noire</span>
      </label>
      <label v-if="config.darkMatterEnabled" class="checkbox-row">
        <input type="checkbox" :checked="dmHaloVisible" @change="onDmHaloVisToggle" />
        <span>Afficher le halo</span>
      </label>
      <div v-if="config.darkMatterEnabled" class="slider-row">
        <label>Masse halo</label>
        <input type="range" min="0.5" max="100" step="0.5" :value="config.dmHaloMass" @input="onDmHaloMass" />
        <span class="value">{{ config.dmHaloMass.toFixed(1) }}</span>
      </div>
      <div v-if="config.darkMatterEnabled" class="slider-row">
        <label>Rayon d'echelle r<sub>s</sub></label>
        <input type="range" min="0.1" max="10" step="0.1" :value="config.dmScaleRadius" @input="onDmScaleRadius" />
        <span class="value">{{ config.dmScaleRadius.toFixed(1) }}</span>
      </div>
      <div v-if="config.darkMatterEnabled" class="slider-row">
        <label>Concentration c</label>
        <input type="range" min="1" max="30" step="0.5" :value="config.dmConcentration" @input="onDmConcentration" />
        <span class="value">{{ config.dmConcentration.toFixed(1) }}</span>
      </div>
    </div>

    <!-- Measurement Plane controls -->
    <div v-if="config.showMeasurePlane" class="section-label">CYLINDRE DE MESURE</div>
    <div v-if="config.showMeasurePlane" class="param-group">
      <label class="checkbox-row">
        <input type="checkbox" :checked="config.measurePlaneAutoTrack" @change="onMeasurePlaneAutoTrack" />
        <span>Suivre le barycentre</span>
      </label>
      <div class="slider-row" :class="{ disabled: config.measurePlaneAutoTrack }">
        <label>Position X</label>
        <input type="range" min="-5" max="5" step="0.05" :value="config.measurePlaneX" :disabled="config.measurePlaneAutoTrack" @input="onMeasurePlaneX" />
        <span class="value">{{ config.measurePlaneX.toFixed(2) }}</span>
      </div>
      <div class="slider-row" :class="{ disabled: config.measurePlaneAutoTrack }">
        <label>Position Y</label>
        <input type="range" min="-5" max="5" step="0.05" :value="config.measurePlaneY" :disabled="config.measurePlaneAutoTrack" @input="onMeasurePlaneY" />
        <span class="value">{{ config.measurePlaneY.toFixed(2) }}</span>
      </div>
      <div class="slider-row" :class="{ disabled: config.measurePlaneAutoTrack }">
        <label>Position Z</label>
        <input type="range" min="-5" max="5" step="0.05" :value="config.measurePlaneZ" :disabled="config.measurePlaneAutoTrack" @input="onMeasurePlaneZ" />
        <span class="value">{{ config.measurePlaneZ.toFixed(2) }}</span>
      </div>
      <div class="slider-row">
        <label>Rayon</label>
        <input type="range" min="0.5" max="10" step="0.1" :value="config.measurePlaneRadius" @input="onMeasurePlaneRadius" />
        <span class="value">{{ config.measurePlaneRadius.toFixed(1) }}</span>
      </div>
      <div class="slider-row">
        <label>Epaisseur</label>
        <input type="range" min="0.05" max="2.0" step="0.05" :value="config.measurePlaneThickness" @input="onMeasurePlaneThickness" />
        <span class="value">±{{ config.measurePlaneThickness.toFixed(2) }}</span>
      </div>
    </div>

    <!-- Selected particle info -->
    <div v-if="trackedParticle >= 0" class="tracked-info">
      <template v-if="isFollowing">
        📷 Camera suit Particule #{{ trackedParticle }}
        <br><small>F ou Echap pour arreter le suivi</small>
      </template>
      <template v-else>
        🎯 Particule #{{ trackedParticle }} selectionnee
        <br><small>F: suivre · Clic droit ou Echap: désélectionner</small>
      </template>
      <div v-if="trackedInfo" class="particle-stats">
        <span class="stat-badge" :class="particleTypeClass">{{ particleTypeLabel }}</span>
        <span class="stat">⚡ {{ trackedInfo.velocity.toFixed(4) }}</span>
        <span class="stat">⚖ {{ (trackedInfo.mass * 1e4).toFixed(2) }}</span>
        <span class="stat">🕐 {{ trackedInfo.age.toFixed(2) }}</span>
      </div>
    </div>

    <!-- Info -->
    <div class="info-section">
      <p>🖱 Drag: rotate · Scroll: zoom · DblClick: select · Clic droit: déselect · Space: play/pause · F: follow · Echap: tout annuler</p>
      <p class="tech-note">Barnes-Hut octree · Velocity Verlet</p>
    </div>
  </div>
</template>

<style scoped>
.control-panel {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 290px;
  background: rgba(10, 10, 30, 0.88);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(100, 120, 255, 0.12);
  border-radius: 12px;
  padding: 20px;
  color: #c8cce0;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px;
  z-index: 100;
  user-select: none;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}

.panel-header h2 {
  margin: 0 0 2px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 4px;
  color: #8090ff;
}
.subtitle { font-size: 10px; color: #6670a0; letter-spacing: 1px; }

.stats-section {
  display: flex; gap: 8px; margin: 16px 0; padding: 10px;
  background: rgba(20, 20, 50, 0.5); border-radius: 8px;
}
.stat { display: flex; flex-direction: column; align-items: center; flex: 1; }
.stat-label { font-size: 9px; text-transform: uppercase; color: #5560a0; letter-spacing: 1px; }
.stat-value { font-size: 14px; font-weight: 700; color: #a0b0ff; }
.stat-value.warn { color: #ff8060; }

.controls-section { display: flex; gap: 8px; margin-bottom: 16px; }

.btn {
  flex: 1; padding: 8px 4px;
  border: 1px solid rgba(100, 120, 255, 0.2); border-radius: 6px;
  background: rgba(30, 30, 70, 0.6); color: #a0b0ff;
  font-family: inherit; font-size: 11px; cursor: pointer;
  transition: all 0.15s ease;
}
.btn:hover:not(:disabled) { background: rgba(60, 60, 120, 0.6); border-color: rgba(100, 120, 255, 0.4); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: rgba(60, 60, 180, 0.4); border-color: rgba(100, 120, 255, 0.3); color: #c0d0ff; }
.btn-danger { border-color: rgba(255, 100, 80, 0.2); color: #ff9080; }
.btn-danger:hover:not(:disabled) { background: rgba(120, 30, 30, 0.4); }
.btn-accent { border-color: rgba(255, 200, 60, 0.25); color: #ffd060; }
.btn-accent:hover:not(:disabled) { background: rgba(120, 100, 20, 0.4); border-color: rgba(255, 200, 60, 0.45); }

/* ─── Mode selector ──────────────────────────────────────────────────────── */
.mode-selector {
  display: flex; gap: 6px; margin-bottom: 16px;
}
.mode-btn {
  flex: 1; padding: 8px 6px;
  border: 1px solid rgba(100, 120, 255, 0.15); border-radius: 6px;
  background: rgba(20, 20, 50, 0.5); color: #7080b0;
  font-family: inherit; font-size: 11px; cursor: pointer;
  transition: all 0.15s ease;
}
.mode-btn:hover { background: rgba(40, 40, 80, 0.6); }
.mode-btn.active {
  background: rgba(60, 60, 180, 0.3);
  border-color: rgba(100, 120, 255, 0.4);
  color: #c0d0ff; font-weight: 600;
}

.section-label {
  font-size: 9px; font-weight: 700; letter-spacing: 2px; color: #5560a0;
  margin-bottom: 8px; padding-bottom: 4px;
  border-bottom: 1px solid rgba(100, 120, 255, 0.08);
  display: flex; align-items: center; gap: 6px;
}

.sliders-section { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.slider-group { position: relative; }
.slider-group label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
.slider-label { color: #8890b0; display: flex; align-items: center; gap: 5px; }
.slider-value { color: #a0b0ff; font-weight: 600; }

.help-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0; border-radius: 50%;
  border: 1px solid rgba(100, 120, 255, 0.3);
  background: rgba(60, 60, 140, 0.3); color: #8090ff;
  font-size: 10px; font-weight: 700; font-family: inherit;
  cursor: pointer; transition: all 0.15s ease; flex-shrink: 0;
}
.help-btn:hover {
  background: rgba(80, 80, 200, 0.5); border-color: rgba(100, 120, 255, 0.6);
  color: #c0d0ff; transform: scale(1.15);
}

.tooltip-bubble {
  position: relative; margin-top: 6px; margin-bottom: 8px; padding: 12px 14px;
  background: rgba(20, 18, 50, 0.95);
  border: 1px solid rgba(100, 120, 255, 0.25); border-radius: 8px;
  font-size: 11px; line-height: 1.5; color: #b0b8d8; z-index: 10;
}
.tooltip-bubble::before {
  content: ''; position: absolute; top: -6px; left: 16px;
  width: 10px; height: 10px;
  background: rgba(20, 18, 50, 0.95);
  border-left: 1px solid rgba(100, 120, 255, 0.25);
  border-top: 1px solid rgba(100, 120, 255, 0.25);
  transform: rotate(45deg);
}
.tooltip-bubble strong { display: block; margin-bottom: 6px; font-size: 11px; color: #8898ff; font-weight: 700; }
.tooltip-bubble p { margin: 0; }

.tooltip-enter-active { transition: all 0.2s ease-out; }
.tooltip-leave-active { transition: all 0.15s ease-in; }
.tooltip-enter-from, .tooltip-leave-to { opacity: 0; transform: translateY(-4px); }

/* ─── Options checkboxes ─────────────────────────────────────────────────── */
.options-section {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;
}
.checkbox-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  color: #8890b0; font-size: 11px;
}
.checkbox-row input[type="checkbox"] {
  accent-color: #6070dd; width: 14px; height: 14px; cursor: pointer;
}
.checkbox-row span {
  display: flex; align-items: center; gap: 5px;
}

/* ─── Tracked particle ───────────────────────────────────────────────────── */
.tracked-info {
  padding: 8px 12px; margin-bottom: 12px;
  background: rgba(60, 80, 180, 0.15); border: 1px solid rgba(100, 120, 255, 0.2);
  border-radius: 6px; font-size: 11px; color: #80a0ff;
}
.tracked-info small { color: #5570a0; }
.particle-stats {
  display: flex; gap: 8px; align-items: center; margin-top: 6px;
  padding-top: 6px; border-top: 1px solid rgba(100, 120, 255, 0.1);
  font-size: 10px; color: #90a0cc;
}
.particle-stats .stat { display: inline; flex: none; font-size: 10px; }
.stat-badge {
  padding: 1px 6px; border-radius: 4px; font-size: 9px; font-weight: 700;
  letter-spacing: 0.5px; text-transform: uppercase;
}
.stat-badge.type-star { background: rgba(100, 180, 255, 0.2); color: #80c0ff; }
.stat-badge.type-bh { background: rgba(255, 60, 60, 0.2); color: #ff6060; }
.stat-badge.type-smbh { background: rgba(180, 100, 255, 0.25); color: #c080ff; }

/* ─── Spectral legend ────────────────────────────────────────────────────── */
.spectral-legend {
  margin-top: 8px; padding: 8px 10px;
  background: rgba(15, 15, 40, 0.5); border-radius: 6px;
}
.legend-label { font-size: 9px; color: #5560a0; text-transform: uppercase; letter-spacing: 1px; }
.legend-bar {
  display: flex; justify-content: space-between; margin: 6px 0 4px;
  height: 16px; border-radius: 3px; overflow: hidden;
  background: linear-gradient(to right, #cc3311, #ee7722, #ffdd66, #eeeeff, #6677ff);
}
.legend-bar span {
  flex: 1; text-align: center; font-size: 9px; font-weight: 700;
  line-height: 16px; color: rgba(0,0,0,0.6);
}
.legend-m { background: rgba(204, 51, 17, 0.4); }
.legend-k { background: rgba(238, 119, 34, 0.3); }
.legend-g { background: rgba(255, 221, 102, 0.2); }
.legend-f { background: rgba(200, 200, 255, 0.15); }
.legend-ob { background: rgba(102, 119, 255, 0.3); color: rgba(255,255,255,0.7) !important; }
.legend-desc {
  display: flex; justify-content: space-between;
  font-size: 8px; color: #5560a0;
}

/* ─── Param group (measure cylinder) ─────────────────────────────────────── */
.param-group {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;
}
.slider-row {
  display: flex; align-items: center; gap: 6px;
  transition: opacity 0.2s;
}
.slider-row label { flex: 0 0 80px; font-size: 11px; color: #8890b0; }
.slider-row input[type="range"] {
  flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
  background: rgba(60, 60, 120, 0.4); border-radius: 2px; outline: none;
}
.slider-row input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 12px; height: 12px; border-radius: 50%;
  background: #6070dd; cursor: pointer;
  border: 2px solid #8090ff; transition: transform 0.1s;
}
.slider-row input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.2); }
.slider-row .value { flex: 0 0 44px; text-align: right; font-size: 10px; color: #a0b0ff; font-weight: 600; }
.slider-row.disabled { opacity: 0.35; pointer-events: none; }

/* ─── Slider styles ──────────────────────────────────────────────────────── */
.slider-group input[type="range"] {
  width: 100%; height: 4px; -webkit-appearance: none; appearance: none;
  background: rgba(60, 60, 120, 0.4); border-radius: 2px; outline: none;
}
.slider-group input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%;
  background: #6070dd; cursor: pointer;
  border: 2px solid #8090ff; transition: transform 0.1s;
}
.slider-group input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.2); }

.info-section { padding-top: 12px; border-top: 1px solid rgba(100, 120, 255, 0.1); }
.info-section p { margin: 4px 0; font-size: 10px; color: #5560a0; text-align: center; }
.tech-note { font-style: italic; }
</style>

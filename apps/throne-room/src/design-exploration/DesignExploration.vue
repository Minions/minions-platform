<script setup lang="ts">
/**
 * Design exploration host — the three chosen views.
 * These are moderate-fidelity prototypes with design briefs:
 *   - design-brief-living-cosmos.md
 *   - design-brief-gsd-oracle.md
 *   - design-brief-gsd-river.md
 */
import { ref } from 'vue'
import LivingCosmos from '../components/LivingCosmos.vue'
import GsdOracle from './GsdOracle.vue'
import GsdRiver from './GsdRiver.vue'

const tabs = [
  { id: 'oracle', label: 'GSD — Oracle',       component: GsdOracle  },
  { id: 'cosmos', label: 'Plan — Living Cosmos', component: LivingCosmos },
  { id: 'river',  label: 'Flow — River',         component: GsdRiver  },
]

const activeTab = ref('oracle')
const active = () => tabs.find(t => t.id === activeTab.value) ?? tabs[0]
</script>

<template>
  <div style="display:flex;flex-direction:column;height:100vh;overflow:hidden">
    <div style="display:flex;align-items:center;background:#111827;border-bottom:2px solid #1f2937;flex-shrink:0">
      <button
        v-for="tab in tabs" :key="tab.id"
        @click="activeTab = tab.id"
        :style="{
          padding:'10px 18px', background:'transparent', cursor:'pointer',
          color: activeTab === tab.id ? '#60a5fa' : '#6b7280',
          borderBottom: activeTab === tab.id ? '2px solid #3b82f6' : '2px solid transparent',
          border:'none', fontSize:'11px', fontWeight: activeTab === tab.id ? 700 : 400,
          fontFamily:'system-ui,sans-serif', letterSpacing:'.01em', whiteSpace:'nowrap',
          transition:'color .1s'
        }"
      >{{ tab.label }}</button>
    </div>
    <div style="flex:1;overflow:hidden">
      <component :is="active().component" />
    </div>
  </div>
</template>

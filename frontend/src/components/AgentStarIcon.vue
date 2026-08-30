<script lang="ts">
// Module-scope counter: guarantees a unique gradient id per component instance
// (SVG <defs> ids are document-wide).
let gradCounter = 0;
export default { name: "AgentStarIcon" };
</script>

<script setup lang="ts">
/**
 * AgentStarIcon - hand-drawn SVG star icon for the AI Agent feature.
 *
 * Pure SVG, no emoji / icon font: the star inherits the surrounding color via
 * "currentColor" by default, or can be filled with the brand blue gradient.
 * The optional 4-point sparkle on the top-right gives it an "AI" flavor.
 */
interface Props {
  /** Width & height. A number is used as px; a string ("1em") is also allowed. */
  size?: number | string;
  /** Fill with the brand blue gradient instead of currentColor. */
  gradient?: boolean;
  /** Render a small companion 4-point sparkle at the top-right. */
  sparkle?: boolean;
}

withDefaults(defineProps<Props>(), {
  size: "1em",
  gradient: false,
  sparkle: false
});

const gradId = "agent-star-grad-" + ++gradCounter;
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    class="agent-star-icon"
    aria-hidden="true"
  >
    <defs>
      <linearGradient v-if="gradient" :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1677ff" />
        <stop offset="60%" stop-color="#4096ff" />
        <stop offset="100%" stop-color="#69b1ff" />
      </linearGradient>
    </defs>
    <!-- Five-pointed star with rounded tips (stroked fill mimics a soft join). -->
    <path
      d="M12 3.4 L14.23 9.33 L20.56 9.62 L15.61 13.57 L17.29 19.68 L12 16.2 L6.71 19.68 L8.39 13.57 L3.44 9.62 L9.77 9.33 Z"
      :fill="gradient ? 'url(#' + gradId + ')' : 'currentColor'"
      :stroke="gradient ? 'url(#' + gradId + ')' : 'currentColor'"
      stroke-width="1.8"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- Companion 4-point sparkle (optional, for large badges). -->
    <path
      v-if="sparkle"
      d="M20.4 1.6 C20.62 2.75 21.25 3.38 22.4 3.6 C21.25 3.82 20.62 4.45 20.4 5.6 C20.18 4.45 19.55 3.82 18.4 3.6 C19.55 3.38 20.18 2.75 20.4 1.6 Z"
      :fill="gradient ? 'url(#' + gradId + ')' : 'currentColor'"
      opacity="0.9"
    />
  </svg>
</template>

<style scoped>
.agent-star-icon {
  display: inline-block;
  vertical-align: -0.125em;
  flex-shrink: 0;
}
</style>

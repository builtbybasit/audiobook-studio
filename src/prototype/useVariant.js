// PROTOTYPE — throwaway. Reads ?variant= from the URL so screens with several
// structural variants can be flipped from the floating switcher.
import { computed } from 'vue'
import { useRoute } from 'vue-router'

export function useVariant(variants) {
  const route = useRoute()
  const current = computed(() => {
    const key = route.query.variant ?? variants[0].key
    return variants.find(v => v.key === key) ?? variants[0]
  })
  return { current }
}

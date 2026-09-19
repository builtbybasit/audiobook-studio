import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import { router } from "@/router";
import { useReader, saveReader } from "@/stores/reader";
import { useDemoStore } from "@/stores/demo";
import { useJobsStore } from "@/stores/jobs";
import { keyring } from "@/lib/keyring";
import { activeLibraryService } from "@/services/library";
import { SEEDED_KEYS } from "@/mock";
import "@/style.css";
import "@/toasts.css";
import { createToastflow } from "vue-toastflow";

const pinia = createPinia();
// Toastflow runtime only — `{ css: false }` skips its stylesheet; the card is ours (components/Toasts.vue)
const toastflow = createToastflow(
  {
    position: "bottom-right",
    offset: "16px",
    gap: "10px",
    width: "380px",
    duration: 6000,
    pauseOnHover: true,
    pauseStrategy: "resume",
    progressBar: true,
    maxVisible: 4,
    queue: true,
    order: "newest",
    preventDuplicates: true,
    closeButton: true,
    closeOnClick: false,
    swipeToDismiss: true,
  },
  { css: false },
);
createApp(App).use(pinia).use(router).use(toastflow).mount("#app");
useReader(pinia).$subscribe((_, state) => saveReader(state));
// PROTOTYPE: the demo's own credentials live in the keyring, never in the store, and a demo reset
// puts them back — nothing here is sent anywhere.
for (const [id, value] of SEEDED_KEYS) keyring.set(id, value);
if (activeLibraryService()) {
  // With a server answering, the queue is the server's: read it, and keep reading while it moves.
  const jobsStore = useJobsStore(pinia);
  void jobsStore.load().then(() => jobsStore.startPolling());
} else {
  // PROTOTYPE: start a few simulated jobs so the queue is alive on load. Demo only: with a server
  // answering, the library is the server's and there are no seeded books for these to run on.
  useDemoStore(pinia).demoKick();
}

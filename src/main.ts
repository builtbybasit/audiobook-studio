import { createApp } from "vue";
import { createPinia } from "pinia";
import { PiniaColada } from "@pinia/colada";
import { PiniaColadaAutoRefetch } from "@pinia/colada-plugin-auto-refetch";
import App from "@/App.vue";
import { router } from "@/router";
import { useDemoStore } from "@/stores/demo";
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
createApp(App)
  .use(pinia)
  // Reads are queries (`src/queries/`): the plugin holds their cache, in a store of its own on
  // this pinia. Nothing is re-read on focus or reconnect — what changes a script, a cast or the
  // queue in this app is a request this app made, and each one invalidates what it changed. The
  // queue is the one thing that moves on its own, and it polls (auto-refetch) while a job is live.
  .use(PiniaColada, {
    plugins: [PiniaColadaAutoRefetch()],
    queryOptions: { refetchOnWindowFocus: false, refetchOnReconnect: false },
  })
  .use(router)
  .use(toastflow)
  .mount("#app");
// PROTOTYPE: the demo's own credentials live in the keyring, never in the store, and a demo reset
// puts them back — nothing here is sent anywhere.
for (const [id, value] of SEEDED_KEYS) keyring.set(id, value);
// With a server answering, the queue is the server's and the shell reads it (`useBookJobs`).
// PROTOTYPE: in the demo, start a few simulated jobs so the queue is alive on load — there are no
// seeded books for these to run on in a real library.
if (!activeLibraryService()) useDemoStore(pinia).demoKick();

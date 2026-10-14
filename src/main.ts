import { createApp } from "vue";
import { createPinia } from "pinia";
import { PiniaColada } from "@pinia/colada";
import { PiniaColadaAutoRefetch } from "@pinia/colada-plugin-auto-refetch";
import App from "@/App.vue";
import { router } from "@/router";
import "@/style.css";
import "@/toasts.css";
import { createToastflow } from "vue-toastflow";

const pinia = createPinia();
// Toastflow runtime only: `{ css: false }` skips its stylesheet; the card is components/Toasts.vue
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
  // Query cache for `src/queries/`. No refetch on focus or reconnect: every change is a request
  // this app made, which invalidates what it changed. Only the queue moves alone, and it polls.
  .use(PiniaColada, {
    plugins: [PiniaColadaAutoRefetch()],
    queryOptions: { refetchOnWindowFocus: false, refetchOnReconnect: false },
  })
  .use(router)
  .use(toastflow)
  .mount("#app");

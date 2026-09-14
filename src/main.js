import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { useReader, saveReader } from "./stores/reader";
import { useApp } from "./stores/app";
import { keyring } from "./lib/keyring";
import "./style.css";
import "./toasts.css";
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
keyring.set("openai", "sk-prototype-demo-key-4f2a");
keyring.set("profile:openai", "sk-prototype-demo-key-4f2a");
keyring.set("profile:deepseek", "ds-prototype-91cd"); // PROTOTYPE: seeded key lives in the keyring, never in the store
useApp(pinia).demoKick(); // PROTOTYPE: start a few simulated jobs so the queue is alive on load

<script setup lang="ts">
// PROTOTYPE — throwaway. The reading column variant A kept: the chapter's spoken lines, a flag on
// hover and on the line playing, a line without audio dimmed, a line heard wrong marked. The
// variants built on A share it and differ in the player around it.
import ListenLine from "@/views/listen/ListenLine.vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import { useReader } from "@/stores/reader";
import { protoFlags, protoLoop, type ListenCtx } from "@/views/listen/prototype/ctx";

defineProps<{ ctx: ListenCtx; title?: boolean }>();
const flagOpen = defineModel<number | null>("flagOpen", { default: null });
const reader = useReader();
</script>

<template>
  <div class="px-4 py-6 sm:px-8">
    <div
      class="mx-auto"
      :class="[reader.widthClass, reader.fontClass]"
      :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
    >
      <h2 v-if="ctx.chapter && title !== false" class="mb-5 font-serif text-2xl">
        {{ ctx.chapter.title }}
      </h2>
      <p v-if="!ctx.loaded" class="py-10 text-center font-sans text-sm text-zinc-500">
        Reading the script…
      </p>
      <p v-else-if="!ctx.narrated" class="py-10 text-center font-sans text-sm text-zinc-500">
        No narrated lines yet.
      </p>
      <template v-else>
        <div
          v-for="s in ctx.rows"
          :key="s.id"
          data-line
          class="relative"
          :class="[
            s.audio.status !== 'done' && s.audio.status !== 'stale' && 'opacity-40',
            protoLoop === s.id && 'ring-1 ring-violet-400 rounded-md',
          ]"
        >
          <ListenLine
            :segment="s"
            :marks="ctx.marks.get(s.id) ?? null"
            :on="ctx.current === s.id"
            :word="ctx.current === s.id ? ctx.word : -1"
            :color="ctx.colorOf(s.speaker)"
            @seek="(at) => ctx.listenFrom(s, at)"
          />
          <div
            class="line-tool absolute -right-9 top-1 font-sans"
            :class="(ctx.current === s.id || protoFlags.has(s.id)) && 'is-on'"
          >
            <ProtoFlag
              :segment="s"
              :open="flagOpen === s.id"
              @update:open="(v) => (flagOpen = v ? s.id : null)"
            />
          </div>
          <span
            v-if="ctx.heard[s.id]?.mismatch"
            class="absolute -left-9 top-2 font-sans text-[10px] text-red-500"
            :title="`heard: ${ctx.heard[s.id].heard}`"
            >heard?</span
          >
        </div>
      </template>
    </div>
  </div>
</template>

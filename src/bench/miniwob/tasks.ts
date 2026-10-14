// BrowserGym's MiniWoB++ benchmark: its 125 tasks, 5 seeds each (625 episodes),
// derived the way BrowserGym derives them. Only the task names and BrowserGym's
// own labels are listed here; MiniWoB++'s pages are fetched at run time.
// Source: browsergym/experiments/.../benchmark/metadata/miniwob.csv at the
// pinned commit (Apache-2.0).
export const BROWSERGYM_REPO = "https://github.com/ServiceNow/BrowserGym.git";
export const BROWSERGYM_COMMIT = "e71419aef5759a11cb7896a26c36e5f7e92d82b2";

/** `task/category/split`, in BrowserGym's order; the order sets the seeds. */
const LIST = [
  "ascending-numbers/hidden-test/test", "bisect-angle/original/test", "book-flight/original/train", "book-flight-nodelay/nodelay/train",
  "buy-ticket/hidden-test/train", "choose-date/original/train", "choose-date-easy/debug/train", "choose-date-medium/debug/train",
  "choose-date-nodelay/nodelay/train", "choose-list/original/test", "circle-center/original/train", "click-button/original/test",
  "click-button-sequence/original/test", "click-checkboxes/original/train", "click-checkboxes-large/additional/train", "click-checkboxes-soft/additional/train",
  "click-checkboxes-transfer/additional/train", "click-collapsible/original/train", "click-collapsible-2/original/train", "click-collapsible-2-nodelay/nodelay/train",
  "click-collapsible-nodelay/nodelay/train", "click-color/original/test", "click-dialog/original/train", "click-dialog-2/original/train",
  "click-link/original/test", "click-menu/original/test", "click-menu-2/original/test", "click-option/original/train",
  "click-pie/original/test", "click-pie-nodelay/nodelay/test", "click-scroll-list/original/test", "click-shades/original/train",
  "click-shape/original/test", "click-tab/original/test", "click-tab-2/original/test", "click-tab-2-easy/debug/test",
  "click-tab-2-hard/additional/test", "click-tab-2-medium/debug/test", "click-test/original/test", "click-test-2/original/train",
  "click-test-transfer/debug/train", "click-widget/original/test", "copy-paste/original/test", "copy-paste-2/original/test",
  "count-shape/original/train", "count-sides/original/test", "daily-calendar/hidden-test/train", "drag-box/original/train",
  "drag-circle/original/test", "drag-cube/original/test", "drag-items/original/train", "drag-items-grid/original/test",
  "drag-shapes/original/train", "drag-shapes-2/hidden-test/train", "drag-single-shape/hidden-test/train", "drag-sort-numbers/original/train",
  "draw-circle/hidden-test/train", "draw-line/hidden-test/train", "email-inbox/original/test", "email-inbox-delete/debug/test",
  "email-inbox-forward/debug/test", "email-inbox-forward-nl/additional/test", "email-inbox-forward-nl-turk/additional/test", "email-inbox-important/debug/test",
  "email-inbox-nl-turk/additional/test", "email-inbox-noscroll/debug/test", "email-inbox-reply/debug/test", "email-inbox-star-reply/debug/test",
  "enter-date/original/train", "enter-password/original/train", "enter-text/original/train", "enter-text-2/original/train",
  "enter-text-dynamic/original/train", "enter-time/original/train", "find-greatest/hidden-test/test", "find-midpoint/original/train",
  "find-word/original/test", "focus-text/original/train", "focus-text-2/original/train", "form-sequence/hidden-test/train",
  "form-sequence-2/hidden-test/test", "form-sequence-3/hidden-test/test", "generate-number/hidden-test/test", "grid-coordinate/original/test",
  "guess-number/original/test", "highlight-text/original/test", "highlight-text-2/original/test", "hot-cold/hidden-test/test",
  "identify-shape/original/train", "login-user/original/train", "login-user-popup/additional/train", "multi-layouts/additional/train",
  "multi-orderings/additional/train", "navigate-tree/original/train", "number-checkboxes/original/test", "odd-or-even/hidden-test/train",
  "order-food/hidden-test/test", "phone-book/hidden-test/test", "read-table/original/train", "read-table-2/original/train",
  "resize-textarea/original/test", "right-angle/original/test", "scroll-text/original/test", "scroll-text-2/original/test",
  "search-engine/original/train", "sign-agreement/hidden-test/test", "simple-algebra/original/test", "simple-arithmetic/original/test",
  "social-media/original/test", "social-media-all/additional/test", "social-media-some/additional/test", "stock-market/hidden-test/test",
  "terminal/original/test", "text-editor/original/train", "text-transform/original/train", "tic-tac-toe/original/test",
  "unicode-test/debug/train", "use-autocomplete/original/train", "use-autocomplete-nodelay/nodelay/train", "use-colorwheel/original/train",
  "use-colorwheel-2/original/train", "use-slider/original/train", "use-slider-2/original/train", "use-spinner/original/test",
  "visual-addition/original/train",
];

export const MINIWOB_TASKS = LIST.map((row) => {
  const [id = "", category = "", split = ""] = row.split("/");
  return { id, category, split };
});

/** numpy's RandomState (MT19937, legacy seeding): the two calls BrowserGym makes. */
export function randomState(seed: number) {
  const mt = new Uint32Array(624);
  let index = 624;
  mt[0] = seed >>> 0;
  for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
  const next = () => {
    if (index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = mt[index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    return (y ^ (y >>> 18)) >>> 0;
  };
  return {
    /** randint(0, high) for a high up to 2^32: masked rejection, as numpy does. */
    randint(high: number) {
      const range = high - 1;
      if (range === 0) return 0;
      const mask = 2 ** Math.ceil(Math.log2(range + 1)) - 1;
      for (;;) {
        const value = (next() & mask) >>> 0;
        if (value <= range) return value;
      }
    },
  };
}

/** BrowserGym's SEED_MAX is `2 ^ 32`, which Python reads as XOR: 34. */
const SEED_MAX = 2 ^ 32;
const SEEDS_PER_TASK = 5;

/** The 625 episodes: BrowserGym's task seeds from RandomState(42), and the seed the page gets from each. */
export const MINIWOB_EPISODES = (() => {
  const rng = randomState(42);
  return MINIWOB_TASKS.flatMap((task) =>
    Array.from({ length: SEEDS_PER_TASK }, (_, k) => {
      const taskSeed = rng.randint(SEED_MAX);
      return { id: `${task.id}#${k}`, task: task.id, taskSeed, seed: randomState(taskSeed).randint(1_000_000) };
    }),
  );
})();

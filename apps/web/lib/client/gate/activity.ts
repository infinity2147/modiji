/**
 * Gate activity sensing in the CaseDesk work area (disclosed in the UI; timing only, nothing recorded):
 * keystrokes → `typing`; scrolling and visible DOM changes → `screen_motion`. Real screen motion from
 * the perception channel joins later; until then the work area's own DOM is the screen.
 *
 * Elements marked `data-gate-ignore` (the voice transcript, the judge view) are not the expert's
 * screen work and never count as motion.
 */
export type ActivitySink = { typing: () => void; screenMotion: () => void };

const GATE_IGNORE_ATTRIBUTE = "data-gate-ignore";

function ignored(node: Node | null): boolean {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(`[${GATE_IGNORE_ATTRIBUTE}]`) != null;
}

/** Attaches the sensors to `root`; returns the detach function. */
export function attachActivitySensors(root: HTMLElement, sink: ActivitySink): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!ignored(event.target instanceof Node ? event.target : null)) sink.typing();
  };
  const onScroll = (event: Event): void => {
    if (!ignored(event.target instanceof Node ? event.target : null)) sink.screenMotion();
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !ignored(record.target))) sink.screenMotion();
  });
  root.addEventListener("keydown", onKeyDown, { capture: true });
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  // Content changes only: attribute churn (focus rings, hover styles, animations) is not the screen moving.
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    root.removeEventListener("keydown", onKeyDown, { capture: true });
    root.removeEventListener("scroll", onScroll, { capture: true });
    observer.disconnect();
  };
}

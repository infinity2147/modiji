/**
 * Gate activity sensing (disclosed in the UI; timing only, nothing recorded): keystrokes anywhere in the
 * CaseDesk window → `typing` (live bug #11: an expert typing with nothing focused, or outside the case
 * area, is still typing); scrolling and visible DOM changes in the work area → `screen_motion`. Real
 * screen motion from the perception channel joins later; until then the work area's own DOM is the screen.
 *
 * Elements marked `data-gate-ignore` (the voice panel and its controls, the screen-capture card, the
 * judge view) are not the expert's work: keystrokes, scrolling and changes there never count.
 */
export type ActivitySink = { typing: () => void; screenMotion: () => void };

const GATE_IGNORE_ATTRIBUTE = "data-gate-ignore";

function ignored(node: Node | null): boolean {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(`[${GATE_IGNORE_ATTRIBUTE}]`) != null;
}

/** Attaches the sensors: keystrokes on `root`'s whole document, motion in `root`. Returns the detach function. */
export function attachActivitySensors(root: HTMLElement, sink: ActivitySink): () => void {
  const doc = root.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!ignored(event.target instanceof Node ? event.target : null)) sink.typing();
  };
  const onScroll = (event: Event): void => {
    if (!ignored(event.target instanceof Node ? event.target : null)) sink.screenMotion();
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !ignored(record.target))) sink.screenMotion();
  });
  doc.addEventListener("keydown", onKeyDown, { capture: true });
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  // Content changes only: attribute churn (focus rings, hover styles, animations) is not the screen moving.
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    doc.removeEventListener("keydown", onKeyDown, { capture: true });
    root.removeEventListener("scroll", onScroll, { capture: true });
    observer.disconnect();
  };
}

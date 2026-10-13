// Full screen through the Fullscreen API (with Safari's webkit prefix). iPhones
// have no Fullscreen API for pages; there, Add to Home Screen opens the game
// full screen through the web app manifest.

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

const doc = document as WebkitDocument;

export function fullscreenSupported(): boolean {
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

export function toggleFullscreen(): void {
  const el = document.documentElement as WebkitElement;
  const done = isFullscreen()
    ? (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)
    : (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
  // Browsers refuse without a user gesture; nothing to do then.
  void done?.catch(() => {});
}

export function onFullscreenChange(fn: () => void): void {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
}

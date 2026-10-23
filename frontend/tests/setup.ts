/**
 * Vitest setup: fill jsdom gaps for browser APIs the components call.
 * jsdom does no layout, so `scrollIntoView` (used by RowActionsMenu to
 * bring an opened menu on screen) is absent; a no-op stands in.
 */
Element.prototype.scrollIntoView = () => {};

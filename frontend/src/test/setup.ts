import '@testing-library/jest-dom/vitest';

// jsdom does not implement matchMedia. ThemeContext calls it unconditionally
// (to resolve the 'system' preference), so anything that mounts ThemeProvider
// needs this stub in place before the first render.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined, // deprecated, still called by some libs
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

// jsdom does not implement the Blob URL registry either. lib/export.ts uses
// both to turn a downloaded response into an <a download> click.
if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => 'blob:mock-url';
}
if (!window.URL.revokeObjectURL) {
  window.URL.revokeObjectURL = () => undefined;
}

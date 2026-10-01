// Applies theme / font settings to the document.

import { settings } from './settings.js';

export function applyAppearance() {
  const s = settings();
  const root = document.documentElement;
  if (s.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
  root.style.setProperty('--note-size', `${s.fontSize || 17}px`);
  root.dataset.font = s.fontFamily || 'system';
  const dark = s.theme === 'dark' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1c1b19' : '#f7f4ee');
}

const LS_KEY = 'lore_theme'; // 'dark' | 'light' | 'system'

function _apply(t) {
  if (t === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

export function getTheme() {
  return localStorage.getItem(LS_KEY) || 'system';
}

export function setTheme(t) {
  localStorage.setItem(LS_KEY, t);
  _apply(t);
}

export function initTheme() {
  _apply(getTheme());
}
